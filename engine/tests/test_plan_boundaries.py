"""
Offline tests for clip boundaries: duration bounds shared by router, prompt
and parser, sentence snapping under 0.1 s display rounding, backward snapping
of over-long clips, time-range clamping after snapping, and empty plans.
Automatic clipping (Jev off) keeps these guards; Jev review mode plans
complete excerpts instead (TestJevParseBoundaries). No network calls.
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


def make_planner(transcript, min_d=None, max_d=None, ranges=None, start_limit=None, end_limit=None, jev=False):
    planner = IntelligencePlannerService()
    planner.settings = Settings(_env_file=None, openrouter_api_key="test")
    planner._jev_enabled = jev
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

    def test_jev_off_prompt_keeps_exact_count_titles_and_no_overlap(self):
        prompt = make_planner([])._build_system_prompt(5, 15, 90, ["short"])
        assert "Return exactly 5 clips as JSON:" in prompt
        assert "scroll-stopping" in prompt and "Use curiosity gaps" in prompt
        assert "NO OVERLAP: No two clips should share more than 5 seconds" in prompt
        assert "Jev" not in prompt and "Preferred length" not in prompt

    def test_jev_prompt_treats_duration_as_a_preference(self):
        planner = make_planner([], jev=True)
        prompt = planner._build_system_prompt(5, 15, 90, ["long"])
        assert "Preferred length: 120–300 seconds" in prompt
        assert "Never pad, hard-truncate" in prompt
        assert "Return exactly" not in prompt
        assert "does not count toward the clip limit" in prompt


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

    def test_moment_anchors_never_move_or_drop_a_bounded_clip(self):
        tr = make_transcript()
        planner = make_planner(tr, 15, 90)
        start, end = tr[20].start_time_ms, tr[26].end_time_ms
        anchors = {"topic": "One idea", "topic_start_segment": 25, "topic_end_segment": 40,
                   "setup_segment": 30, "payoff_segment": 35, "requires_visual_context": False}
        for moment in (anchors, {**anchors, "setup_segment": 99}):
            plan = planner._parse_clip_plan_response(completion([{**clip(shown(start), shown(end)), "moment": moment}]))
            assert [(s.start_time_ms, s.end_time_ms) for s in plan.segments] == [(start, end)]

    def test_overlapping_clips_keep_the_stronger_one_and_fill_exactly_n(self):
        planner = make_planner(make_transcript())
        from clip_engine.services.intelligence_planner import ClipPlanSegment
        clips = [ClipPlanSegment(0, 30000, .9), ClipPlanSegment(10000, 40000, .8),
                 ClipPlanSegment(50000, 80000, .7), ClipPlanSegment(90000, 120000, .6)]
        kept = planner._finalize_clips(clips, 2)
        assert [(c.start_time_ms, c.end_time_ms) for c in kept] == [(0, 30000), (50000, 80000)]


class TestJevParseBoundaries:
    """Jev reviews every candidate, so complete excerpts are neither padded nor cut."""

    def test_short_complete_candidate_is_not_padded(self):
        tr = make_transcript(5)
        segment = make_planner(tr, 30, 60, jev=True)._parse_clip_plan_response(completion([clip(shown(tr[0].start_time_ms), shown(tr[0].end_time_ms))])).segments[0]
        assert segment.end_time_ms == tr[0].end_time_ms

    def test_overlong_candidate_is_not_truncated(self):
        tr = make_transcript()
        segment = make_planner(tr, 15, 60, jev=True)._parse_clip_plan_response(completion([clip(shown(tr[0].start_time_ms), shown(tr[30].end_time_ms))])).segments[0]
        assert segment.end_time_ms == tr[30].end_time_ms

    def test_rounding_is_resolved_to_the_original_sentence_edges(self):
        tr = make_transcript()
        planner = make_planner(tr, 15, 90, jev=True)
        for i in range(20, 60):
            segment = planner._parse_clip_plan_response(completion([clip(shown(tr[i-5].start_time_ms), shown(tr[i].end_time_ms))])).segments[0]
            assert segment.start_time_ms == tr[i-5].start_time_ms
            assert segment.end_time_ms == tr[i].end_time_ms

    def test_preferred_range_does_not_remove_setup_or_payoff(self):
        tr = make_transcript()
        a, b = tr[10].start_time_ms, tr[30].end_time_ms
        segment = make_planner(tr, 15, 60, start_limit=a/1000 + 10, end_limit=b/1000 - 10, jev=True)._parse_clip_plan_response(completion([clip(a/1000, b/1000)])).segments[0]
        assert (segment.start_time_ms, segment.end_time_ms) == (a, b)

    def test_partial_sentence_expands_outward(self):
        tr = make_transcript()
        segment = make_planner(tr, jev=True)._parse_clip_plan_response(completion([clip(tr[10].start_time_ms/1000 + 1, tr[15].end_time_ms/1000 - 1)])).segments[0]
        assert (segment.start_time_ms, segment.end_time_ms) == (tr[10].start_time_ms, tr[15].end_time_ms)

    def test_source_bounds_and_malformed_timestamps_are_rejected(self):
        planner = make_planner(make_transcript(10), jev=True)
        planner._current_video_duration = 50
        assert planner._parse_clip_plan_response(completion([clip(-1, 10), clip(1, 60), clip(float('nan'), 20), clip(True, 20)])).segments == []

    def test_empty_clip_list_is_preserved(self):
        assert make_planner(make_transcript(), jev=True)._parse_clip_plan_response(completion([])).segments == []


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


def test_clip_request_is_trimmed_bounded_and_blank_means_none():
    from clip_engine.services.intelligence_planner import MAX_CLIP_REQUEST_CHARS
    assert ClippingJobRequest(video_url='x', clip_request='   ').clip_request is None
    assert ClippingJobRequest(video_url='x', clip_request=' the pricing debate \n').clip_request == 'the pricing debate'
    assert len(ClippingJobRequest(video_url='x', clip_request='x' * 5000).clip_request) == MAX_CLIP_REQUEST_CHARS


class TestEmptyPlan:
    @pytest.mark.parametrize('clip_request', [None, 'every time they talk about pricing'])
    @pytest.mark.parametrize('workflow', ['automatic', 'review'])
    def test_empty_model_plan_preserves_explanation_and_never_starts_review_or_render(self, monkeypatch, tmp_path, workflow, clip_request):
        from unittest.mock import AsyncMock
        from clip_engine.error_policy import NoClipCandidatesError, NoRequestedMomentsError, safe_processing_error, safe_job_error_text
        from clip_engine.services.intelligence_planner import CLIP_REQUEST_RULE
        from clip_engine.services.sponsor_policy import SPONSOR_DISCOVERY_RULE
        monkeypatch.setattr(RenderingService, '_verify_ffmpeg', lambda self: None)
        settings = pipeline_module.get_settings()
        monkeypatch.setattr(settings, 'local_mode', True)
        monkeypatch.setattr(settings, 'local_output_dir', str(tmp_path / 'out'))
        monkeypatch.setattr(type(settings), 'temp_directory', property(lambda self: str(tmp_path / 'work')))
        pipeline = AIClippingPipeline()
        tr = make_transcript(12)
        model_response = json.dumps({'insights': 'The source was classified as a promotional showcase.', 'clips': []})
        async def complete(**kwargs):
            # The actual outgoing discovery request must explain the demo/advertising distinction.
            system = kwargs['messages'][0]['content']
            assert SPONSOR_DISCOVERY_RULE in system
            assert 'Do not require proof that the presenter is independent' in system
            user = ' '.join(part['text'] for part in kwargs['messages'][1]['content'] if part['type'] == 'text')
            assert (CLIP_REQUEST_RULE in system) == bool(clip_request)
            assert (json.dumps(clip_request) in user) == bool(clip_request)
            return {'choices': [{'message': {'content': model_response}, 'finish_reason': 'stop'}]}, {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120, 'cost': .001}
        planner_call = AsyncMock(side_effect=complete)
        render = AsyncMock()
        review = AsyncMock()
        monkeypatch.setattr(pipeline.intelligence_planner, '_call_openrouter', planner_call)
        monkeypatch.setattr(pipeline.source_context_service, 'build', AsyncMock(return_value={'status': 'unavailable', 'source': {}, 'brief': None, 'research_status': 'disabled', 'citations': [], 'cost_usd': 0, 'requests': [], 'cost_incomplete': False}))
        monkeypatch.setattr(pipeline.video_downloader, 'download_video', AsyncMock(return_value=SimpleNamespace(
            video_path='fixture.mp4', file_size_bytes=1, metadata=SimpleNamespace(title='Product walkthrough', duration_seconds=60, width=1920, height=1080))))
        monkeypatch.setattr(pipeline.transcription_service, 'transcribe', AsyncMock(return_value=TranscriptionResult(segments=tr, full_text='A product demo.')))
        monkeypatch.setattr(pipeline.rendering_service, 'render_clip', render)
        monkeypatch.setattr(pipeline_module, 'CoherenceReviewer', review)
        result = asyncio.run(pipeline.process_video(ClippingJobRequest(video_url='fixture.mp4', job_id='empty', workflow=workflow, clip_request=clip_request)))
        assert result.status == JobStatus.FAILED
        assert result.error == ('No moments matched the clip request' if clip_request else 'The planner returned no clip candidates')
        assert result.failure_code == 'planning.no_candidates' and result.failure_stage == 'planning'
        assert planner_call.await_count == 1
        review.assert_not_called()
        render.assert_not_called()
        audit = json.loads((tmp_path / 'out/empty/edit_audit.json').read_text())
        assert audit['outcome'] == 'no_candidates' and audit['candidates'] == []
        assert audit['planner']['requests'][0]['response'] == model_response
        assert len(audit['transcript']) == len(tr)
        # Public errors stay fixed even if an exception carries private provider details.
        error = NoRequestedMomentsError if clip_request else NoClipCandidatesError
        assert safe_processing_error(error('private-provider-detail')) == result.error
        assert safe_job_error_text(result.error) == result.error

    @pytest.mark.parametrize('workflow', ['automatic', 'review'])
    def test_no_speech_fails_with_clear_message(self, monkeypatch, tmp_path, workflow):
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
        result = asyncio.run(pipeline.process_video(ClippingJobRequest(video_url="x", job_id="j1", workflow=workflow)))
        assert result.status == JobStatus.FAILED
        assert result.error == 'The planner returned no clip candidates'
        assert result.failure_code == 'planning.no_candidates'
        assert result.failure_stage == 'planning'
        audit = json.loads((tmp_path / 'out/j1/edit_audit.json').read_text())
        assert audit['outcome'] == 'no_candidates'

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

    def test_jev_short_preference_keeps_full_transcript_and_can_extend(self, monkeypatch):
        tr = make_transcript(10)
        planner = make_planner(tr)
        async def complete(**kwargs):
            text = str(kwargs['messages'])
            assert tr[0].text in text and tr[-1].text in text
            assert 'Preferred discovery range' in text
            return completion([clip(tr[0].start_time_ms/1000, tr[-1].end_time_ms/1000)]), {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2, 'cost': 0}
        monkeypatch.setattr(planner, '_call_openrouter', complete)
        result = asyncio.run(planner.plan_clips(TranscriptionResult(segments=tr, full_text=''), duration_ranges=['short'],
            start_time_seconds=10, end_time_seconds=15, jev_enabled=True))
        assert len(result.segments) == 1
        assert result.segments[0].start_time_ms < 10000 and result.segments[0].end_time_ms > 15000


def _pipeline_fixture(monkeypatch, tmp_path, jev_enabled):
    from unittest.mock import AsyncMock
    monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda self: None)
    settings = pipeline_module.get_settings()
    monkeypatch.setattr(settings, "local_mode", True)
    monkeypatch.setattr(settings, "jev_enabled", jev_enabled)
    monkeypatch.setattr(settings, "source_context_web_research", False)
    monkeypatch.setattr(settings, "openrouter_api_key", "fixture")
    monkeypatch.setattr(settings, "local_output_dir", str(tmp_path / "out"))
    monkeypatch.setattr(type(settings), "temp_directory", property(lambda self: str(tmp_path / "work")))
    pipeline = AIClippingPipeline()
    # Sentences end with a 980 ms pause, long enough for reaction protection,
    # and one opens a watched event right before its pause.
    tr = make_transcript(120, pause_ms=900)
    cue = tr[31]
    for word, text in zip(cue.words[-2:], ("watch", "this.")):
        word.word = text
    cue.text = " ".join(w.word for w in cue.words)
    source = SimpleNamespace(video_path=str(tmp_path / "source.mp4"), file_size_bytes=1,
                             metadata=SimpleNamespace(title="Fixture", duration_seconds=tr[-1].end_time_ms / 1000 + 5,
                                                      width=1920, height=1080))
    monkeypatch.setattr(pipeline.video_downloader, "download_video", AsyncMock(return_value=source))
    context = AsyncMock(return_value={"status": "metadata_only", "source": {}, "brief": None, "research_status": "disabled",
                                      "citations": [], "cost_usd": 0.0, "cost_incomplete": False, "requests": []})
    monkeypatch.setattr(pipeline.source_context_service, "build", context)
    transcribed = []

    async def transcribe(video_path, work_dir, keyterms=None, start_seconds=None, end_seconds=None):
        transcribed.append((start_seconds, end_seconds))
        lo = (start_seconds or 0) * 1000 - 2000
        hi = end_seconds * 1000 + 2000 if end_seconds is not None else float("inf")
        return TranscriptionResult(segments=[s for s in tr if s.end_time_ms > lo and s.start_time_ms < hi], full_text="")

    monkeypatch.setattr(pipeline.transcription_service, "transcribe", transcribe)
    rendered = []

    async def render(request):
        from clip_engine.services.rendering_service import RenderResult
        rendered.append(request)
        with open(request.output_path, "wb") as f:
            f.write(b"mp4")
        return RenderResult(output_path=request.output_path, file_size_bytes=3,
                            duration_ms=request.end_time_ms - request.start_time_ms)

    monkeypatch.setattr(pipeline.rendering_service, "render_clip", render)
    return pipeline, tr, context, transcribed, rendered


class TestJevOffPipeline:
    """With Jev off, automatic clipping keeps the pre-Jev guards end to end."""

    def test_range_transcription_bounded_plan_and_padded_render(self, monkeypatch, tmp_path):
        pipeline, tr, context, transcribed, rendered = _pipeline_fixture(monkeypatch, tmp_path, jev_enabled=False)
        monkeypatch.setattr(pipeline_module, "analyze_reactions", lambda *a: pytest.fail("reaction protection is Jev only"))
        monkeypatch.setattr(pipeline_module, "repair_context_boundaries", lambda *a: pytest.fail("boundary expansion is Jev only"))
        range_start = tr[20].start_time_ms / 1000 + 1.0   # both mid-sentence
        range_end = tr[80].end_time_ms / 1000 - 1.0
        requests = []

        async def call(model, messages, fallback_models=None):
            requests.append((model, fallback_models, messages))
            system, transcript_text = messages[0]["content"], str(messages[1]["content"])
            assert "Return exactly 3 clips" in system and "STRICTLY between 15 and 90 seconds" in system
            assert "Preferred discovery range" not in system
            assert tr[20].text not in transcript_text and tr[21].text in transcript_text
            assert tr[80].text not in transcript_text and tr[79].text in transcript_text
            clips = [
                clip(range_start - 5, range_start + 40),                                  # clamped into the range
                clip(range_start + 2, range_start + 45),                                  # overlaps the first
                clip(shown(tr[40].start_time_ms), shown(tr[40].start_time_ms) + 3),       # < 5 s
                clip(shown(tr[50].start_time_ms), shown(tr[75].end_time_ms)),             # > 90 s, trimmed
                clip(shown(tr[30].start_time_ms), shown(tr[34].end_time_ms)),             # holds the cue
            ]
            for i, c in enumerate(clips):
                c["scores"] = {k: 9 - i for k in c["scores"]}
            usage = {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20, "cost": 0.001}
            return {**completion(clips), "model": model}, usage

        monkeypatch.setattr(pipeline.intelligence_planner, "_call_openrouter", call)
        result = asyncio.run(pipeline.process_video(ClippingJobRequest(
            video_url="fixture.mp4", job_id="jev-off", max_clips=3, auto_clip_count=False,
            start_time_seconds=range_start, end_time_seconds=range_end)))

        assert result.status == JobStatus.COMPLETED, result.error
        context.assert_not_awaited()                          # no source-context model call
        assert transcribed == [(range_start, range_end)]      # only the selected range
        assert len(requests) == 1
        assert requests[0][0] == "anthropic/claude-opus-5.5"
        assert requests[0][1] == ["google/gemini-3.8-flash", "openai/gpt-6-sol"]
        intervals = [(r.start_time_ms, r.end_time_ms) for r in rendered]
        assert len(intervals) == 3                            # exactly N: overlap and < 5 s dropped
        ends = sentence_ends(tr)
        for (start, end), request in zip(intervals, rendered):
            assert range_start * 1000 <= start < end <= range_end * 1000
            assert 15_000 <= end - start <= 90_000
            assert end in ends
            assert request.apply_padding is True
            assert request.coherence_reviewer is None and request.editorial_service is None
            assert request.editorial_context["protected_source"] == []
        # The cue clip renders exactly as planned: no reaction expansion.
        assert (tr[30].start_time_ms, tr[34].end_time_ms) in intervals
        assert result.output.metrics["analysis_duration_seconds"] == pytest.approx(range_end - range_start)
        assert "source_context" not in result.output.metrics["api_costs"]

    def test_jev_review_keeps_full_source_context_and_exact_intervals(self, monkeypatch, tmp_path):
        from unittest.mock import AsyncMock
        from clip_engine.services.intelligence_planner import ClipPlanResponse, ClipPlanSegment
        pipeline, tr, context, transcribed, rendered = _pipeline_fixture(monkeypatch, tmp_path, jev_enabled=True)
        monkeypatch.setattr(pipeline_module.CoherenceReviewer, "prepare", AsyncMock(return_value=True))
        monkeypatch.setattr(pipeline_module, "protect_acknowledgments", AsyncMock())
        monkeypatch.setattr(pipeline_module, "review_duplicate_candidates", AsyncMock())
        plan = AsyncMock(return_value=ClipPlanResponse(segments=[
            ClipPlanSegment(tr[32].start_time_ms, tr[36].end_time_ms, .9)], total_clips=1))
        monkeypatch.setattr(pipeline.intelligence_planner, "plan_clips", plan)
        result = asyncio.run(pipeline.process_video(ClippingJobRequest(
            video_url="fixture.mp4", job_id="jev-on", max_clips=1, auto_clip_count=False,
            start_time_seconds=100, end_time_seconds=200)))
        assert result.status == JobStatus.COMPLETED, result.error
        context.assert_awaited_once()
        assert transcribed == [(None, None)]
        assert plan.await_args.kwargs["jev_enabled"] is True
        request = rendered[0]
        assert request.apply_padding is False
        # The cued pause just before the clip pulls its setup line back in.
        assert request.start_time_ms == tr[31].start_time_ms
        assert request.editorial_context["protected_source"]
