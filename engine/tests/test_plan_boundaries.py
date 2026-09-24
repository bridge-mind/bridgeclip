"""
Offline tests for clip boundaries: duration bounds shared by router, prompt
and parser, sentence snapping under 0.1 s display rounding, backward snapping
of over-long clips, time-range clamping after snapping, and empty plans.
No network calls.
"""

import asyncio
import json
from types import SimpleNamespace

import pytest

from clip_engine.config import Settings, resolve_clip_duration_bounds
from clip_engine.services import ai_clipping_pipeline as pipeline_module
from clip_engine.services.ai_clipping_pipeline import AIClippingPipeline, ClippingJobRequest, JobStatus
from clip_engine.services.intelligence_planner import IntelligencePlannerService
from clip_engine.services.rendering_service import RenderingService
from clip_engine.services.transcription_service import (
    TranscriptSegment,
    TranscriptWord,
    TranscriptionResult,
    find_sentence_end_boundary,
    last_sentence_end_between,
)


def make_transcript(n_sentences=120, words_per=12, word_ms=300, gap_ms=80, pause_ms=400):
    """Sentences of `words_per` words with odd-ms timings; each ends with '.'."""
    segments = []
    t = 1000
    for s in range(n_sentences):
        words = []
        for w in range(words_per):
            text = f"w{s}_{w}" + ("." if w == words_per - 1 else "")
            words.append(TranscriptWord(text, t, t + word_ms))
            t += word_ms + gap_ms
        t += pause_ms
        segments.append(TranscriptSegment(
            words[0].start_time_ms, words[-1].end_time_ms,
            " ".join(x.word for x in words), "S1", words,
        ))
    return segments


def completion(clips):
    content = json.dumps({"insights": "x", "clips": clips})
    return {"choices": [{"message": {"content": content}, "finish_reason": "stop"}]}


def clip(start, end):
    return {
        "start_time": start, "end_time": end, "summary": "Title", "tags": [], "emphasis": [],
        "scores": {k: 5 for k in ("hook", "standalone", "arc", "quotability", "ending")},
    }


def make_planner(transcript, min_d=None, max_d=None, ranges=None, start_limit=None, end_limit=None):
    planner = IntelligencePlannerService()
    planner.settings = Settings(_env_file=None, openrouter_api_key="test")
    planner._current_min_duration = min_d
    planner._current_max_duration = max_d
    planner._current_duration_ranges = ranges
    planner._current_transcript = transcript
    planner._start_time_seconds = start_limit
    planner._end_time_seconds = end_limit
    planner._current_target_platform = "tiktok"
    return planner


def shown(ms):
    """A time as the planner sees it in the transcript (0.1 s precision)."""
    return round(ms / 1000, 1)


def sentence_ends(transcript):
    return {s.words[-1].end_time_ms for s in transcript}


class TestDurationBounds:
    def test_ranges_win_over_explicit_bounds(self):
        # BridgeClip used to leave the 15/90 defaults next to its ranges.
        assert resolve_clip_duration_bounds(["long"], 15, 90) == (120, 300)

    def test_multiple_ranges_span_their_union(self):
        assert resolve_clip_duration_bounds(["short", "long"]) == (30, 300)

    def test_explicit_then_default(self):
        assert resolve_clip_duration_bounds(None, 20, 45) == (20, 45)
        assert resolve_clip_duration_bounds(["bogus"]) == (15, 90)
        assert resolve_clip_duration_bounds() == (15, 90)

    def test_min_alone_leaves_room_above_it(self):
        # Used to give (100, 100): every clip forced to exactly 100 s, mid-sentence.
        assert resolve_clip_duration_bounds(None, 100, None) == (100, 200)
        assert resolve_clip_duration_bounds(None, 20, None) == (20, 90)

    def test_prompt_has_no_contradictory_bounds(self):
        planner = make_planner([])
        prompt = planner._build_system_prompt(5, 15, 90, ["long"])
        assert "STRICTLY between 120 and 300 seconds" in prompt
        assert "<= 300" in prompt and "<= 90" not in prompt


