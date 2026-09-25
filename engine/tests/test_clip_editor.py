"""
Tests for tight pacing: which gaps get cut, what is protected, time mapping,
and a real FFmpeg check that audio and video stay in sync across cuts.
"""

import json
import os
import shutil
import subprocess

import pytest

from clip_engine.services.clip_editor import (
    KEEP_PAUSE_MS,
    MIN_PIECE_MS,
    TimeMap,
    WindowWord,
    compute_keep_intervals,
    is_filler,
    reaction_intervals,
    remap_segments,
)
from clip_engine.services.layout_analyzer import ClipLayoutPlan, LayoutType, ShotLayout
from clip_engine.services.layout_renderer import build_layout_graph
from clip_engine.services.transcription_service import TranscriptSegment, TranscriptWord


TEST_FFMPEG = os.environ.get("TEST_FFMPEG") or shutil.which("ffmpeg")


def encoder_args():
    encoders = subprocess.run([TEST_FFMPEG, "-hide_banner", "-encoders"], capture_output=True, text=True, check=True).stdout
    if "libx264" in encoders:
        return ["-c:v", "libx264", "-preset", "ultrafast"]
    if "h264_videotoolbox" in encoders:
        return ["-c:v", "h264_videotoolbox", "-allow_sw", "1", "-b:v", "4M"]
    pytest.skip("No H.264 encoder in test FFmpeg")


def speech(*spans):
    """Words from (start_ms, end_ms[, text]) tuples."""
    return [WindowWord(s[0], s[1], s[2] if len(s) > 2 else "word") for s in spans]


def plan_of(*shots, window_ms=20000):
    return ClipLayoutPlan(
        shots=[ShotLayout(a, b, layout) for a, b, layout in shots], source_width=1920, source_height=1080,
    )


def removed(keeps, window_ms):
    return window_ms - sum(e - s for s, e in keeps)


class TestKeepIntervals:
    def test_continuous_speech_is_untouched(self):
        words = speech(*[(100 + i * 400, 450 + i * 400) for i in range(20)])
        assert compute_keep_intervals(words, 8200) == [(0, 8200)]

    def test_long_pause_on_talking_head_is_compressed(self):
        words = speech((100, 900), (3000, 3800))
        keeps = compute_keep_intervals(words, 4200, plan_of((0, 4200, LayoutType.TALKING_HEAD)))
        assert len(keeps) == 2
        gap_after = keeps[1][0] - keeps[0][1]
        assert gap_after > 0
        # ~KEEP_PAUSE_MS of the 2.1s pause survives.
        assert 2100 - removed(keeps, 4200) == pytest.approx(KEEP_PAUSE_MS, abs=40)

    def test_screen_shot_pauses_are_protected(self):
        words = speech((100, 900), (4000, 4800))
        assert compute_keep_intervals(words, 5000, plan_of((0, 5000, LayoutType.SCREEN))) == [(0, 5000)]

    def test_screen_cam_only_cuts_long_waits(self):
        plan = plan_of((0, 12000, LayoutType.SCREEN_CAM))
        short = compute_keep_intervals(speech((100, 900), (2400, 3000), (3000, 11900)), 12000, plan)
        assert short == [(0, 12000)]  # 1.5s pause kept
        long = compute_keep_intervals(speech((100, 900), (4000, 4800), (4800, 11900)), 12000, plan)
        assert removed(long, 12000) > 2000

    def test_unknown_layout_does_not_jump_cut_demos(self):
        # No plan (analysis failed or skipped): a silent 1.5s demo stays, as on
        # screen+webcam, instead of being cut like talking-head dead air.
        short = compute_keep_intervals(speech((100, 900), (2400, 3000), (3000, 11900)), 12000, None)
        assert short == [(0, 12000)]
        long = compute_keep_intervals(speech((100, 900), (4000, 4800), (4800, 11900)), 12000, None)
        assert removed(long, 12000) > 2000

    def test_filler_gap_is_always_compressed(self):
        words = speech((100, 900, "So"), (1000, 1500, "um,"), (1600, 2300, "anyway"), (2300, 9000, "rest"))
        keeps = compute_keep_intervals(words, 9100, plan_of((0, 9100, LayoutType.TALKING_HEAD)))
        # The "um" and its surrounding silence collapse to a short breath.
        assert removed(keeps, 9100) >= 400
        assert all(not (s <= 1250 < e) for s, e in keeps)
        assert all(not (s < 1500 and e > 1000) for s, e in keeps)

    def test_reaction_is_never_cut(self):
        words = speech((100, 900), (4000, 4800))
        keeps = compute_keep_intervals(
            words, 5000, plan_of((0, 5000, LayoutType.TALKING_HEAD)), protected=[(900, 4000)],
        )
        assert keeps == [(0, 5000)]

    def test_lead_in_and_tail_silence_trimmed(self):
        words = speech((1500, 2300), (2300, 6000))
        keeps = compute_keep_intervals(words, 8000, plan_of((0, 8000, LayoutType.TALKING_HEAD)))
        assert keeps[0][0] > 1000 and keeps[-1][1] < 7000

    def test_tail_only_cut_survives_non_frame_aligned_window_end(self):
        words = speech((300, 650), (700, 1050))
        keeps = compute_keep_intervals(
            words, 10150, plan_of((0, 10150, LayoutType.SCREEN_CAM)),
        )
        assert len(keeps) == 1
        assert keeps[0][0] == 0
        assert 1400 <= keeps[0][1] <= 1500

    def test_detected_layout_wins_over_forced_style(self):
        # "Classic" (fit) framing of a talking head still gets tight pacing.
        plan = plan_of((0, 5000, LayoutType.SCREEN))
        plan.shots[0].detected_layout = LayoutType.TALKING_HEAD
        keeps = compute_keep_intervals(speech((100, 900), (4000, 4800)), 5000, plan)
        assert len(keeps) == 2

    def test_pieces_on_frame_grid_and_not_slivers(self):
        words = speech(*[(i * 1700, i * 1700 + 500) for i in range(8)])
        keeps = compute_keep_intervals(words, 14000, plan_of((0, 14000, LayoutType.TALKING_HEAD)))
        for start, end in keeps:
            assert end - start >= MIN_PIECE_MS or (start, end) == keeps[-1]
            for t in (start, end):
                assert abs(t / (1000 / 30) - round(t / (1000 / 30))) < 0.05 or t == 14000


