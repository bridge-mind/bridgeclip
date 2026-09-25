"""
Tests for RenderingService.render_clip's fallback ladder (smart + cuts ->
letterbox + cuts -> letterbox at natural timing) and for tight pacing with
captions turned off. FFmpeg is stubbed: these check which edit gets rendered.
"""

import asyncio

import pytest

from clip_engine.services.clip_editor import TAIL_MS
from clip_engine.services.layout_analyzer import Box, ClipLayoutPlan, LayoutType, ShotLayout
from clip_engine.services.rendering_service import RenderingError, RenderingService, RenderRequest
from clip_engine.services.transcription_service import TranscriptSegment, TranscriptWord


def transcript() -> list[TranscriptSegment]:
    """Speech with a 3s pause in the middle, so tight pacing makes a cut."""
    first = [TranscriptWord(f"w{i}", 300 + i * 400, 650 + i * 400) for i in range(8)]
    second = [TranscriptWord(f"v{i}", 6500 + i * 400, 6850 + i * 400) for i in range(8)]
    return [
        TranscriptSegment(300, 3450, "First part.", words=first),
        TranscriptSegment(6500, 9650, "Second part.", words=second),
    ]


def smart_plan(window_ms: int) -> ClipLayoutPlan:
    return ClipLayoutPlan(
        shots=[ShotLayout(0, window_ms, LayoutType.SCREEN_CAM, source="vision",
                          cam_box=Box(0.62, 0.55, 0.36, 0.43), screen_box=Box(0, 0, 1, 1))],
        source_width=1920, source_height=1080, vision_cost_usd=0.002,
    )


@pytest.fixture
def service(monkeypatch):
    monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda self: None)
    svc = RenderingService()

    async def dims(_path):
        return 1920, 1080

    async def plan_layout(request, src_w, src_h, window_start_ms, window_ms):
        return smart_plan(window_ms)

    monkeypatch.setattr(svc, "_get_video_dimensions", dims)
    monkeypatch.setattr(svc, "_plan_layout", plan_layout)
    return svc


def stub_render(monkeypatch, svc, failures: int, calls: list):
    """_render_edit that fails the first `failures` attempts, then writes a file."""
    async def render_edit(request, plan, time_map, *args):
        calls.append((plan.is_letterbox_only, time_map.has_cuts))
        if len(calls) <= failures:
            raise RenderingError("FFmpeg failed: Cannot select channel layout")
        with open(request.output_path, "wb") as f:
            f.write(b"\0" * 1024)

    monkeypatch.setattr(svc, "_render_edit", render_edit)


def request_for(tmp_path, **kwargs) -> RenderRequest:
    return RenderRequest(
        video_path="src.mp4", output_path=str(tmp_path / "clip.mp4"),
        start_time_ms=0, end_time_ms=10000, source_width=1920, source_height=1080,
        transcript_segments=transcript(), **kwargs,
    )


def render(svc, request):
    return asyncio.run(svc.render_clip(request))


class TestFallbackLadder:
    @pytest.mark.parametrize("failures", [0, 1, 2])
    def test_every_fallback_keeps_export_speed(self, service, monkeypatch, tmp_path, failures):
        calls = []
        async def render_edit(request, plan, time_map, *args):
            assert request.video_speed == 1.5
            calls.append(time_map.output_ms)
            if len(calls) <= failures:
                raise RenderingError("FFmpeg failed")
            with open(request.output_path, "wb") as output:
                output.write(b"mp4")
        monkeypatch.setattr(service, "_render_edit", render_edit)
        result = render(service, request_for(tmp_path, video_speed=1.5))
        assert len(calls) == failures + 1
        assert result.duration_ms == round(calls[-1] / 1.5)

    def test_tail_only_cut_has_natural_timing_fallback(self, service, monkeypatch, tmp_path):
        calls: list = []
        stub_render(monkeypatch, service, 2, calls)
        request = request_for(tmp_path)
        request.transcript_segments = [
            TranscriptSegment(
                300, 1050, "Short sentence.",
                words=[TranscriptWord("Short", 300, 650), TranscriptWord("sentence.", 700, 1050)],
            ),
        ]

        result = render(service, request)

        assert calls == [(False, True), (True, True), (True, False)]
        assert result.render_fallback == "letterbox_natural"
        assert result.duration_ms == service._compute_padded_range(0, 10000)[1]
        assert result.removed_ms == 0

    def test_smart_render_as_planned(self, service, monkeypatch, tmp_path):
        calls: list = []
        stub_render(monkeypatch, service, 0, calls)
        result = render(service, request_for(tmp_path))
        assert calls == [(False, True)]
        assert result.render_fallback is None
        assert result.layout_type == LayoutType.SCREEN_CAM
        assert result.removed_ms > 0

    def test_letterbox_keeps_pacing_cuts(self, service, monkeypatch, tmp_path):
        calls: list = []
        stub_render(monkeypatch, service, 1, calls)
        result = render(service, request_for(tmp_path))
        assert calls == [(False, True), (True, True)]
        assert result.render_fallback == "letterbox"
        assert result.layout_type == "fit"
        assert result.removed_ms > 0
        # The vision call was made (and paid for) even though a fallback rendered.
        assert result.layout_cost_usd == pytest.approx(0.002)

    def test_natural_timing_is_the_last_resort(self, service, monkeypatch, tmp_path):
        calls: list = []
        stub_render(monkeypatch, service, 2, calls)
        result = render(service, request_for(tmp_path))
        assert calls == [(False, True), (True, True), (True, False)]
        assert result.render_fallback == "letterbox_natural"
        assert result.removed_ms == 0

    def test_error_raised_when_every_step_fails(self, service, monkeypatch, tmp_path):
        calls: list = []
        stub_render(monkeypatch, service, 3, calls)
        with pytest.raises(RenderingError):
            render(service, request_for(tmp_path))
        assert len(calls) == 3


