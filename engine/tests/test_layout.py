"""
Tests for smart layout analysis (shot/face heuristics, webcam following,
vision merge) and rendering geometry. One test runs FFmpeg on a synthetic
source to prove the generated filter graph is valid.
"""

import os
import shutil
import subprocess
import threading

import numpy as np
import pytest

from clip_engine.config import LayoutStyle
from clip_engine.services.caption_generator import CaptionGeneratorService
from clip_engine.services.layout_analyzer import (
    MAX_PATH_KEYFRAMES,
    Box,
    ClipLayoutPlan,
    FrameInfo,
    LayoutAnalyzer,
    LayoutType,
    ShotLayout,
    apply_style,
    classify_shot,
    estimate_cam_box,
    merge_vision_result,
    segment_shots,
    smooth_focus_path,
    split_overlay_segments,
    track_faces,
    transfer_cam_box,
)
from clip_engine.services.layout_renderer import (
    MAX_UPSCALE,
    build_layout_graph,
    caption_anchor,
    cam_crop,
    panel_fit,
    person_crop,
    piecewise_expr,
    screen_crop,
    shot_chain,
    stacked_panel_heights,
    step_expr,
)
from clip_engine.services.rendering_service import RenderingService

SRC_W, SRC_H = 1920, 1080
TEST_FFMPEG = os.environ.get("TEST_FFMPEG") or shutil.which("ffmpeg")


def encoder_args(binary):
    encoders = subprocess.run([binary, "-hide_banner", "-encoders"], capture_output=True, text=True, check=True).stdout
    if "libx264" in encoders:
        return ["-c:v", "libx264", "-preset", "ultrafast"]
    if "h264_videotoolbox" in encoders:
        return ["-c:v", "h264_videotoolbox", "-allow_sw", "1", "-b:v", "4M"]
    pytest.skip("No H.264 encoder in test FFmpeg")


def hist(seed: int) -> np.ndarray:
    """A normalized 2D histogram; different seeds look like different shots."""
    h = np.zeros((24, 16), np.float32)
    h[seed % 24, seed % 16] = 1.0
    h[(seed * 7) % 24, (seed * 3) % 16] = 0.5
    return h / np.linalg.norm(h)


def frames(duration_ms: int, faces_at, hist_at=lambda t: hist(1), step: int = 250) -> list[FrameInfo]:
    return [FrameInfo(t_ms=t, faces=faces_at(t), hist=hist_at(t)) for t in range(0, duration_ms, step)]


HEAD = Box(0.43, 0.2, 0.14, 0.3)             # on-camera speaker
CAM_FACE = Box(0.84, 0.80, 0.05, 0.09)        # webcam face, bottom-right
CAM_FACE_SMALL = Box(0.88, 0.86, 0.03, 0.055)  # same webcam after shrinking


class TestShotSegmentation:
    def test_detects_cut_and_merges_blips(self):
        # Cut at ~4s; a 0.5s flash at ~8s is too short to be its own shot.
        def hist_at(t):
            if 8000 <= t < 8500:
                return hist(9)
            return hist(1) if t < 4000 else hist(5)
        shots = segment_shots(frames(12000, lambda t: [], hist_at), 12000)
        assert shots[0][0] == 0 and shots[-1][1] == 12000
        assert any(abs(start - 4000) <= 250 for start, _ in shots[1:])
        assert all(end - start >= 1200 for start, end in shots)

    def test_single_shot(self):
        assert segment_shots(frames(5000, lambda t: []), 5000) == [(0, 5000)]