class TestParseBoundaries:
    def test_rounding_below_minimum_extends_to_next_sentence(self):
        transcript = [
            TranscriptSegment(i * 5000, (i + 1) * 5000 - 50, "Sentence.", words=[
                TranscriptWord("Sentence.", i * 5000, (i + 1) * 5000 - 50),
            ])
            for i in range(4)
        ]
        planner = make_planner(transcript, 15, 20)
        plan = planner._parse_clip_plan_response(completion([clip(0, 15.0)]))
        assert len(plan.segments) == 1
        assert plan.segments[0].end_time_ms == 19_950

    def test_rounding_below_minimum_filters_when_no_sentence_fits(self):
        transcript = [
            TranscriptSegment(i * 5000, (i + 1) * 5000 - 50, "Sentence.", words=[
                TranscriptWord("Sentence.", i * 5000, (i + 1) * 5000 - 50),
            ])
            for i in range(4)
        ]
        planner = make_planner(transcript, 15, 15)
        assert planner._parse_clip_plan_response(completion([clip(0, 15.0)])).segments == []

    def test_long_clip_survives_with_default_bounds_passed(self):
        tr = make_transcript()
        start_ms, end_ms = tr[10].start_time_ms, tr[60].end_time_ms
        planner = make_planner(tr, 15, 90, ["long"])
        seg = planner._parse_clip_plan_response(completion([clip(shown(start_ms), shown(end_ms))])).segments[0]
        assert (seg.end_time_ms - seg.start_time_ms) / 1000 == pytest.approx((end_ms - start_ms) / 1000, abs=0.1)
        assert seg.end_time_ms == end_ms

    def test_rounded_sentence_end_is_not_extended_into_next_sentence(self):
        tr = make_transcript()
        planner = make_planner(tr, 5, 600)
        for i in range(20, 60):
            true_end = tr[i].end_time_ms
            plan = planner._parse_clip_plan_response(
                completion([clip(shown(tr[i - 5].start_time_ms), shown(true_end))])
            )
            assert plan.segments[0].end_time_ms == true_end

    def test_over_long_clip_snaps_back_to_last_sentence_that_fits(self):
        tr = make_transcript()
        planner = make_planner(tr, 15, 60)
        start_ms = tr[30].start_time_ms
        seg = planner._parse_clip_plan_response(
            completion([clip(shown(start_ms), shown(tr[50].end_time_ms))])
        ).segments[0]
        duration_s = (seg.end_time_ms - seg.start_time_ms) / 1000
        assert 15 <= duration_s <= 60
        assert seg.end_time_ms in sentence_ends(tr)

    def test_snapping_stays_inside_selected_range(self):
        tr = make_transcript()
        range_start = tr[40].start_time_ms / 1000 + 1.0  # starts mid-sentence
        range_end = tr[70].end_time_ms / 1000 - 1.0      # ends mid-sentence
        planner = make_planner(tr, 15, 90, None, range_start, range_end)
        plan = planner._parse_clip_plan_response(completion([
            clip(range_start - 5, range_start + 40),
            clip(range_end - 40, range_end + 5),
        ]))
        for seg in plan.segments:
            assert seg.start_time_ms >= range_start * 1000
            assert seg.end_time_ms <= range_end * 1000

    def test_range_end_mid_sentence_ends_on_last_sentence_inside(self):
        # The clip end is clamped to a range end that falls mid-sentence; it
        # used to stay there (mid-sentence) because the forward snap left the range.
        tr = make_transcript()
        range_end = tr[70].end_time_ms / 1000 - 1.0
        planner = make_planner(tr, 15, 90, None, None, range_end)
        seg = planner._parse_clip_plan_response(completion([clip(range_end - 40, range_end + 5)])).segments[0]
        assert seg.end_time_ms == tr[69].end_time_ms

    def test_range_start_mid_word_moves_to_next_word(self):
        # Range start falls inside a word and the next sentence is >3 s away:
        # start on the next word rather than mid-word.
        tr = make_transcript()
        range_start = tr[40].start_time_ms / 1000 + 1.0
        planner = make_planner(tr, 15, 90, None, range_start, None)
        seg = planner._parse_clip_plan_response(completion([clip(range_start - 5, range_start + 40)])).segments[0]
        assert seg.start_time_ms == tr[40].words[3].start_time_ms

    def test_range_start_prefers_a_nearby_sentence_start(self):
        tr = make_transcript()
        range_start = tr[40].start_time_ms / 1000 + 2.0  # mid-word; next sentence starts 2.96 s later
        planner = make_planner(tr, 15, 90, None, range_start, None)
        seg = planner._parse_clip_plan_response(completion([clip(range_start - 5, range_start + 40)])).segments[0]
        assert seg.start_time_ms == tr[41].start_time_ms

    def test_empty_clip_list_parses_to_empty_plan(self):
        plan = make_planner(make_transcript())._parse_clip_plan_response(completion([]))
        assert plan.segments == [] and plan.total_clips == 0


