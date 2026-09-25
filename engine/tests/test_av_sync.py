"""Measure decoded flash/beep timing, not just matching container durations.

No network or transcription API is used. Fixtures carry synchronized content
with late audio, sparse video, timestamp gaps and non-frame-aligned edits.
"""

import asyncio
import json
import os
import shutil
import subprocess
from fractions import Fraction

import numpy as np
import pytest

from clip_engine.services.layout_analyzer import ClipLayoutPlan, LayoutType, ShotLayout
from clip_engine.services.layout_renderer import build_layout_graph
from clip_engine.services.rendering_service import RenderingService
from clip_engine.services.transcription_service import TranscriptionService


FFMPEG = os.environ.get("TEST_FFMPEG") or shutil.which("ffmpeg")
FFPROBE = os.environ.get("TEST_FFPROBE") or shutil.which("ffprobe")
pytestmark = pytest.mark.skipif(not (FFMPEG and FFPROBE), reason="FFmpeg and FFprobe required")


@pytest.fixture(autouse=True)
def media_path(monkeypatch):
    # Production helpers use PATH. Exercise the selected release binary too.
    monkeypatch.setenv("PATH", os.path.dirname(FFMPEG) + os.pathsep + os.environ.get("PATH", ""))


def run(*args):
    result = subprocess.run([str(a) for a in args], capture_output=True, timeout=90)
    assert result.returncode == 0, result.stderr.decode(errors="replace")[-4000:]
    return result.stdout


def source(tmp_path, *, rate="30", duration=12, audio_delay=0, video_delay=0,
           sparse=False, audio_gap=False, sample_rate=48000, origin=0, audio_end=None):
    # A white flash and a 1 kHz beep at .5 seconds of each second.
    path = tmp_path / "source.mkv"
    video = "drawbox=color=white:t=fill:enable='between(mod(t,1),0.5,0.7)'"
    if sparse:
        video += ",select='if(lt(t,6),1,not(mod(n,3)))'"
    if video_delay:
        video += f",trim=start={video_delay}"
    audio = f"atrim=start={audio_delay}"
    if audio_end is not None:
        audio += f":end={audio_end}"
    if audio_gap:
        audio += ",aselect='not(between(t,3,3.5))'"
    run(FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i",
        f"color=black:s=64x64:r={rate}:d={duration}", "-f", "lavfi", "-i",
        f"aevalsrc=0.6*sin(2*PI*1000*t)*between(mod(t\\,1)\\,0.5\\,0.7):s={sample_rate}:d={duration}",
        "-filter_complex", f"[0:v]{video}[v];[1:a]{audio}[a]",
        "-map", "[v]", "-map", "[a]", "-c:v", "ffv1", "-c:a", "pcm_s16le",
        "-output_ts_offset", origin, path)
    return path


def probe(path):
    return json.loads(run(FFPROBE, "-v", "error", "-show_streams", "-show_format", "-of", "json", path))


def onsets(active, rate):
    starts = np.flatnonzero(active & ~np.r_[False, active[:-1]])
    return starts / rate