class TestClassification:
    def classify(self, faces):
        fr = frames(4000, lambda t: faces)
        return classify_shot(track_faces(fr), len(fr), SRC_W, SRC_H)

    def test_talking_head(self):
        shot, track = self.classify([HEAD])
        assert shot.layout == LayoutType.TALKING_HEAD
        assert track is not None

    def test_two_shot_orders_left_to_right(self):
        shot, _ = self.classify([Box(0.65, 0.25, 0.12, 0.25), Box(0.2, 0.25, 0.12, 0.25)])
        assert shot.layout == LayoutType.TWO_SHOT
        assert shot.people[0].cx < shot.people[1].cx

    def test_screen_with_webcam(self):
        shot, _ = self.classify([CAM_FACE])
        assert shot.layout == LayoutType.SCREEN_CAM
        assert shot.cam_box.contains(CAM_FACE.cx, CAM_FACE.cy)

    def test_no_faces_is_screen(self):
        shot, _ = self.classify([])
        assert shot.layout == LayoutType.SCREEN

    def test_crowd_falls_back_to_screen(self):
        crowd = [Box(0.1 + 0.3 * i, 0.3, 0.1, 0.2) for i in range(3)]
        shot, _ = self.classify(crowd)
        assert shot.layout == LayoutType.SCREEN

    def test_moving_webcam_still_counts_as_overlay(self):
        # Webcam jumps between two corner positions: two short tracks.
        fr = frames(4000, lambda t: [CAM_FACE if (t // 1000) % 2 else Box(0.08, 0.08, 0.05, 0.09)])
        shot, _ = classify_shot(track_faces(fr), len(fr), SRC_W, SRC_H)
        assert shot.layout == LayoutType.SCREEN_CAM


class TestWebcamFollowing:
    def test_splits_when_overlay_resizes(self):
        fr = frames(8000, lambda t: [CAM_FACE if t < 4000 else CAM_FACE_SMALL])
        segments = split_overlay_segments(fr, 0, 8000, CAM_FACE)
        assert len(segments) == 2
        assert segments[0][0] == 0 and segments[-1][1] == 8000
        assert abs(segments[1][0] - 4000) <= 250
        assert segments[1][2].h < segments[0][2].h

    def test_long_dropout_becomes_no_webcam_segment(self):
        fr = frames(9000, lambda t: [] if 3000 <= t < 6000 else [CAM_FACE])
        segments = split_overlay_segments(fr, 0, 9000, CAM_FACE)
        assert [seg[2] is None for seg in segments] == [False, True, False]

    def test_brief_dropout_is_ignored(self):
        fr = frames(6000, lambda t: [] if 2000 <= t < 2500 else [CAM_FACE])
        assert len(split_overlay_segments(fr, 0, 6000, CAM_FACE)) == 1

    def test_large_face_inside_vision_cam_box_counts(self):
        # A close webcam: the face is too big for the overlay heuristic, but it
        # sits inside the vision model's webcam box.
        cam = Box(0.62, 0.55, 0.36, 0.43)
        big = Box(0.74, 0.62, 0.12, 0.25)
        fr = frames(6000, lambda t: [big])
        assert split_overlay_segments(fr, 0, 6000, big)[0][2] is None
        segments = split_overlay_segments(fr, 0, 6000, big, region=cam)
        assert len(segments) == 1 and segments[0][2] is not None

    def test_vision_screen_cam_survives_missed_face(self):
        cam = Box(0.62, 0.55, 0.36, 0.43)
        shot = ShotLayout(0, 6000, LayoutType.SCREEN_CAM, source="vision", cam_box=cam, screen_box=Box(0, 0, 1, 1))
        subs = LayoutAnalyzer._follow_webcam(shot, frames(6000, lambda t: []), SRC_W, SRC_H)
        assert [s.layout for s in subs] == [LayoutType.SCREEN_CAM]
        assert subs[0].cam_box == cam

    def test_heuristic_screen_cam_without_face_is_screen(self):
        shot = ShotLayout(0, 6000, LayoutType.SCREEN_CAM, cam_box=estimate_cam_box(CAM_FACE, SRC_W, SRC_H),
                          cam_face=CAM_FACE)
        subs = LayoutAnalyzer._follow_webcam(shot, frames(6000, lambda t: []), SRC_W, SRC_H)
        assert [s.layout for s in subs] == [LayoutType.SCREEN]

    def test_estimated_cam_box_covers_the_overlay(self):
        # Face of a real stream's rounded bottom-right webcam (overlay ~0.33 x 0.35).
        face = Box(0.8185, 0.7976, 0.047, 0.084)
        cam = estimate_cam_box(face, SRC_W, SRC_H)
        assert cam.contains(face.cx, face.cy)
        assert cam.x >= 0.5 and cam.y >= 0.5          # stays in its corner
        assert cam.x + cam.w <= 1 and cam.y + cam.h <= 1
        # The old 50%-face guess gave 0.168 x 0.168; the overlay is ~0.33 x 0.35.
        assert cam.h >= 0.28 and cam.area >= 2.5 * 0.168 * 0.168
        assert cam.w <= 0.4 and cam.h <= 0.45

    def test_estimated_cam_box_never_crosses_center(self):
        face = Box(0.66, 0.6, 0.06, 0.16)  # big face near the middle
        cam = estimate_cam_box(face, SRC_W, SRC_H)
        assert cam.x >= 0.5 - 1e-9 and cam.y >= 0.5 - 1e-9
        assert cam.x <= face.x and cam.x + cam.w >= face.x + face.w

    def test_transfer_cam_box_scales_with_face(self):
        ref_cam = Box(0.75, 0.72, 0.22, 0.22)
        moved = transfer_cam_box(ref_cam, CAM_FACE, CAM_FACE_SMALL)
        scale = CAM_FACE_SMALL.h / CAM_FACE.h
        assert moved.h == pytest.approx(ref_cam.h * scale, rel=1e-3)
        assert moved.contains(CAM_FACE_SMALL.cx, CAM_FACE_SMALL.cy)


class TestVisionMerge:
    def test_screen_cam_uses_vision_boxes(self):
        heuristic = ShotLayout(0, 0, LayoutType.SCREEN_CAM, cam_face=CAM_FACE)
        merged = merge_vision_result(heuristic, {
            "layout": "screen_cam",
            "cam_box": [720, 750, 950, 980],
            "screen_box": [0, 0, 1000, 1000],
            "screen_focus": [200, 200, 550, 700],
            "people": [],
        }, SRC_W, SRC_H)
        assert merged.source == "vision"
        assert merged.cam_box.x == pytest.approx(0.75)
        assert merged.screen_focus is not None
        assert merged.cam_face == CAM_FACE

    def test_screen_cam_without_any_cam_box_degrades_to_screen(self):
        merged = merge_vision_result(ShotLayout(0, 0, LayoutType.SCREEN), {
            "layout": "screen_cam", "cam_box": [], "screen_box": [], "screen_focus": [], "people": [],
        }, SRC_W, SRC_H)
        assert merged.layout == LayoutType.SCREEN

    def test_invalid_layout_keeps_heuristic(self):
        heuristic = ShotLayout(0, 0, LayoutType.TALKING_HEAD)
        assert merge_vision_result(heuristic, {"layout": "banana"}, SRC_W, SRC_H) is heuristic

    def test_two_shot_from_vision_people(self):
        merged = merge_vision_result(ShotLayout(0, 0, LayoutType.SCREEN), {
            "layout": "two_shot", "cam_box": [], "screen_box": [], "screen_focus": [],
            "people": [[200, 550, 900, 900], [200, 100, 900, 450]],
        }, SRC_W, SRC_H)
        assert merged.layout == LayoutType.TWO_SHOT
        assert merged.people[0].cx < merged.people[1].cx
        # Person boxes are converted to face-sized boxes for crop sizing.
        assert merged.people[0].h < 0.7 * 0.5


class TestFocusPath:
    def test_still_subject_holds_camera(self):
        samples = [(t, HEAD) for t in range(0, 10000, 250)]
        path = smooth_focus_path(samples, 10000, crop_w_frac=0.316)
        assert len({round(cx, 4) for _, cx, _ in path}) == 1

    def test_moving_subject_pans_with_capped_speed(self):
        samples = [(t, Box(0.2 + 0.5 * t / 10000, 0.2, 0.14, 0.3)) for t in range(0, 10000, 250)]
        path = smooth_focus_path(samples, 10000, crop_w_frac=0.316)
        assert path[-1][1] > path[0][1] + 0.2
        for (t0, x0, _), (t1, x1, _) in zip(path, path[1:]):
            assert abs(x1 - x0) / max((t1 - t0) / 1000, 1e-3) <= 0.9 * 0.316 + 1e-6
        assert len(path) <= MAX_PATH_KEYFRAMES + 1


class TestStyles:
    def test_fill_turns_split_layouts_into_full_frame(self):
        shot = apply_style(ShotLayout(0, 1000, LayoutType.TWO_SHOT, people=[HEAD, HEAD]), LayoutStyle.FILL, SRC_W, SRC_H)
        assert shot.layout == LayoutType.TALKING_HEAD
        assert shot.focus_path

    def test_fit_forces_letterbox(self):
        shot = apply_style(ShotLayout(0, 1000, LayoutType.TALKING_HEAD), LayoutStyle.FIT, SRC_W, SRC_H)
        assert shot.layout == LayoutType.SCREEN


class TestGeometry:
    def test_expressions(self):
        assert piecewise_expr([(0, 100.0)]) == "100.0"
        expr = piecewise_expr([(0, 0.0), (2, 200.0)])
        assert expr.startswith("if(lt(t,2.000),0.0+(200.0)*(t-0.000)/2.000,")
        assert step_expr([3.0], [10, 20]) == "if(lt(t,3.000),10,20)"

    def test_person_crop_stays_on_its_side(self):
        left, right = Box(0.2, 0.25, 0.12, 0.25), Box(0.68, 0.5, 0.12, 0.25)
        mid = (left.cx + right.cx) / 2 * SRC_W
        w, h, x, y = person_crop(right, SRC_W, SRC_H, 1080, 960, (mid, SRC_W))
        assert x >= mid - 2 and x + w <= SRC_W
        # Face kept at or above ~58% of the panel even near the bottom edge.
        assert (right.cy * SRC_H - y) / h <= 0.6
        assert w / h == pytest.approx(1080 / 960, rel=0.02)

    def test_cam_crop_stays_inside_webcam(self):
        cam = Box(0.75, 0.72, 0.22, 0.22)
        w, h, x, y = cam_crop(cam, CAM_FACE, SRC_W, SRC_H, 1080, 960)
        assert x >= cam.x * SRC_W - 2 and x + w <= (cam.x + cam.w) * SRC_W + 2
        assert y >= cam.y * SRC_H - 2 and y + h <= (cam.y + cam.h) * SRC_H + 2

    def test_cam_crop_never_exceeds_max_upscale(self):
        # A small webcam (the old estimate): filling a 1080x960 panel meant 5.3x.
        tiny = Box(0.758, 0.764, 0.168, 0.168)
        rect = cam_crop(tiny, CAM_FACE, SRC_W, SRC_H, 1080, 960)
        fit = panel_fit(rect, 1080, 960)
        assert fit is not None
        assert fit[0] / rect[0] <= MAX_UPSCALE + 0.02 and fit[1] / rect[1] <= MAX_UPSCALE + 0.02
        assert fit[0] <= 1080 and fit[1] <= 960

    def test_big_enough_cam_fills_panel(self):
        cam = Box(0.62, 0.55, 0.36, 0.43)
        rect = cam_crop(cam, None, SRC_W, SRC_H, 1080, 960)
        assert panel_fit(rect, 1080, 960) is None
        assert 1080 / rect[0] <= MAX_UPSCALE

    def test_small_cam_panel_is_letterboxed_over_blur(self):
        shot = ShotLayout(0, 1000, LayoutType.SCREEN_CAM, cam_box=Box(0.758, 0.764, 0.168, 0.168),
                          cam_face=CAM_FACE, screen_box=Box(0, 0, 1, 1))
        chain = shot_chain(0, shot, SRC_W, SRC_H, 1080, 1920)
        assert "gblur" in chain and "[cbg0][cfg0]overlay=" in chain
        assert chain.endswith("vstack=inputs=2,setsar=1[v0]")

    @pytest.mark.parametrize(
        ("cam", "expected_top"),
        [
            (Box(0.62, 0.55, 0.36, 0.43), 1152),  # large webcam: screen 60%, cam 40%
            (Box(0.75, 0.72, 0.22, 0.22), 1304),  # cam height sets the upscale budget
            (Box(0.758, 0.764, 0.168, 0.168), 1344),  # floor at a 30% cam panel
        ],
    )
    def test_screen_cam_split_adapts_to_webcam_size(self, cam, expected_top):
        shot = ShotLayout(0, 1000, LayoutType.SCREEN_CAM, cam_box=cam)
        top_h, bottom_h = stacked_panel_heights(shot, SRC_H, 1920)
        assert (top_h, bottom_h) == (expected_top, 1920 - expected_top)
        assert top_h % 2 == bottom_h % 2 == 0
        assert f"scale=1080:{top_h}:flags=lanczos[top0]" in shot_chain(0, shot, SRC_W, SRC_H, 1080, 1920)
        assert caption_anchor(shot, SRC_W, SRC_H, 1080, 1920) == (5, top_h)

    def test_two_shot_keeps_equal_panels_and_caption_seam(self):
        shot = ShotLayout(0, 1000, LayoutType.TWO_SHOT, people=[HEAD, CAM_FACE])
        assert stacked_panel_heights(shot, SRC_H, 1920) == (960, 960)
        assert caption_anchor(shot, SRC_W, SRC_H, 1080, 1920) == (5, 960)

    def test_adaptive_screen_panel_still_avoids_webcam(self):
        cam = Box(0.75, 0.72, 0.22, 0.22)
        shot = ShotLayout(0, 1000, LayoutType.SCREEN_CAM, cam_box=cam)
        top_h, _ = stacked_panel_heights(shot, SRC_H, 1920)
        w, h, x, y = screen_crop(Box(0, 0, 1, 1), Box(0.3, 0.2, 0.3, 0.4),
                                 SRC_W, SRC_H, 1080, top_h, avoid=cam)
        assert x + w <= (cam.x - 0.15 * cam.w) * SRC_W + 2 or y + h <= (cam.y - 0.15 * cam.h) * SRC_H + 2

    def test_smaller_webcam_fills_adapted_panel_within_upscale_budget(self):
        cam = Box(0.75, 0.72, 0.22, 0.22)
        shot = ShotLayout(0, 1000, LayoutType.SCREEN_CAM, cam_box=cam)
        _, bottom_h = stacked_panel_heights(shot, SRC_H, 1920)
        rect = cam_crop(cam, None, SRC_W, SRC_H, 1080, bottom_h)
        assert panel_fit(rect, 1080, bottom_h) is None
        assert max(1080 / rect[0], bottom_h / rect[1]) <= MAX_UPSCALE * 1.02

    def test_screen_crop_narrows_when_it_cannot_slide(self):
        # Full-height screen crop can't slide clear of a wide right-side webcam.
        cam = Box(0.62, 0.3, 0.36, 0.5)
        w, h, x, y = screen_crop(Box(0, 0, 1, 1), None, SRC_W, SRC_H, 1080, 960, avoid=cam)
        # Keeps a 15%-of-webcam-width margin: overlay boxes are estimates.
        assert x + w <= (cam.x - 0.15 * cam.w) * SRC_W + 2
        assert w / h == pytest.approx(1080 / 960, rel=0.02)
        assert 1080 / w <= MAX_UPSCALE

    def test_screen_crop_covers_focus(self):
        focus = Box(0.3, 0.2, 0.3, 0.4)
        w, h, x, y = screen_crop(Box(0, 0, 1, 1), focus, SRC_W, SRC_H, 1080, 960)
        assert x <= focus.x * SRC_W and x + w >= (focus.x + focus.w) * SRC_W
        assert w / h == pytest.approx(1080 / 960, rel=0.02)

    def test_screen_crop_slides_away_from_webcam(self):
        cam = Box(0.75, 0.72, 0.22, 0.22)
        focus = Box(0.55, 0.3, 0.25, 0.4)  # centered crop would reach the webcam
        w, h, x, y = screen_crop(Box(0, 0, 1, 1), focus, SRC_W, SRC_H, 1080, 960, avoid=cam)
        assert x + w <= (cam.x - 0.15 * cam.w) * SRC_W + 2

    def test_screen_crop_avoids_bottom_center_webcam_vertically(self):
        # Neither side has enough width at MAX_UPSCALE, but the screen above
        # this webcam has enough height for a clean crop.
        cam = Box(0.30, 0.70, 0.40, 0.28)
        w, h, x, y = screen_crop(Box(0, 0, 1, 1), None, SRC_W, SRC_H, 1080, 960, avoid=cam)
        assert y + h <= (cam.y - 0.15 * cam.h) * SRC_H + 2
        assert x >= 0 and x + w <= SRC_W
        assert 1080 / w <= MAX_UPSCALE and 960 / h <= MAX_UPSCALE

    def test_caption_anchor_per_layout(self):
        assert caption_anchor(ShotLayout(0, 1, LayoutType.SCREEN_CAM), SRC_W, SRC_H, 1080, 1920) == (2, 1560)
        assert caption_anchor(ShotLayout(0, 1, LayoutType.TALKING_HEAD), SRC_W, SRC_H, 1080, 1920)[1] > 1200
        align, y = caption_anchor(ShotLayout(0, 1, LayoutType.SCREEN), SRC_W, SRC_H, 1080, 1920)
        assert align == 2 and y > 1920 - 656


def mixed_plan() -> ClipLayoutPlan:
    return ClipLayoutPlan(
        shots=[
            ShotLayout(0, 1000, LayoutType.SCREEN_CAM, cam_box=Box(0.75, 0.72, 0.22, 0.22),
                       cam_face=CAM_FACE, screen_box=Box(0, 0, 1, 1), screen_focus=Box(0.3, 0.2, 0.3, 0.4)),
            ShotLayout(1000, 2000, LayoutType.TALKING_HEAD,
                       focus_path=[(0, 0.3, 0.35), (600, 0.6, 0.35), (1000, 0.6, 0.35)]),
            ShotLayout(2000, 3000, LayoutType.TWO_SHOT,
                       people=[Box(0.2, 0.25, 0.12, 0.25), Box(0.68, 0.3, 0.12, 0.25)]),
            ShotLayout(3000, 4000, LayoutType.SCREEN),
        ],
        source_width=SRC_W,
        source_height=SRC_H,
    )


class TestFilterGraph:
    def test_graph_has_every_shot(self):
        graph = build_layout_graph(mixed_plan(), 1080, 1920)
        assert graph.count("trim=") == 4
        assert "concat=n=4" in graph and graph.endswith("[base]")

    @pytest.mark.skipif(not TEST_FFMPEG, reason="ffmpeg not installed")
    def test_ffmpeg_renders_different_screen_cam_ratios_per_shot(self, tmp_path):
        plan = ClipLayoutPlan(
            shots=[
                ShotLayout(0, 1000, LayoutType.SCREEN_CAM,
                           cam_box=Box(0.60, 0.50, 0.38, 0.45), screen_box=Box(0, 0, 1, 1)),
                ShotLayout(1000, 2000, LayoutType.SCREEN_CAM,
                           cam_box=Box(0.758, 0.764, 0.168, 0.168), screen_box=Box(0, 0, 1, 1)),
            ],
            source_width=640,
            source_height=360,
        )
        graph = build_layout_graph(plan, 360, 640)
        assert "scale=360:384:flags=lanczos[top0]" in graph
        assert "scale=360:448:flags=lanczos[top1]" in graph
        out = tmp_path / "adaptive.mp4"
        subprocess.run([
            TEST_FFMPEG, "-v", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=12:duration=2",
            "-filter_complex", graph, "-map", "[base]",
            *encoder_args(TEST_FFMPEG), str(out),
        ], check=True, capture_output=True)
        probe = subprocess.run([
            os.environ.get("TEST_FFPROBE") or shutil.which("ffprobe") or "ffprobe",
            "-v", "error", "-select_streams", "v:0", "-count_frames",
            "-show_entries", "stream=width,height,nb_read_frames", "-of", "csv=p=0", str(out),
        ], check=True, capture_output=True, text=True).stdout.strip()
        assert tuple(int(value) for value in probe.split(",")) == (360, 640, 60)

    @pytest.mark.skipif(not TEST_FFMPEG, reason="ffmpeg not installed")
    def test_ffmpeg_accepts_graph_and_outputs_vertical(self, tmp_path):
        graph = build_layout_graph(mixed_plan(), 1080, 1920)
        filter_complex, _ = RenderingService._compose_overlays(f"{graph};[base]null[captioned]", [])
        out = tmp_path / "out.mp4"
        subprocess.run([
            TEST_FFMPEG, "-v", "error", "-y",
            "-f", "lavfi", "-i", f"testsrc2=size={SRC_W}x{SRC_H}:rate=30:duration=4",
            "-filter_complex", filter_complex, "-map", "[out]",
            *encoder_args(TEST_FFMPEG), str(out),
        ], check=True, capture_output=True)
        probe = subprocess.run([
            os.environ.get("TEST_FFPROBE") or shutil.which("ffprobe") or "ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
            "-show_entries", "stream=width,height,nb_read_frames", "-of", "csv=p=0", str(out),
        ], check=True, capture_output=True, text=True).stdout.strip()
        width, height, count = (int(v) for v in probe.split(","))
        assert (width, height) == (1080, 1920)
        assert abs(count - 120) <= 2

    def test_audio_chain_pins_stereo_layout(self):
        graph = build_layout_graph(mixed_plan(), 1080, 1920, with_audio=True)
        audio_out = next(p for p in graph.split(";") if p.endswith("[aout]"))
        assert "aformat=" in audio_out and "channel_layouts=stereo" in audio_out

    # Production output options (-pix_fmt yuv420p + AAC). With these, FFmpeg
    # 6.x (the bundled build) failed every non-letterbox graph with "Cannot
    # select channel layout" until the audio chain pinned its layout. Point
    # TEST_FFMPEG at the bundled binary to check it; newer FFmpeg passes anyway.
    @pytest.mark.skipif(not TEST_FFMPEG, reason="ffmpeg not installed")
    @pytest.mark.parametrize("layout", [LayoutType.SCREEN_CAM, LayoutType.TALKING_HEAD])
    def test_ffmpeg_renders_smart_graph_with_audio(self, tmp_path, layout):
        shot = next(s for s in mixed_plan().shots if s.layout == layout)
        shot.start_ms, shot.end_ms = 0, 3000
        plan = ClipLayoutPlan([shot], SRC_W, SRC_H)
        for keeps in (None, [(0, 1200), (1700, 3000)]):
            graph = build_layout_graph(plan, 1080, 1920, keeps, with_audio=True)
            out = tmp_path / "audio.mp4"
            result = subprocess.run([
                TEST_FFMPEG, "-v", "error", "-y",
                "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=3[out0];sine=frequency=440:duration=3[out1]",
                "-filter_complex", f"{graph};[base]null[out]", "-map", "[out]", "-map", "[aout]",
                *encoder_args(TEST_FFMPEG), "-pix_fmt", "yuv420p", "-r", "30",
                "-c:a", "aac", "-b:a", "192k", str(out),
            ], capture_output=True, text=True)
            assert result.returncode == 0, result.stderr[-500:]

    def test_audio_chain_pins_source_layout_before_split(self):
        graph = build_layout_graph(mixed_plan(), 1080, 1920, with_audio=True)
        audio_in = next(p for p in graph.split(";") if p.startswith("[0:a:0]"))
        assert audio_in.startswith("[0:a:0]aformat=") and "channel_layouts=stereo" in audio_in

    # A source whose channel layout is unknown (a plain 2-channel WAV read
    # with -guess_layout_max 0) fails at the concat unless the source is
    # pinned before asplit; the tail pin alone doesn't help. Fails on FFmpeg 9.
    @pytest.mark.skipif(not TEST_FFMPEG, reason="ffmpeg not installed")
    def test_ffmpeg_renders_unknown_layout_audio(self, tmp_path):
        wav = tmp_path / "unknown.wav"
        subprocess.run([
            TEST_FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ac", "2", str(wav),
        ], check=True, capture_output=True)
        shot = next(s for s in mixed_plan().shots if s.layout == LayoutType.SCREEN_CAM)
        shot.start_ms, shot.end_ms = 0, 3000
        graph = build_layout_graph(ClipLayoutPlan([shot], SRC_W, SRC_H), 1080, 1920, [(0, 1200), (1700, 3000)], True)
        result = subprocess.run([
            TEST_FFMPEG, "-v", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=3",
            "-guess_layout_max", "0", "-i", str(wav),
            "-filter_complex", graph.replace("[0:a:0]", "[1:a:0]") + ";[base]null[out]", "-map", "[out]", "-map", "[aout]",
            *encoder_args(TEST_FFMPEG), "-pix_fmt", "yuv420p", "-r", "30",
            "-c:a", "aac", "-b:a", "192k", str(tmp_path / "out.mp4"),
        ], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr[-500:]


class TestCaptionAnchors:
    def test_events_pinned_to_active_layout(self):
        ass = (
            "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
            "Dialogue: 0,0:00:00.50,0:00:01.00,Default,,0,0,0,,HELLO\n"
            "Dialogue: 0,0:00:03.20,0:00:03.60,Default,,0,0,0,,{\\rHighlight}WORLD, AGAIN"
        )
        out = CaptionGeneratorService()._apply_anchors(ass, [(3000, 5, 960), (10**9, 5, 1340)], 1080)
        lines = out.split("\n")
        assert lines[2].endswith(",{\\an5\\pos(540,960)}HELLO")
        assert lines[3].endswith(",{\\an5\\pos(540,1340)}{\\rHighlight}WORLD, AGAIN")


class TestOverlays:
    def test_compose_chains_overlays_in_input_order(self):
        graph, inputs = RenderingService._compose_overlays(
            "[0:v]null[captioned]", [("title.png", "(W-w)/2", "110"), ("banner.png", "(W-w)/2", "1590")],
        )
        assert inputs == ["title.png", "banner.png"]
        assert "[captioned][1:v]overlay" in graph and "[ov1][2:v]overlay" in graph
        assert graph.endswith("[out]")


class TestDetector:
    @pytest.mark.skipif(not LayoutAnalyzer().available, reason="OpenCV or YuNet model missing")
    def test_one_detector_per_thread(self):
        # Clips render concurrently; a shared YuNet detector races on its input
        # size and buffers.
        analyzer = LayoutAnalyzer()
        own = analyzer._get_detector(640, 360)
        assert analyzer._get_detector(640, 360) is own
        other = []
        thread = threading.Thread(target=lambda: other.append(analyzer._get_detector(640, 480)))
        thread.start()
        thread.join()
        assert other and other[0] is not own
