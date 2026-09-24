"""
Tests for keeping burned-in captions off the speaker's face: mapping detected
faces onto the output frame, choosing each caption group's position, and
pinning every event of a group to that one position.
"""

import asyncio
import re

import pytest

from clip_engine.config import get_caption_preset
from clip_engine.services.caption_generator import CaptionGeneratorService
from clip_engine.services.clip_editor import TimeMap
from clip_engine.services.layout_analyzer import Box, ClipLayoutPlan, LayoutType, ShotLayout
from clip_engine.services.layout_renderer import (
    CAPTION_BOTTOM_LIMIT,
    CAPTION_TOP_LIMIT,
    CaptionPlacer,
    FaceZone,
    caption_anchor,
    face_rects,
    face_zones,
    shot_chain,
    shot_views,
)
from clip_engine.services.rendering_service import RenderingService, RenderRequest
from clip_engine.services.transcription_service import TranscriptSegment, TranscriptWord

SRC_W, SRC_H = 1920, 1080
OUT_W, OUT_H = 1080, 1920
POS = re.compile(r"\\an(\d)\\pos\((\d+),(\d+)\)")


def talking_head(face: Box, end_ms: int = 10_000) -> ShotLayout:
    return ShotLayout(0, end_ms, LayoutType.TALKING_HEAD, focus_path=[(0, face.cx, face.cy)], people=[face])


def plan_with(shot: ShotLayout, faces: list[Box], every_ms: int = 250) -> ClipLayoutPlan:
    return ClipLayoutPlan(
        [shot], SRC_W, SRC_H,
        face_samples=[(t, list(faces)) for t in range(shot.start_ms, shot.end_ms, every_ms)],
    )


def placer_for(plan: ClipLayoutPlan, time_map: TimeMap = None) -> CaptionPlacer:
    time_map = time_map or TimeMap([(0, plan.shots[-1].end_ms)])
    anchors = [(s.end_ms, *caption_anchor(s, SRC_W, SRC_H, OUT_W, OUT_H)) for s in plan.shots]
    anchors[-1] = (10**9, anchors[-1][1], anchors[-1][2])
    return CaptionPlacer(anchors, face_zones(plan, time_map, OUT_W, OUT_H), OUT_W, OUT_H)


def block_span(alignment: int, y: int, h: int) -> tuple[float, float]:
    top = y - h if alignment in (1, 2, 3) else y if alignment in (7, 8, 9) else y - h / 2
    return top, top + h