def events(path):
    streams = probe(path)["streams"]
    video = next(s for s in streams if s["codec_type"] == "video")
    audio = next(s for s in streams if s["codec_type"] == "audio")
    frames = np.frombuffer(run(FFMPEG, "-v", "error", "-i", path, "-map", "0:v:0",
                              "-vf", "scale=8:8", "-pix_fmt", "gray", "-f", "rawvideo", "-"), np.uint8)
    samples = np.frombuffer(run(FFMPEG, "-v", "error", "-i", path, "-map", "0:a:0",
                               # Materialize presentation gaps before measuring
                               # speech; raw samples alone conceal late packets.
                               "-af", "aresample=48000:async=1:first_pts=0:min_hard_comp=0.001",
                               "-ac", "1", "-ar", "48000", "-f", "f32le", "-"), np.float32)
    # 5 ms RMS windows suppress individual zero crossings and AAC ringing.
    rms = np.sqrt(np.mean(samples[:len(samples) // 240 * 240].reshape(-1, 240) ** 2, axis=1))
    flashes = onsets(frames.reshape(-1, 64).mean(axis=1) > 150, float(Fraction(video["avg_frame_rate"])))
    beeps = onsets(rms > max(0.02, float(rms.max()) * 0.2), 200)
    return flashes + float(video.get("start_time", 0)), beeps + float(audio.get("start_time", 0))


def render(path, tmp_path, *, duration=12, start=0, keeps=None, shots=None, fps="30", audio=True,
           encoder=None, overlay=False):
    service = RenderingService.__new__(RenderingService)
    # FFV1 source + MPEG-4 output run on both the LGPL bundle and local builds.
    service._video_codec_args = lambda *args: encoder or ["-c:v", "mpeg4", "-q:v", "2", "-bf", "2"]
    plan = ClipLayoutPlan(shots or [ShotLayout(0, duration * 1000, LayoutType.TALKING_HEAD)], 64, 64)
    graph = build_layout_graph(plan, 64, 64, keeps, with_audio=audio, fps=fps)
    extra_inputs = None
    if overlay:
        from PIL import Image
        image = tmp_path / "overlay.png"
        Image.new("RGBA", (2, 2), (255, 255, 255, 255)).save(image)
        graph += ";[base][1:v]overlay=shortest=1[out]"
        extra_inputs = [str(image)]
    else:
        graph += ";[base]null[out]"
    out = tmp_path / "render.mp4"
    asyncio.run(service._run_ffmpeg_complex(
        str(path), str(out), round(start * 1000), round(duration * 1000), graph,
        audio_label="[aout]" if audio else None, fps=fps, output_size=(64, 64), extra_inputs=extra_inputs,
        output_duration_ms=sum(e - s for s, e in keeps) if keeps is not None else round(duration * 1000),
    ))
    return out


@pytest.mark.parametrize("options", [
    {"audio_delay": 0.3}, {"video_delay": 0.3}, {"audio_gap": True},
    {"sparse": True}, {"rate": "24000/1001", "sample_rate": 44100},
    {"origin": 7, "audio_delay": 0.3},
])
def test_content_stays_synchronized(tmp_path, options):
    path = source(tmp_path, **options)
    out = render(path, tmp_path)
    flashes, beeps = events(out)
    assert len(flashes) == len(beeps) == 12, (flashes, beeps)
    # Sparse source frames limit visual precision to 100 ms; all other
    # fixtures should agree within one output frame + one RMS bucket.
    tolerance = 0.105 if options.get("sparse") else 1 / 30 + 0.006
    assert np.max(np.abs(flashes - beeps)) <= tolerance, (flashes, beeps)


@pytest.mark.parametrize("fps", ["24", "25", "30", "30000/1001", "60", "60000/1001"])
def test_many_shots_do_not_shift_the_edit_timeline(tmp_path, fps):
    path = source(tmp_path, rate=fps, duration=20)
    # 40 off-grid framing changes used to lengthen the concatenated timeline.
    boundaries = [0, *range(413, 20000, 487), 20000]
    shots = [ShotLayout(a, b, LayoutType.TALKING_HEAD) for a, b in zip(boundaries, boundaries[1:])]
    out = render(path, tmp_path, duration=20, shots=shots, fps=fps)
    flashes, beeps = events(out)
    expected = np.arange(20) + 0.5
    assert len(flashes) == len(beeps) == len(expected)
    tolerance = 1 / float(Fraction(fps)) + 0.006
    assert np.max(np.abs(flashes - beeps)) <= tolerance
    assert np.max(np.abs(beeps - expected)) <= 0.012, beeps
    assert np.max(np.abs(flashes - expected)) <= tolerance, flashes
    assert float(probe(out)["format"]["duration"]) == pytest.approx(20, abs=tolerance)


def test_transcription_preserves_delayed_audio_timeline(tmp_path):
    path = source(tmp_path, audio_delay=0.3)
    service = TranscriptionService.__new__(TranscriptionService)
    out = tmp_path / "transcription.wav"
    asyncio.run(service._extract_audio_from_video(str(path), str(out)))
    samples = np.frombuffer(run(FFMPEG, "-v", "error", "-i", out, "-ac", "1", "-ar", "16000",
                               "-f", "f32le", "-"), np.float32)
    first_beep = np.flatnonzero(np.abs(samples) > 0.1)[0] / 16000
    assert first_beep == pytest.approx(0.5, abs=0.015)


@pytest.mark.parametrize("start", [1.137, 5.999])
def test_transcription_chunk_seek_preserves_timing(tmp_path, start):
    path = source(tmp_path, audio_delay=0.3)
    service = TranscriptionService.__new__(TranscriptionService)
    extracted = tmp_path / "transcription.wav"
    chunk = tmp_path / "chunk.wav"
    asyncio.run(service._extract_audio_from_video(str(path), str(extracted)))
    service._extract_chunk(str(extracted), str(chunk), start, 3)
    samples = np.frombuffer(run(FFMPEG, "-v", "error", "-i", chunk, "-ac", "1", "-ar", "16000",
                               "-f", "f32le", "-"), np.float32)
    first_beep = np.flatnonzero(np.abs(samples) > 0.1)[0] / 16000
    expected = (int(start) + 0.5 - start) % 1
    assert first_beep == pytest.approx(expected, abs=0.015)


def test_transcription_range_extracts_only_the_window_on_the_source_clock(tmp_path):
    path = source(tmp_path, duration=20)
    service = TranscriptionService.__new__(TranscriptionService)
    out = tmp_path / "transcription.wav"
    asyncio.run(service._extract_audio_from_video(str(path), str(out), 7.0, 11.0))
    samples = np.frombuffer(run(FFMPEG, "-v", "error", "-i", out, "-ac", "1", "-ar", "16000",
                               "-f", "f32le", "-"), np.float32)
    assert len(samples) / 16000 == pytest.approx(4.0, abs=0.05)
    loud = np.flatnonzero(np.abs(samples) > 0.1) / 16000
    # Beeps at 7.5, 8.5, 9.5 and 10.5 of the source land at 0.5, 1.5, 2.5 and 3.5 of the window.
    assert loud[0] == pytest.approx(0.5, abs=0.015)
    assert loud[-1] == pytest.approx(3.7, abs=0.015)


@pytest.mark.parametrize("fps", ["24", "25", "30", "30000/1001", "60", "60000/1001"])
def test_many_cuts_and_seek_share_caption_timeline(tmp_path, fps):
    path = source(tmp_path, rate=fps, duration=24, audio_delay=0.3)
    source_flashes, source_beeps = events(path)
    start = 1.137
    # Every beep survives, while 23 non-frame-aligned gaps are removed.
    keeps = [(i * 1000 + 101, i * 1000 + 731) for i in range(22)]
    shots = [ShotLayout(0, 11113, LayoutType.TALKING_HEAD), ShotLayout(11113, 22000, LayoutType.TALKING_HEAD)]
    out = render(path, tmp_path, duration=22, start=start, keeps=keeps, shots=shots, fps=fps, overlay=True)
    flashes, beeps = events(out)
    expected = np.arange(22) * 0.630 + (0.5 - 0.137 - 0.101)
    tolerance = 1 / float(Fraction(fps)) + 0.006
    assert len(flashes) == len(beeps) == len(expected), (flashes, beeps)
    # Compare with the actual source frame, not an ideal continuous flash:
    # at 25 fps a .500-second event is first visible at .520 seconds.
    mapped_flashes = source_flashes[1:23] - (np.arange(22) + 1 + 0.137 + 0.101) + np.arange(22) * 0.630
    assert np.max(np.abs(flashes - mapped_flashes)) <= tolerance, (flashes, mapped_flashes)
    source_quantization = np.max(np.abs(source_flashes - source_beeps))
    assert np.max(np.abs(flashes - beeps)) <= source_quantization + tolerance, (flashes, beeps)
    assert np.max(np.abs(beeps - expected)) <= 0.012, beeps
    assert float(probe(out)["format"]["duration"]) == pytest.approx(13.860, abs=tolerance)


@pytest.mark.parametrize("audio_delay,audio_end,expected_count", [(3, 8, 5), (8, None, 4)])
def test_missing_audio_at_edges_is_silence(tmp_path, audio_delay, audio_end, expected_count):
    path = source(tmp_path, audio_delay=audio_delay, audio_end=audio_end)
    out = render(path, tmp_path)
    flashes, beeps = events(out)
    assert len(flashes) == 12
    assert len(beeps) == expected_count
    assert np.max(np.abs(beeps - (np.arange(expected_count) + audio_delay + 0.5))) <= 0.012
    streams = probe(out)["streams"]
    assert all(float(s["duration"]) == pytest.approx(12, abs=0.04) for s in streams)


def test_window_before_first_audio_packet_renders_silence(tmp_path):
    path = source(tmp_path, audio_delay=8)
    out = render(path, tmp_path, duration=2)
    flashes, beeps = events(out)
    assert len(flashes) == 2
    assert len(beeps) == 0


def test_video_only_preserves_duration_across_off_grid_shots(tmp_path):
    path = source(tmp_path, rate="24000/1001")
    shots = [ShotLayout(a, b, LayoutType.TALKING_HEAD) for a, b in zip([0, 413, 1477], [413, 1477, 12000])]
    out = render(path, tmp_path, shots=shots, audio=False)
    data = probe(out)
    assert [s["codec_type"] for s in data["streams"]] == ["video"]
    assert float(data["format"]["duration"]) == pytest.approx(12, abs=0.034)


@pytest.mark.parametrize("encoder_name", ["libx264", "h264_videotoolbox"])
def test_h264_aac_encoder_delay_does_not_move_presentation_start(tmp_path, encoder_name):
    encoders = run(FFMPEG, "-hide_banner", "-encoders").decode()
    if encoder_name not in encoders:
        pytest.skip(f"{encoder_name} is unavailable")
    encoder = ["-c:v", encoder_name]
    encoder += ["-preset", "ultrafast"] if encoder_name == "libx264" else ["-b:v", "1M"]
    path = source(tmp_path, audio_delay=0.3)
    out = render(path, tmp_path, encoder=encoder, start=1.137, duration=8)
    flashes, beeps = events(out)
    assert len(flashes) == len(beeps) == 8
    assert np.max(np.abs(flashes - beeps)) <= 1 / 30 + 0.006
    assert all(abs(float(s["start_time"])) <= 0.001 for s in probe(out)["streams"])


def test_transcription_and_render_use_same_audio_track(tmp_path):
    path = source(tmp_path)
    multi = tmp_path / "multi.mkv"
    run(FFMPEG, "-v", "error", "-y", "-i", path, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=12",
        "-map", "0:v:0", "-map", "0:a:0", "-map", "1:a:0", "-c", "copy",
        "-disposition:a:0", "0", "-disposition:a:1", "default", multi)
    service = TranscriptionService.__new__(TranscriptionService)
    extracted = tmp_path / "transcription.wav"
    asyncio.run(service._extract_audio_from_video(str(multi), str(extracted)))
    samples = np.frombuffer(run(FFMPEG, "-v", "error", "-i", extracted, "-f", "f32le", "-"), np.float32)
    assert float(np.max(np.abs(samples))) > 0.1  # The default second track is silent.
    flashes, beeps = events(render(multi, tmp_path))
    assert len(flashes) == len(beeps) == 12


def test_stereo_channels_are_not_collapsed_by_audio_polish(tmp_path):
    path = source(tmp_path)
    stereo = tmp_path / "stereo.mkv"
    run(FFMPEG, "-v", "error", "-y", "-i", path, "-map", "0:v", "-map", "0:a",
        "-c:v", "copy", "-af", "pan=stereo|c0=c0|c1=0*c0", "-c:a", "pcm_s16le", stereo)
    out = render(stereo, tmp_path)
    samples = np.frombuffer(run(FFMPEG, "-v", "error", "-i", out, "-map", "0:a:0",
                               "-f", "f32le", "-"), np.float32).reshape(-1, 2)
    assert np.max(np.abs(samples[:, 0])) > 0.1
    assert np.max(np.abs(samples[:, 1])) < 0.001


@pytest.mark.parametrize("origin", [0, 7])
def test_aac_source_priming_and_seek_preserve_content_clock(tmp_path, origin):
    path = source(tmp_path, audio_delay=0.3)
    compressed = tmp_path / "aac.mkv"
    run(FFMPEG, "-v", "error", "-y", "-i", path, "-c:v", "copy", "-c:a", "aac",
        "-b:a", "192k", "-output_ts_offset", origin, compressed)
    flashes, beeps = events(render(compressed, tmp_path, start=1.137, duration=8))
    assert len(flashes) == len(beeps) == 8
    assert np.max(np.abs(flashes - beeps)) <= 1 / 30 + 0.006
    assert np.max(np.abs(beeps - (np.arange(8) + 0.363))) <= 0.012


def test_three_minute_edit_does_not_accumulate_drift(tmp_path):
    path = source(tmp_path, duration=182, rate="30000/1001", sample_rate=44100)
    keeps = [(i * 1000 + 117, i * 1000 + 827) for i in range(180)]
    out = render(path, tmp_path, duration=180, keeps=keeps, fps="30000/1001")
    flashes, beeps = events(out)
    expected = np.arange(180) * 0.710 + 0.383
    assert len(flashes) == len(beeps) == 180
    assert np.max(np.abs(beeps - expected)) <= 0.012
    # Source frame sampling plus output frame rounding; neither grows with
    # the 180 cuts. Check the last event as strictly as the first.
    assert np.max(np.abs(flashes - expected)) <= 2 / (30000 / 1001) + 0.006
    assert float(probe(out)["format"]["duration"]) == pytest.approx(127.8, abs=0.034)