class TestSentenceHelpers:
    def test_nearest_end_within_tolerance_wins(self):
        tr = make_transcript(5)
        end = tr[1].end_time_ms
        assert find_sentence_end_boundary(tr, end + 40) == end   # rounded up
        assert find_sentence_end_boundary(tr, end - 40) == end   # rounded down

    def test_last_sentence_end_between(self):
        tr = make_transcript(5)
        ends = sorted(sentence_ends(tr))
        assert last_sentence_end_between(tr, ends[0], ends[2] + 100) == ends[2]
        assert last_sentence_end_between(tr, ends[2] + 1, ends[3] - 1) is None


class TestEmptyPlan:
    def test_no_speech_fails_with_clear_message(self, monkeypatch, tmp_path):
        monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda self: None)
        settings = pipeline_module.get_settings()
        monkeypatch.setattr(settings, "local_mode", True)
        monkeypatch.setattr(settings, "local_output_dir", str(tmp_path / "out"))
        monkeypatch.setattr(type(settings), "temp_directory", property(lambda self: str(tmp_path / "work")))
        pipeline = AIClippingPipeline()
        pipeline.local_mode = True

        async def download(url, output_dir):
            meta = SimpleNamespace(title="T", duration_seconds=300.0, width=1920, height=1080)
            return SimpleNamespace(video_path="x.mp4", metadata=meta, file_size_bytes=1)

        async def transcribe(video_path, work_dir, keyterms=None, **_range):
            return TranscriptionResult(segments=[], full_text="")  # silent demo / music-only

        monkeypatch.setattr(pipeline.video_downloader, "download_video", download)
        monkeypatch.setattr(pipeline.transcription_service, "transcribe", transcribe)
        result = asyncio.run(pipeline.process_video(ClippingJobRequest(video_url="x", job_id="j1")))
        assert result.status == JobStatus.FAILED
        assert "No clip-worthy moments found" in result.error

    def test_range_shorter_than_min_clip_skips_the_paid_call(self, monkeypatch):
        from clip_engine.services import intelligence_planner as planner_module

        async def no_call(*args, **kwargs):
            raise AssertionError("planner model must not be called")

        monkeypatch.setattr(planner_module, "chat_completion", no_call)
        tr = make_transcript(10)
        planner = make_planner(tr)
        start_s = tr[2].start_time_ms / 1000
        plan = asyncio.run(planner.plan_clips(
            TranscriptionResult(segments=tr, full_text=""),
            duration_ranges=["short"],                     # clips must be 30-60 s
            start_time_seconds=start_s, end_time_seconds=start_s + 20,
        ))
        assert plan.segments == []
        assert "shorter than the minimum clip length" in plan.insights