class TestFaceGeometry:
    def test_talking_head_face_lands_where_the_crop_puts_it(self):
        # 16:9 source: the 9:16 crop spans the full height, so output y is
        # source y scaled to 1920; x is relative to the centered crop.
        face = Box(0.40, 0.20, 0.20, 0.35)
        (rect,) = face_rects(talking_head(face), [face], 0, SRC_W, SRC_H, OUT_W, OUT_H)
        crop_w = 606
        crop_x = face.cx * SRC_W - crop_w / 2
        scale = OUT_W / crop_w
        assert rect[1] == round(0.20 * OUT_H) and rect[3] == round(0.55 * OUT_H)
        assert rect[0] == round((0.40 * SRC_W - crop_x) * scale)

    def test_panning_crop_is_followed_over_time(self):
        shot = ShotLayout(0, 4000, LayoutType.TALKING_HEAD, focus_path=[(0, 0.3, 0.4), (2000, 0.7, 0.4)])
        face = Box(0.45, 0.25, 0.1, 0.2)
        (early,) = face_rects(shot, [face], 0, SRC_W, SRC_H, OUT_W, OUT_H)
        (late,) = face_rects(shot, [face], 3000, SRC_W, SRC_H, OUT_W, OUT_H)
        # The camera moved right past the (static) face, so it slides left.
        assert late[0] < early[0]

    def test_views_match_the_filter_graph(self):
        two_shot = ShotLayout(0, 1000, LayoutType.TWO_SHOT,
                              people=[Box(0.2, 0.25, 0.12, 0.25), Box(0.68, 0.3, 0.12, 0.25)])
        small_cam = ShotLayout(0, 1000, LayoutType.SCREEN_CAM, cam_box=Box(0.80, 0.80, 0.12, 0.12),
                               cam_face=Box(0.84, 0.82, 0.04, 0.05), screen_box=Box(0, 0, 1, 1))
        for shot in (two_shot, small_cam):
            chain = shot_chain(0, shot, SRC_W, SRC_H, OUT_W, OUT_H)
            views = shot_views(shot, 0, SRC_W, SRC_H, OUT_W, OUT_H)
            assert len(views) == 2
            for (x, y, w, h), _ in views:
                assert f"crop={w}:{h}:{x}:{y}" in chain
        # The small webcam is letterboxed inside its panel: same offsets as the overlay.
        (_, _), (_, (dx, dy, dw, dh)) = shot_views(small_cam, 0, SRC_W, SRC_H, OUT_W, OUT_H)
        top_h = shot_views(small_cam, 0, SRC_W, SRC_H, OUT_W, OUT_H)[0][1][3]
        assert f"overlay={dx}:{dy - top_h}" in shot_chain(0, small_cam, SRC_W, SRC_H, OUT_W, OUT_H)

    def test_each_two_shot_face_lands_in_its_own_panel(self):
        left, right = Box(0.2, 0.25, 0.12, 0.25), Box(0.68, 0.3, 0.12, 0.25)
        shot = ShotLayout(0, 1000, LayoutType.TWO_SHOT, people=[left, right])
        rects = face_rects(shot, [left, right], 0, SRC_W, SRC_H, OUT_W, OUT_H)
        assert len(rects) == 2
        assert any(r[3] <= 960 for r in rects) and any(r[1] >= 960 for r in rects)

    def test_letterbox_maps_into_the_video_band(self):
        face = Box(0.4, 0.3, 0.2, 0.3)
        (rect,) = face_rects(ShotLayout(0, 1000, LayoutType.SCREEN), [face], 0, SRC_W, SRC_H, OUT_W, OUT_H)
        assert 656 <= rect[1] < rect[3] <= 656 + 608

    def test_background_faces_are_ignored(self):
        tiny = Box(0.5, 0.5, 0.01, 0.02)
        assert face_rects(talking_head(tiny), [tiny], 0, SRC_W, SRC_H, OUT_W, OUT_H) == []


class TestFaceZones:
    def test_zones_follow_the_edit(self):
        face = Box(0.40, 0.35, 0.24, 0.35)
        plan = ClipLayoutPlan([talking_head(face, 6000)], SRC_W, SRC_H,
                              face_samples=[(3000, [face]), (4100, [face])])
        zones = face_zones(plan, TimeMap([(0, 2000), (4000, 6000)], 6000), OUT_W, OUT_H)
        # The detection inside the cut is dropped; the next is moved 2 s earlier
        # and clipped at the cut.
        assert [(z.start_ms, z.end_ms) for z in zones] == [(2000, 2475)]

    def test_shot_without_detections_uses_its_summary_boxes(self):
        face = Box(0.40, 0.35, 0.24, 0.35)
        shot = talking_head(face, 5000)
        plan = ClipLayoutPlan([shot], SRC_W, SRC_H, face_samples=[(t, []) for t in range(0, 5000, 250)])
        zones = face_zones(plan, TimeMap([(0, 5000)]), OUT_W, OUT_H)
        assert [(z.start_ms, z.end_ms) for z in zones] == [(0, 5000)]

    def test_no_faces_means_no_zones(self):
        plan = ClipLayoutPlan([ShotLayout(0, 5000, LayoutType.SCREEN)], SRC_W, SRC_H,
                              face_samples=[(t, []) for t in range(0, 5000, 250)])
        assert face_zones(plan, TimeMap([(0, 5000)]), OUT_W, OUT_H) == []