class TestCaptionsOff:
    def test_pacing_still_cuts_without_captions(self, service, monkeypatch, tmp_path):
        calls: list = []
        stub_render(monkeypatch, service, 0, calls)
        result = render(service, request_for(tmp_path, include_captions=False))
        assert result.removed_ms > 0

    def test_no_caption_file_when_captions_off(self, service, tmp_path):
        from clip_engine.services.clip_editor import TimeMap

        request = request_for(tmp_path, include_captions=False)
        path = asyncio.run(service._generate_captions(
            request, 1080, 1920, 0, TimeMap([(0, 10000)]), smart_plan(10000), False,
        ))
        assert path is None


class TestUnexpectedErrors:
    def test_non_rendering_error_moves_down_the_ladder(self, service, monkeypatch, tmp_path):
        # A bug building the graph, captions or overlays must not cost the clip.
        calls: list = []

        async def render_edit(request, plan, time_map, *args):
            calls.append(plan.is_letterbox_only)
            if len(calls) == 1:
                raise ValueError("bad overlay geometry")
            with open(request.output_path, "wb") as f:
                f.write(b"\0" * 1024)

        monkeypatch.setattr(service, "_render_edit", render_edit)
        result = render(service, request_for(tmp_path))
        assert calls == [False, True]
        assert result.render_fallback == "letterbox"

    def test_last_step_still_raises(self, service, monkeypatch, tmp_path):
        async def render_edit(request, plan, time_map, *args):
            raise ValueError("always broken")

        monkeypatch.setattr(service, "_render_edit", render_edit)
        with pytest.raises(ValueError):
            render(service, request_for(tmp_path))


def paused_transcript() -> list[TranscriptSegment]:
    """Five words with 1.5s pauses: dead air on a talking head (700ms limit),
    but under the 2s limit used when shot content is unknown."""
    words = [TranscriptWord(f"w{i}", 300 + i * 1850, 650 + i * 1850) for i in range(5)]
    return [TranscriptSegment(300, words[-1].end_time_ms, "Five slow words.", words=words)]


class TestPacingWithoutSmartFraming:
    """Classic style and 16:9 skip layout analysis for framing, but pacing
    still needs to know what's on screen (heuristics only, no vision call)."""

    @pytest.fixture
    def plain_service(self, monkeypatch):
        monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda self: None)
        svc = RenderingService()

        async def dims(_path):
            return 1920, 1080

        monkeypatch.setattr(svc, "_get_video_dimensions", dims)
        stub_render(monkeypatch, svc, 0, [])
        return svc

    def analyze_returning(self, monkeypatch, svc, plan_for):
        calls: list = []

        async def analyze(video, start, window_ms, w, h, style, vision=True):
            calls.append({"style": style, "vision": vision})
            return plan_for(window_ms)

        monkeypatch.setattr(svc.layout_analyzer, "analyze", analyze)
        return calls

    @pytest.mark.parametrize("style,aspect", [("fit", "9:16"), ("auto", "16:9")])
    def test_talking_head_gets_the_talking_head_limit(self, plain_service, monkeypatch, tmp_path, style, aspect):
        calls = self.analyze_returning(monkeypatch, plain_service, lambda window_ms: ClipLayoutPlan(
            shots=[ShotLayout(0, window_ms, LayoutType.TALKING_HEAD, people=[Box(0.45, 0.2, 0.1, 0.25)])],
            source_width=1920, source_height=1080,
        ))
        request = RenderRequest(
            video_path="src.mp4", output_path=str(tmp_path / "clip.mp4"),
            start_time_ms=0, end_time_ms=10000, source_width=1920, source_height=1080,
            transcript_segments=paused_transcript(), layout_style=style, aspect_ratio=aspect,
        )
        result = render(plain_service, request)
        assert calls == [{"style": "auto", "vision": False}]
        # Four 1.5s pauses cut down to a 260ms breath each.
        assert result.removed_ms >= 4 * 1000
        assert result.layout_type == "fit" and result.layout_cost_usd == 0.0

    def test_unknown_content_keeps_the_gentle_limit(self, plain_service, monkeypatch, tmp_path):
        self.analyze_returning(monkeypatch, plain_service, lambda window_ms: None)  # analysis unavailable
        request = RenderRequest(
            video_path="src.mp4", output_path=str(tmp_path / "clip.mp4"),
            start_time_ms=0, end_time_ms=10000, source_width=1920, source_height=1080,
            transcript_segments=paused_transcript(), layout_style="fit",
        )
        result = render(plain_service, request)
        # The 1.5s pauses stay; only the long tail is trimmed.
        assert result.duration_ms == pytest.approx(paused_transcript()[0].end_time_ms + TAIL_MS, abs=40)

    def test_no_analysis_when_pacing_is_natural(self, plain_service, monkeypatch, tmp_path):
        calls = self.analyze_returning(monkeypatch, plain_service, lambda window_ms: None)
        request = RenderRequest(
            video_path="src.mp4", output_path=str(tmp_path / "clip.mp4"),
            start_time_ms=0, end_time_ms=10000, source_width=1920, source_height=1080,
            transcript_segments=paused_transcript(), layout_style="fit", pacing="natural",
        )
        render(plain_service, request)
        assert calls == []