class TestFillers:
    @pytest.mark.parametrize("word", ["um", "Uh,", "umm...", "Hmm"])
    def test_fillers(self, word):
        assert is_filler(word)

    @pytest.mark.parametrize("word", ["so", "like", "ah", "umbrella", "her"])
    def test_real_words(self, word):
        assert not is_filler(word)


class TestTimeMap:
    def test_detects_tail_only_cut_when_window_length_is_known(self):
        tm = TimeMap([(0, 2400)], window_ms=5000)
        assert tm.output_ms == 2400
        assert tm.removed_ms == 2600
        assert tm.has_cuts
        assert tm.cut_count == 1

    def test_maps_and_clamps(self):
        tm = TimeMap([(0, 1000), (2000, 3000)])
        assert tm.output_ms == 2000
        assert tm.to_output(500) == 500
        assert tm.to_output(2500) == 1500
        assert tm.to_output(1500) is None
        assert tm.to_output_clamped(1500) == 1000

    def test_remap_segments_drops_fillers_and_shifts_words(self):
        words = [
            TranscriptWord("Hello", 10_000, 10_400),
            TranscriptWord("um", 10_500, 10_800),
            TranscriptWord("world.", 12_000, 12_400),
        ]
        segs = [TranscriptSegment(10_000, 12_400, "Hello um world.", words=words)]
        tm = TimeMap([(0, 450), (1900, 2600)])  # window starts at 10_000
        out = remap_segments(segs, 10_000, tm)
        assert [w.word for w in out[0].words] == ["Hello", "world."]
        assert out[0].words[1].start_time_ms == 10_000 + 450 + 100

    def test_keeps_filler_caption_when_audio_was_not_cut(self):
        words = [TranscriptWord("um", 10_500, 10_800)]
        segs = [TranscriptSegment(10_500, 10_800, "um", words=words)]
        out = remap_segments(segs, 10_000, TimeMap([(0, 2000)]))
        assert [w.word for w in out[0].words] == ["um"]

    def test_reaction_intervals_follow_event_sentences(self):
        segs = [
            TranscriptSegment(0, 1000, "Joke.", audio_events=["(laughter)"]),
            TranscriptSegment(3000, 4000, "Next."),
        ]
        assert reaction_intervals(segs, 0, 5000) == [(1000, 3000)]


@pytest.mark.skipif(not TEST_FFMPEG, reason="ffmpeg not installed")
def test_ffmpeg_cuts_keep_audio_video_in_sync(tmp_path):
    plan = plan_of((0, 3000, LayoutType.TALKING_HEAD), (3000, 6000, LayoutType.SCREEN), window_ms=6000)
    plan.shots[0].focus_path = [(0, 0.4, 0.4)]
    keeps = [(0, 700), (1300, 2200), (2600, 4100), (4500, 5300), (5600, 6000)]
    graph = build_layout_graph(plan, 1080, 1920, keeps, with_audio=True)
    out = tmp_path / "cut.mp4"
    subprocess.run([
        TEST_FFMPEG, "-v", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=6",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
        "-filter_complex", graph.replace("[0:a:0]", "[1:a:0]"),
        "-map", "[base]", "-map", "[aout]", *encoder_args(), "-c:a", "aac",
        str(out),
    ], check=True, capture_output=True)
    streams = json.loads(subprocess.run(
        [os.environ.get("TEST_FFPROBE") or shutil.which("ffprobe") or "ffprobe", "-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", str(out)],
        check=True, capture_output=True, text=True,
    ).stdout)["streams"]
    durations = {s["codec_type"]: float(s["duration"]) for s in streams}
    expected = sum(e - s for s, e in keeps) / 1000
    assert durations["video"] == pytest.approx(expected, abs=0.07)
    assert durations["audio"] == pytest.approx(durations["video"], abs=0.07)