class TestCaptionPlacer:
    BLOCK = (830, 135)

    def test_keeps_the_usual_spot_when_the_face_is_clear(self):
        placer = placer_for(plan_with(talking_head(Box(0.40, 0.15, 0.20, 0.35)), [Box(0.40, 0.15, 0.20, 0.35)]))
        assert placer(1000, 2500, *self.BLOCK) == (5, 1340)

    def test_moves_below_the_chin_of_a_low_close_up(self):
        face = Box(0.38, 0.35, 0.24, 0.35)  # 672-1344 px on the output
        alignment, y = placer_for(plan_with(talking_head(face), [face]))(1000, 2500, *self.BLOCK)
        top, bottom = block_span(alignment, y, self.BLOCK[1])
        assert top > 0.70 * OUT_H
        assert bottom <= CAPTION_BOTTOM_LIMIT * OUT_H

    def test_moves_above_a_face_filling_the_lower_frame(self):
        face = Box(0.35, 0.40, 0.30, 0.45)  # 768-1632 px: no room under the chin
        alignment, y = placer_for(plan_with(talking_head(face), [face]))(1000, 2500, *self.BLOCK)
        top, bottom = block_span(alignment, y, self.BLOCK[1])
        assert bottom < 0.40 * OUT_H
        assert top >= CAPTION_TOP_LIMIT * OUT_H

    def test_never_covers_a_face_that_only_passes_by(self):
        # The speaker leans into frame for half a second in the middle of a phrase.
        shot = talking_head(Box(0.40, 0.10, 0.20, 0.30))
        lean = Box(0.38, 0.35, 0.24, 0.35)
        plan = ClipLayoutPlan([shot], SRC_W, SRC_H, face_samples=[
            (t, [lean] if 1500 <= t < 2000 else [Box(0.40, 0.10, 0.20, 0.30)]) for t in range(0, 10_000, 250)
        ])
        alignment, y = placer_for(plan)(1000, 2500, *self.BLOCK)
        assert block_span(alignment, y, self.BLOCK[1])[0] > 0.70 * OUT_H

    def test_moved_captions_stay_put_within_a_shot(self):
        face = Box(0.38, 0.35, 0.24, 0.35)
        high = Box(0.40, 0.10, 0.20, 0.30)
        plan = ClipLayoutPlan([talking_head(face)], SRC_W, SRC_H, face_samples=[
            (t, [face] if t < 3000 else [high]) for t in range(0, 10_000, 250)
        ])
        placer = placer_for(plan)
        moved = placer(1000, 2500, *self.BLOCK)
        assert moved != (5, 1340)
        # The face has moved up and the usual spot is clear again, but hopping
        # back and forth between phrases reads worse than staying.
        assert placer(4000, 5000, *self.BLOCK) == moved

    def test_new_shot_starts_from_its_own_anchor(self):
        close = Box(0.38, 0.35, 0.24, 0.35)
        wide = Box(0.40, 0.10, 0.20, 0.30)
        plan = ClipLayoutPlan(
            [talking_head(close, 5000), ShotLayout(5000, 10_000, LayoutType.TALKING_HEAD,
                                                   focus_path=[(0, wide.cx, wide.cy)], people=[wide])],
            SRC_W, SRC_H,
            face_samples=[(t, [close] if t < 5000 else [wide]) for t in range(0, 10_000, 250)],
        )
        placer = placer_for(plan)
        assert placer(1000, 2500, *self.BLOCK) != (5, 1340)
        assert placer(6000, 7000, *self.BLOCK) == (5, 1340)

    def test_no_zones_keeps_every_anchor(self):
        placer = CaptionPlacer([(10**9, 2, 1560)], [], OUT_W, OUT_H)
        assert placer(0, 1000, *self.BLOCK) == (2, 1560)

    def test_face_beside_a_narrow_caption_does_not_move_it(self):
        zone = FaceZone(0, 5000, ((0, 1250, 200, 1450),))
        placer = CaptionPlacer([(10**9, 5, 1340)], [zone], OUT_W, OUT_H)
        assert placer(1000, 2000, 400, 135) == (5, 1340)
        assert placer(3000, 4000, 1000, 135) != (5, 1340)


