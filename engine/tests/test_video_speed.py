"""Speed must change exported media, without moving speech, captions or source trims."""

import asyncio
import copy
import os

import numpy as np
import pytest

from clip_engine.services import rendering_service as module
from clip_engine.services.ai_clipping_pipeline import ClippingJobRequest
from clip_engine.services.clip_editor import TimeMap
from clip_engine.services.layout_analyzer import ClipLayoutPlan, LayoutType, ShotLayout
from clip_engine.services.rendering_service import RenderingService, RenderRequest
from clip_engine.services.transcription_service import TranscriptSegment, TranscriptWord
from clip_engine.services.video_speed import scaled_duration_ms, validate_video_speed
from .test_av_sync import FFMPEG, FFPROBE, events, probe, run, source


@pytest.mark.parametrize("speed", [None, True, "1.5", 0, 0.5, 2.01, float("nan"), float("inf")])
def test_engine_rejects_invalid_speed(speed):
    with pytest.raises(ValueError, match="Video speed"):
        ClippingJobRequest(video_url="source.mp4", video_speed=speed)
    with pytest.raises(ValueError, match="Video speed"):
        validate_video_speed(speed)


def test_subtitles_and_chapters_share_the_sped_up_edited_timeline(tmp_path, monkeypatch):
    monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda _: None)
    service = RenderingService()
    transcript = [TranscriptSegment(34_000, 38_000, "After the cut.", words=[
        TranscriptWord("After", 34_000, 35_000), TranscriptWord("the", 35_000, 36_000),
        TranscriptWord("cut.", 36_000, 38_000),
    ])]
    original = copy.deepcopy(transcript)
    request = RenderRequest("source.mp4", str(tmp_path / "clip.mp4"), 10_000, 130_000, 64, 64,
                            video_speed=2, longform=True, transcript_segments=transcript,
                            chapters=[(10_000, "Start"), (34_000, "Too close"), (60_000, "Next")])
    time_map = TimeMap([(0, 10_000), (20_000, 120_000)], 120_000)
    # Window offset 24 s minus 10 s removed, divided by 2 = 7 s.
    sidecar = asyncio.run(service._write_subtitles(request, 10_000, time_map))
    assert sidecar
    with open(sidecar) as file:
        # SRT readability adds the existing 400 ms hold after the final word.
        assert "00:00:07,000 --> 00:00:09,400" in file.read()
    assert service._output_chapters(request, 10_000, time_map) == [(0, "Start"), (20_000, "Next")]
    assert transcript == original


@pytest.fixture
def media_service(monkeypatch):
    if not (FFMPEG and FFPROBE):
        pytest.skip("FFmpeg and FFprobe required")
    monkeypatch.setenv("PATH", os.path.dirname(FFMPEG) + os.pathsep + os.environ.get("PATH", ""))
    service = RenderingService()
    service._video_codec_args = lambda *args: ["-c:v", "mpeg4", "-q:v", "2", "-bf", "2"]
    monkeypatch.setattr(module, "get_landscape_dimensions", lambda *_: (320, 180))
    monkeypatch.setattr(module, "get_output_dimensions", lambda *_: (180, 320))

    async def plan(request, width, height, start, duration):
        return ClipLayoutPlan([ShotLayout(0, duration, LayoutType.TALKING_HEAD)], width, height)

    monkeypatch.setattr(service, "_plan_layout", plan)
    return service


@pytest.mark.parametrize("speed", [1, 1.1, 1.25, 1.5, 1.75, 2])
def test_real_exports_preserve_sync_and_pitch_after_seek_and_cuts(tmp_path, media_service, speed):
    path = source(tmp_path, duration=14, audio_delay=0.3, audio_gap=True)
    request = RenderRequest(
        str(path), str(tmp_path / "clip.mp4"), 1137, 13137, 64, 64,
        video_speed=speed, pacing="natural", aspect_ratio="16:9", apply_padding=False,
        include_captions=False, skip_ranges_ms=[(3137, 4137)],
        title_text="Faster clips", banner_platform="youtube", banner_channel_url="example.com",
    )
    result = asyncio.run(media_service.render_clip(request))
    assert result.render_fallback is None
    assert result.duration_ms == scaled_duration_ms(11_000, speed)
    flashes, beeps = events(result.output_path)
    expected = np.array([(t - 1.137 - (1 if t >= 4.137 else 0)) / speed
                         for t in np.arange(1.5, 13, 1) if not 3.137 <= t < 4.137])
    assert len(flashes) == len(beeps) == len(expected), (flashes, beeps, expected)
    assert np.max(np.abs(beeps - expected)) < 0.03, (beeps, expected)
    assert np.max(np.abs(flashes - beeps)) < 1 / 30 + 0.02, (flashes, beeps)
    assert float(probe(result.output_path)["format"]["duration"]) == pytest.approx(11 / speed, abs=0.05)
    samples = np.frombuffer(run(FFMPEG, "-v", "error", "-i", result.output_path,
                               "-ac", "1", "-ar", "48000", "-f", "f32le", "-"), np.float32)
    spectrum = np.abs(np.fft.rfft(samples))
    frequency = np.argmax(spectrum) * 48000 / len(samples)
    assert frequency == pytest.approx(1000, abs=5)


@pytest.mark.parametrize("with_audio", [False, True])
def test_burned_captions_speed_up_with_the_picture(tmp_path, media_service, with_audio):
    path = source(tmp_path, duration=6)
    if not with_audio:
        silent = tmp_path / "silent.mkv"
        run(FFMPEG, "-v", "error", "-y", "-i", path, "-map", "0:v:0", "-c:v", "copy", "-an", silent)
        path = silent
    transcript = [TranscriptSegment(2100, 2400, "SPEED", words=[TranscriptWord("SPEED", 2100, 2400)])]
    # Compare matching frames at source 2.2s and 3.2s, away from fixture flashes.
    measurements = []
    for speed in (1, 2):
        request = RenderRequest(str(path), str(tmp_path / f"caption-{speed}.mp4"), 0, 6000, 64, 64,
                                video_speed=speed, pacing="natural", apply_padding=False,
                                transcript_segments=transcript, include_captions=True)
        result = asyncio.run(media_service.render_clip(request))
        assert result.duration_ms == 6000 / speed
        assert any(s["codec_type"] == "audio" for s in probe(result.output_path)["streams"]) == with_audio
        means = []
        for timestamp in (2.2 / speed, 3.2 / speed):
            frame = np.frombuffer(run(FFMPEG, "-v", "error", "-ss", timestamp, "-i", result.output_path,
                                     "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "-"), np.uint8)
            means.append(float(frame.mean()))
        assert means[0] > means[1] + 1, means
        measurements.append(means)
    assert measurements[0][0] == pytest.approx(measurements[1][0], abs=2)