def _ass_with_placer(tmp_path, placer, words=None):
    words = words or [
        TranscriptWord("This", 0, 300), TranscriptWord("is", 300, 500), TranscriptWord("huge.", 500, 900),
        TranscriptWord("Next", 3000, 3300), TranscriptWord("phrase", 3300, 3700), TranscriptWord("here.", 3700, 4000),
    ]
    out = tmp_path / "c.ass"
    asyncio.run(CaptionGeneratorService().generate_captions(
        transcript_segments=[TranscriptSegment(words[0].start_time_ms, words[-1].end_time_ms,
                                               " ".join(w.word for w in words), words=words)],
        clip_start_ms=0, clip_end_ms=6000, output_path=str(out),
        caption_style=get_caption_preset("pop"), anchors=[(10**9, 5, 1340)], placer=placer,
    ))
    return [l for l in out.read_text().splitlines() if l.startswith("Dialogue:")]


class TestCaptionGeneratorPlacement:
    def test_every_event_of_a_group_shares_one_position(self, tmp_path):
        calls = []

        def placer(start, end, w, h):
            calls.append((start, end, w, h))
            return (5, 400) if start < 2000 else (5, 1400)

        events = _ass_with_placer(tmp_path, placer)
        assert len(calls) == 2  # once per word group, not per word or layer
        first, second = calls
        assert first[0] == 0 and first[1] <= 3000 and second[0] == 3000
        assert all(w > 0 and h > 0 for _, _, w, h in calls)
        positions = [POS.search(e).groups() for e in events]
        assert len(events) > 6 and all(positions)
        early = {p for e, p in zip(events, positions) if e.split(",")[1] < "0:00:02.00"}
        late = {p for e, p in zip(events, positions) if e.split(",")[1] >= "0:00:02.00"}
        assert early == {("5", "540", "400")} and late == {("5", "540", "1400")}

    def test_long_words_are_sized_as_two_lines(self):
        gen = CaptionGeneratorService()
        style = get_caption_preset("pop")
        _, short_h = gen._block_size(["We", "made", "it"], style, OUT_W)
        width, long_h = gen._block_size(["INCREDIBLE", "INTERNATIONAL", "OPPORTUNITIES"], style, OUT_W)
        assert long_h > short_h + style.font_size * 0.9
        assert width <= OUT_W


class TestRenderingIntegration:
    @pytest.fixture
    def service(self, monkeypatch):
        monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda self: None)
        return RenderingService()

    def _captions(self, service, tmp_path, plan):
        words = [TranscriptWord("Look", 1000, 1300), TranscriptWord("at", 1300, 1500), TranscriptWord("this.", 1500, 1900)]
        request = RenderRequest(
            video_path="in.mp4", output_path=str(tmp_path / "out.mp4"),
            start_time_ms=0, end_time_ms=10_000, source_width=SRC_W, source_height=SRC_H,
            apply_padding=False,
            transcript_segments=[TranscriptSegment(1000, 1900, "Look at this.", words=words)],
        )
        time_map = TimeMap([(0, 10_000)])
        from clip_engine.services.clip_editor import remap_plan

        path = asyncio.run(service._generate_captions(
            request, OUT_W, OUT_H, 0, time_map, remap_plan(plan, time_map), False, plan,
        ))
        return {POS.search(l).groups() for l in open(path).read().splitlines() if l.startswith("Dialogue:")}

    def test_captions_move_off_a_low_face(self, service, tmp_path):
        face = Box(0.38, 0.35, 0.24, 0.35)
        (position,) = self._captions(service, tmp_path, plan_with(talking_head(face), [face]))
        assert position != ("5", "540", "1340")

    def test_captions_unchanged_without_faces(self, service, tmp_path):
        plan = ClipLayoutPlan([ShotLayout(0, 10_000, LayoutType.SCREEN)], SRC_W, SRC_H)
        assert self._captions(service, tmp_path, plan) == {("2", "540", "1560")}
