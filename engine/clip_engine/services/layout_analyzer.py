"""
Layout Analyzer - decides how each shot of a clip should be framed for 9:16.

For a clip it:
1. Decodes low-res frames (ANALYSIS_FPS) with FFmpeg.
2. Detects faces per frame (OpenCV YuNet) and shot cuts (HSV histogram jumps).
3. Tracks faces within each shot and classifies the shot's layout:
     talking_head  one on-camera person          -> face-tracked full-frame crop
     two_shot      two people side by side       -> stacked split, one per panel
     screen_cam    screen content + webcam overlay -> screen panel over webcam panel
     screen        no usable person on camera    -> fit with blurred background
4. Optionally asks a vision LLM, once per distinct setup, to confirm the
   layout and return the real webcam / screen overlay rectangles. Face boxes
   alone underestimate a webcam overlay by 3-4x, which is what made the old
   split-screen renders look over-zoomed.

Every step degrades gracefully: without OpenCV or the face model the clip
falls back to the classic letterbox render; without the vision model the
heuristic classification is used.
"""

import asyncio
import base64
import json
import logging
import math
import os
import threading
from dataclasses import dataclass, field
from statistics import median
from typing import Any, Optional

import httpx

from clip_engine.config import LayoutStyle, get_settings
from clip_engine.services.media_process import media_process, MediaProcessError, validate_video_dimensions
from clip_engine.services.openrouter import (
    OpenRouterError,
    apply_reasoning,
    chat_completion,
    json_schema_format,
    message_text,
)

logger = logging.getLogger(__name__)

try:
    import cv2
    import numpy as np

    # OpenCV 5's DNN graph engine warns about unsupported targets on every
    # detector creation; it's harmless noise in job logs.
    cv2.utils.logging.setLogLevel(cv2.utils.logging.LOG_LEVEL_ERROR)
except ImportError:  # pragma: no cover - exercised only without the CV extras
    cv2 = None
    np = None


# ------------------------------------------------------------------
# Tunables
# ------------------------------------------------------------------

ANALYSIS_FPS = 4.0
ANALYSIS_WIDTH = 640
KEYFRAME_WIDTH = 768
KEYFRAME_FPS = 1.0
MAX_ANALYSIS_HEIGHT = 1280
MAX_ANALYSIS_DURATION_MS = 60 * 60 * 1000
MAX_ANALYSIS_FRAMES = int(MAX_ANALYSIS_DURATION_MS / 1000 * ANALYSIS_FPS) + 1
MAX_RETAINED_KEYFRAMES = 256
MAX_KEYFRAME_BYTES = 32 * 1024 * 1024
MAX_FACES_PER_FRAME = 32


def analysis_dimensions(width: int, height: int) -> tuple[int, int]:
    validate_video_dimensions(width, height)
    scale = min(ANALYSIS_WIDTH / width, MAX_ANALYSIS_HEIGHT / height)
    return max(2, round(width * scale / 2) * 2), max(2, round(height * scale / 2) * 2)


FACE_SCORE_THRESHOLD = 0.72
# Bhattacharyya distance between consecutive HSV histograms that counts as a cut.
SHOT_CUT_THRESHOLD = 0.42
MIN_SHOT_MS = 1200

# A face track must be visible in this share of a shot's frames to count.
MIN_TRACK_PRESENCE = 0.35
# Faces smaller than this (fraction of frame height) sitting in a corner are
# treated as a webcam overlay rather than an on-camera person.
OVERLAY_MAX_FACE_HEIGHT = 0.17
# Faces smaller than this are ignored entirely (crowds, posters, thumbnails).
MIN_FACE_HEIGHT = 0.035
# Share of a webcam overlay's height its face spans (head-and-shoulders framing).
CAM_FACE_SHARE = 0.28

# Face-tracked crop camera: ignore motion inside this share of the crop
# width, and cap how fast the virtual camera pans (crop widths per second).
CAMERA_DEADZONE = 0.12
CAMERA_MAX_SPEED = 0.9
MAX_PATH_KEYFRAMES = 40


class LayoutType:
    TALKING_HEAD = "talking_head"
    TWO_SHOT = "two_shot"
    SCREEN_CAM = "screen_cam"
    SCREEN = "screen"

    ALL = (TALKING_HEAD, TWO_SHOT, SCREEN_CAM, SCREEN)


# ------------------------------------------------------------------
# Data structures (all boxes normalized to 0-1 of the source frame)
# ------------------------------------------------------------------


@dataclass
class Box:
    x: float
    y: float
    w: float
    h: float

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2

    @property
    def area(self) -> float:
        return self.w * self.h

    def clamp(self) -> "Box":
        w = min(max(self.w, 0.0), 1.0)
        h = min(max(self.h, 0.0), 1.0)
        x = min(max(self.x, 0.0), 1.0 - w)
        y = min(max(self.y, 0.0), 1.0 - h)
        return Box(x, y, w, h)

    def contains(self, px: float, py: float) -> bool:
        return self.x <= px <= self.x + self.w and self.y <= py <= self.y + self.h

    def to_list(self) -> list[float]:
        return [round(self.x, 4), round(self.y, 4), round(self.w, 4), round(self.h, 4)]


@dataclass
class FaceTrack:
    """One person's face across the frames of a shot."""

    samples: list[tuple[int, Box]] = field(default_factory=list)  # (t_ms, box)

    def median_box(self) -> Box:
        return Box(
            median(b.x for _, b in self.samples),
            median(b.y for _, b in self.samples),
            median(b.w for _, b in self.samples),
            median(b.h for _, b in self.samples),
        )


@dataclass
class FrameInfo:
    t_ms: int
    faces: list[Box]
    hist: Any  # np.ndarray


@dataclass
class ShotLayout:
    """How to frame one shot. Times are ms from the start of the render window."""

    start_ms: int
    end_ms: int
    layout: str
    source: str = "heuristic"  # heuristic | vision | style
    # What the shot actually shows, kept when a style overrides the framing
    # (pacing rules depend on content, not on how it is framed).
    detected_layout: Optional[str] = None
    # talking_head: virtual-camera focus path of (t_ms from shot start, cx, cy)
    focus_path: list[tuple[int, float, float]] = field(default_factory=list)
    # two_shot: the two people, left to right
    people: list[Box] = field(default_factory=list)
    # screen_cam
    screen_box: Optional[Box] = None
    # Where the action is inside the screen (active pane, chat, game view).
    screen_focus: Optional[Box] = None
    cam_box: Optional[Box] = None
    cam_face: Optional[Box] = None

    def summary(self) -> dict:
        return {
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "layout": self.layout,
            "source": self.source,
            "screen_box": self.screen_box.to_list() if self.screen_box else None,
            "screen_focus": self.screen_focus.to_list() if self.screen_focus else None,
            "cam_box": self.cam_box.to_list() if self.cam_box else None,
            "people": [p.to_list() for p in self.people],
        }


@dataclass
class ClipLayoutPlan:
    shots: list[ShotLayout]
    source_width: int
    source_height: int
    vision_cost_usd: float = 0.0
    # Every analyzed frame's faces as (t_ms in window time, boxes), including
    # frames without any. Captions use them to stay off faces.
    face_samples: list[tuple[int, list[Box]]] = field(default_factory=list)

    @property
    def dominant_layout(self) -> str:
        if not self.shots:
            return LayoutType.SCREEN
        totals: dict[str, int] = {}
        for s in self.shots:
            totals[s.layout] = totals.get(s.layout, 0) + (s.end_ms - s.start_ms)
        return max(totals, key=totals.get)

    @property
    def is_letterbox_only(self) -> bool:
        return all(s.layout == LayoutType.SCREEN for s in self.shots)


# ------------------------------------------------------------------
# Pure helpers (unit tested)
# ------------------------------------------------------------------


def segment_shots(frames: list[FrameInfo], duration_ms: int) -> list[tuple[int, int]]:
    """Split the timeline into shots at histogram cuts; merge shots < MIN_SHOT_MS."""
    if not frames:
        return [(0, duration_ms)]
    cuts = [0]
    for prev, cur in zip(frames, frames[1:]):
        dist = cv2.compareHist(prev.hist, cur.hist, cv2.HISTCMP_BHATTACHARYYA)
        if dist > SHOT_CUT_THRESHOLD:
            # The cut happened somewhere between the two samples.
            cuts.append((prev.t_ms + cur.t_ms) // 2)
    cuts.append(duration_ms)

    shots = [(a, b) for a, b in zip(cuts, cuts[1:]) if b > a]
    merged: list[tuple[int, int]] = []
    for start, end in shots:
        if merged and (end - start < MIN_SHOT_MS or merged[-1][1] - merged[-1][0] < MIN_SHOT_MS):
            merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))
    return merged


def track_faces(frames: list[FrameInfo]) -> list[FaceTrack]:
    """Greedy nearest-center association of face boxes across frames."""
    tracks: list[FaceTrack] = []
    for frame in frames:
        used: set[int] = set()
        for face in sorted(frame.faces, key=lambda b: -b.area):
            best, best_dist = None, 0.12
            for i, track in enumerate(tracks):
                if i in used:
                    continue
                last = track.samples[-1][1]
                dist = ((last.cx - face.cx) ** 2 + (last.cy - face.cy) ** 2) ** 0.5
                size_ratio = face.h / max(last.h, 1e-6)
                if dist < best_dist and 0.5 < size_ratio < 2.0:
                    best, best_dist = i, dist
            if best is None:
                tracks.append(FaceTrack(samples=[(frame.t_ms, face)]))
                used.add(len(tracks) - 1)
            else:
                tracks[best].samples.append((frame.t_ms, face))
                used.add(best)
    return tracks


def is_corner_overlay(face: Box) -> bool:
    """Small face in a frame corner: almost always a webcam overlay."""
    if face.h > OVERLAY_MAX_FACE_HEIGHT:
        return False
    return (face.cx < 0.3 or face.cx > 0.7) and (face.cy < 0.4 or face.cy > 0.6)


def estimate_cam_box(face: Box, src_w: int, src_h: int) -> Box:
    """Estimate the webcam overlay rectangle around a face.

    Used when the vision model is unavailable. A streaming webcam frames head
    and shoulders with the face spanning ~28% of its height (the old 50%
    guess gave a box a quarter of the overlay's area, and a 5x-upscaled
    crop). The box stays in the face's corner so it never reaches across the
    middle of the frame into screen content.
    """
    cam_h = min(face.h / CAM_FACE_SHARE, 0.45)
    cam_w = min(cam_h * (16 / 9) * (src_h / src_w), 0.4)
    box = Box(face.cx - cam_w / 2, face.cy - cam_h * 0.40, cam_w, cam_h).clamp()
    x0, x1 = (0.5, 1.0) if face.cx >= 0.5 else (0.0, 0.5)
    y0, y1 = (0.5, 1.0) if face.cy >= 0.5 else (0.0, 0.5)
    # Never cut into the face itself, whatever the corner bounds say.
    x0, x1 = min(x0, face.x), max(x1, face.x + face.w)
    y0, y1 = min(y0, face.y), max(y1, face.y + face.h)
    left, top = max(box.x, x0), max(box.y, y0)
    right, bottom = min(box.x + box.w, x1), min(box.y + box.h, y1)
    return Box(left, top, right - left, bottom - top)


def transfer_cam_box(ref_cam: Box, ref_face: Box, face: Box) -> Box:
    """Move/scale a known webcam box to follow its face.

    Streamers resize and reposition webcam overlays mid-shot; the face inside
    moves and scales with the overlay, so the overlay's geometry relative to
    the face carries over.
    """
    scale = face.h / max(ref_face.h, 1e-6)
    return Box(
        face.cx + (ref_cam.x - ref_face.cx) * scale,
        face.cy + (ref_cam.y - ref_face.cy) * scale,
        ref_cam.w * scale,
        ref_cam.h * scale,
    ).clamp()


def _overlay_moved(face: Box, anchor: Box) -> bool:
    ratio = face.h / max(anchor.h, 1e-6)
    return (
        abs(face.cx - anchor.cx) > 0.6 * anchor.w
        or abs(face.cy - anchor.cy) > 0.6 * anchor.h
        or not 0.8 <= ratio <= 1.25
    )


def split_overlay_segments(
    frames: list[FrameInfo],
    shot_start: int,
    shot_end: int,
    seed: Box,
    region: Optional[Box] = None,
) -> list[tuple[int, int, Optional[Box]]]:
    """Split a screen+webcam shot wherever the webcam overlay moves or resizes.

    1. Observe the webcam face per sample: the small face nearest the last one.
       With a known webcam `region` (vision box), any face inside it counts
       too, however large: a close webcam is still the webcam.
    2. Dropouts lasting MIN_SHOT_MS or more are "no webcam" stretches.
    3. A jump in position/size held for 2+ samples starts a new segment.
    Segments shorter than MIN_SHOT_MS are absorbed by their neighbour.

    Returns contiguous (start_ms, end_ms, median face or None) covering the shot.
    """
    max_face_h = OVERLAY_MAX_FACE_HEIGHT * 1.3
    observations: list[tuple[int, Optional[Box]]] = []
    anchor = seed
    for frame in frames:
        candidates = [
            f for f in frame.faces
            if MIN_FACE_HEIGHT <= f.h
            and (f.h <= max_face_h or (region is not None and region.contains(f.cx, f.cy) and f.h <= region.h))
        ]
        face = min(
            candidates,
            key=lambda f: (f.cx - anchor.cx) ** 2 + (f.cy - anchor.cy) ** 2,
            default=None,
        )
        observations.append((frame.t_ms, face))
        if face is not None:
            anchor = face

    # Long dropouts -> no-webcam stretches (index ranges).
    in_gap = [False] * len(observations)
    i = 0
    while i < len(observations):
        if observations[i][1] is not None:
            i += 1
            continue
        j = i
        while j < len(observations) and observations[j][1] is None:
            j += 1
        gap_end = observations[j][0] if j < len(observations) else shot_end
        if gap_end - observations[i][0] >= MIN_SHOT_MS:
            for k in range(i, j):
                in_gap[k] = True
        i = j

    segments: list[list] = []  # [start_ms, faces or None]
    current: Optional[list] = None
    reference: Optional[Box] = None
    pending: list[tuple[int, Box]] = []
    for idx, (t_ms, face) in enumerate(observations):
        if in_gap[idx]:
            if current is None or current[1] is not None:
                current = [t_ms, None]
                segments.append(current)
                pending = []
            continue
        if face is None:
            continue  # brief dropout (hand over face, looking away)
        if current is None or current[1] is None:
            current = [t_ms, [face]]
            segments.append(current)
            reference, pending = face, []
            continue
        if _overlay_moved(face, reference):
            pending.append((t_ms, face))
            if len(pending) >= 2:
                current = [pending[0][0], [f for _, f in pending]]
                segments.append(current)
                reference, pending = pending[-1][1], []
            continue
        pending = []
        current[1].append(face)
        reference = Box(
            reference.x * 0.7 + face.x * 0.3, reference.y * 0.7 + face.y * 0.3,
            reference.w * 0.7 + face.w * 0.3, reference.h * 0.7 + face.h * 0.3,
        )

    if not segments:
        return [(shot_start, shot_end, None)]

    result: list[tuple[int, int, Optional[Box]]] = []
    for i, (seg_start, faces) in enumerate(segments):
        seg_start = shot_start if i == 0 else seg_start
        seg_end = segments[i + 1][0] if i + 1 < len(segments) else shot_end
        face = None
        if faces:
            face = Box(
                median(f.x for f in faces), median(f.y for f in faces),
                median(f.w for f in faces), median(f.h for f in faces),
            )
        if result and seg_end - seg_start < MIN_SHOT_MS:
            prev = result[-1]
            result[-1] = (prev[0], seg_end, prev[2])
        else:
            result.append((seg_start, seg_end, face))
    if len(result) > 1 and result[0][1] - result[0][0] < MIN_SHOT_MS:
        first, second = result[0], result[1]
        result[:2] = [(first[0], second[1], second[2] or first[2])]
    return result


def screen_box_excluding_cam(cam: Box) -> Box:
    """Screen region: the full frame, trimmed away from a side-mounted webcam."""
    # Only trim when the cam spans most of a side; corner cams overlap the
    # screen, which is normal for streams.
    if cam.h > 0.8 and cam.x < 0.05:
        return Box(cam.x + cam.w, 0.0, 1.0 - cam.w, 1.0)
    if cam.h > 0.8 and cam.x + cam.w > 0.95:
        return Box(0.0, 0.0, cam.x, 1.0)
    return Box(0.0, 0.0, 1.0, 1.0)


def classify_shot(
    tracks: list[FaceTrack], shot_frames: int, src_w: int, src_h: int,
) -> tuple[ShotLayout, Optional[FaceTrack]]:
    """Heuristic layout for one shot from its face tracks.

    Returns the layout (times filled in by the caller) and, for talking-head
    shots, the track the camera should follow.
    """
    present = [
        t for t in tracks
        if len(t.samples) >= max(1, MIN_TRACK_PRESENCE * shot_frames)
        and t.median_box().h >= MIN_FACE_HEIGHT
    ]
    present.sort(key=lambda t: -t.median_box().area)

    overlays = [t for t in present if is_corner_overlay(t.median_box())]
    on_camera = [t for t in present if t not in overlays]

    # A webcam that moves mid-shot splits into several short tracks; judge
    # its presence by all corner-overlay faces together.
    if not overlays:
        corner = [t for t in tracks if t.median_box().h >= MIN_FACE_HEIGHT and is_corner_overlay(t.median_box())]
        if sum(len(t.samples) for t in corner) >= MIN_TRACK_PRESENCE * shot_frames:
            overlays = sorted(corner, key=lambda t: -len(t.samples))

    if len(on_camera) >= 2:
        a, b = on_camera[0].median_box(), on_camera[1].median_box()
        similar = min(a.h, b.h) / max(a.h, b.h) >= 0.5
        separated = abs(a.cx - b.cx) >= 0.22
        if len(on_camera) == 2 and similar and separated:
            people = sorted([a, b], key=lambda box: box.cx)
            return ShotLayout(0, 0, LayoutType.TWO_SHOT, people=people), None
        if len(on_camera) > 2:
            return ShotLayout(0, 0, LayoutType.SCREEN), None
    if on_camera:
        main = on_camera[0]
        return ShotLayout(0, 0, LayoutType.TALKING_HEAD, people=[main.median_box()]), main
    if overlays:
        face = overlays[0].median_box()
        cam = estimate_cam_box(face, src_w, src_h)
        return ShotLayout(
            0, 0, LayoutType.SCREEN_CAM,
            cam_box=cam, cam_face=face, screen_box=screen_box_excluding_cam(cam),
        ), None
    return ShotLayout(0, 0, LayoutType.SCREEN), None


def smooth_focus_path(
    samples: list[tuple[int, Box]],
    duration_ms: int,
    crop_w_frac: float,
    step_ms: int = int(1000 / ANALYSIS_FPS),
) -> list[tuple[int, float, float]]:
    """Turn noisy face centers into a calm virtual-camera path.

    Holds still while the subject stays inside a dead zone, then pans with a
    capped speed. Returns keyframes (t_ms, cx, cy) with times relative to the
    first sample's shot start.
    """
    if not samples:
        return []
    samples = sorted(samples, key=lambda s: s[0])

    # Resample onto a regular grid, holding the nearest detection.
    grid: list[tuple[int, float, float]] = []
    j = 0
    for t in range(0, max(duration_ms, 1), step_ms):
        while j + 1 < len(samples) and abs(samples[j + 1][0] - t) <= abs(samples[j][0] - t):
            j += 1
        grid.append((t, samples[j][1].cx, samples[j][1].cy))

    # Median filter to reject single-frame detector jumps.
    k = 2
    xs = [g[1] for g in grid]
    ys = [g[2] for g in grid]
    fx = [median(xs[max(0, i - k): i + k + 1]) for i in range(len(xs))]
    fy = [median(ys[max(0, i - k): i + k + 1]) for i in range(len(ys))]

    deadzone = CAMERA_DEADZONE * crop_w_frac
    max_step = CAMERA_MAX_SPEED * crop_w_frac * step_ms / 1000
    cam_x, cam_y = median(fx[: max(1, 1000 // step_ms)]), median(fy[: max(1, 1000 // step_ms)])
    path = [(0, cam_x, cam_y)]
    for (t, _, _), x, y in zip(grid[1:], fx[1:], fy[1:]):
        dx = x - cam_x
        if abs(dx) > deadzone:
            # Move toward the subject (not all the way: re-center with ease).
            move = max(-max_step, min(max_step, (dx - deadzone * (1 if dx > 0 else -1)) * 0.5))
            cam_x += move
        cam_y += (y - cam_y) * 0.2
        path.append((t, cam_x, cam_y))

    # Keep only keyframes where the camera actually moves.
    keyframes = [path[0]]
    for i in range(1, len(path) - 1):
        prev, cur, nxt = path[i - 1], path[i], path[i + 1]
        moving_before = abs(cur[1] - prev[1]) > 1e-4
        moving_after = abs(nxt[1] - cur[1]) > 1e-4
        if moving_before != moving_after:
            keyframes.append(cur)
    if len(path) > 1:
        keyframes.append(path[-1])

    # Bound expression size for FFmpeg: sample evenly, always keep the last.
    if len(keyframes) > MAX_PATH_KEYFRAMES:
        step = -(-len(keyframes) // MAX_PATH_KEYFRAMES)
        thinned = keyframes[::step]
        if thinned[-1] != keyframes[-1]:
            thinned.append(keyframes[-1])
        keyframes = thinned
    return keyframes


def apply_style(shot: ShotLayout, style: str, src_w: int, src_h: int) -> ShotLayout:
    """Adjust a detected layout to the user's chosen framing style."""
    shot.detected_layout = shot.detected_layout or shot.layout
    if style == LayoutStyle.FIT:
        shot.layout = LayoutType.SCREEN
        shot.source = "style"
    elif style == LayoutStyle.FILL:
        if shot.layout in (LayoutType.TWO_SHOT, LayoutType.SCREEN_CAM, LayoutType.SCREEN):
            focus = shot.people[0] if shot.people else None
            if shot.layout == LayoutType.SCREEN_CAM and shot.cam_face:
                focus = None  # a tiny webcam blown up to full frame looks bad
            shot.layout = LayoutType.TALKING_HEAD
            shot.source = "style"
            if focus and not shot.focus_path:
                shot.focus_path = [(0, focus.cx, focus.cy)]
            elif not shot.focus_path:
                shot.focus_path = [(0, 0.5, 0.5)]
    return shot


# ------------------------------------------------------------------
# Vision refinement
# ------------------------------------------------------------------

VISION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "layout": {"type": "string", "enum": list(LayoutType.ALL)},
        "cam_box": {
            "type": "array", "items": {"type": "integer"},
            "description": "Webcam overlay [ymin, xmin, ymax, xmax] 0-1000, or [] if none.",
        },
        "screen_box": {
            "type": "array", "items": {"type": "integer"},
            "description": "Screen/app content region [ymin, xmin, ymax, xmax] 0-1000, or [] if none.",
        },
        "screen_focus": {
            "type": "array", "items": {"type": "integer"},
            "description": "Most important area inside the screen [ymin, xmin, ymax, xmax] 0-1000, or [] if none.",
        },
        "people": {
            "type": "array",
            "items": {"type": "array", "items": {"type": "integer"}},
            "description": "Head-and-shoulders box [ymin, xmin, ymax, xmax] 0-1000 for each on-camera person (not inside the webcam overlay).",
        },
    },
    "required": ["layout", "cam_box", "screen_box", "screen_focus", "people"],
    "additionalProperties": False,
}

VISION_PROMPT = """You are framing a frame from a video for a 9:16 vertical short.

Classify the frame's layout:
- "talking_head": one person on camera fills a meaningful part of the frame (no screen recording).
- "two_shot": two people on camera, e.g. a podcast wide shot.
- "screen_cam": a screen recording, slides, browser, code or gameplay WITH a webcam overlay of the presenter.
- "screen": screen content, graphics or b-roll with NO webcam overlay, or a crowd/group where no single framing works.

Return boxes as [ymin, xmin, ymax, xmax] integers from 0 to 1000 relative to the full frame:
- cam_box: the ENTIRE webcam overlay rectangle (its visible border/edges, including background around the person), not just the face. [] if there is no webcam overlay.
- screen_box: the region holding the screen/app content, excluding black bars and the webcam overlay if it sits outside the screen. [] if there is no screen content.
- screen_focus: inside screen_box, the area a viewer should see when the screen is cropped for a phone: the active editor/document pane, chat window, chart, or game view. Leave out sidebars, toolbars and empty space. [] if the whole screen matters equally.
- people: one head-and-shoulders box per on-camera person, left to right. Exclude people inside the webcam overlay and people shown inside screen content.

Detected faces (normalized x, y, w, h, may be incomplete): {faces}"""


def _box_from_1000(values: list[int]) -> Optional[Box]:
    if not isinstance(values, list) or len(values) != 4:
        return None
    try:
        ymin, xmin, ymax, xmax = (min(1000, max(0, int(v))) / 1000 for v in values)
    except (TypeError, ValueError):
        return None
    if xmax - xmin < 0.02 or ymax - ymin < 0.02:
        return None
    return Box(xmin, ymin, xmax - xmin, ymax - ymin)


def face_from_person_box(person: Box) -> Box:
    """Approximate the face inside a head-and-shoulders box.

    The renderer sizes crops from face boxes, so vision-model person boxes are
    converted to the same convention.
    """
    face_h = person.h * 0.45
    face_w = person.w * 0.5
    return Box(person.cx - face_w / 2, person.y + person.h * 0.08, face_w, face_h).clamp()


def merge_vision_result(heuristic: ShotLayout, result: dict, src_w: int, src_h: int) -> ShotLayout:
    """Combine the vision model's layout with locally detected faces."""
    layout = result.get("layout")
    if layout not in LayoutType.ALL:
        return heuristic

    cam = _box_from_1000(result.get("cam_box", []))
    screen = _box_from_1000(result.get("screen_box", []))
    people = [face_from_person_box(b) for b in (_box_from_1000(p) for p in result.get("people", [])) if b]
    people.sort(key=lambda b: b.cx)

    merged = ShotLayout(0, 0, layout, source="vision")
    if layout == LayoutType.SCREEN_CAM:
        if cam is None or not (0.01 <= cam.area <= 0.5):
            cam = heuristic.cam_box
        if cam is None:
            merged.layout = LayoutType.SCREEN
            return merged
        merged.cam_box = cam
        merged.screen_box = screen or screen_box_excluding_cam(cam)
        merged.screen_focus = _box_from_1000(result.get("screen_focus", []))
        # Prefer the locally detected face inside the cam for centering.
        face = heuristic.cam_face
        if face is None or not cam.contains(face.cx, face.cy):
            face = next((p for p in heuristic.people if cam.contains(p.cx, p.cy)), None)
        merged.cam_face = face
    elif layout == LayoutType.TWO_SHOT:
        local = heuristic.people if heuristic.layout == LayoutType.TWO_SHOT else []
        merged.people = local if len(local) == 2 else people[:2]
        if len(merged.people) < 2:
            merged.layout = LayoutType.TALKING_HEAD if merged.people else LayoutType.SCREEN
    elif layout == LayoutType.TALKING_HEAD:
        merged.people = heuristic.people[:1] if heuristic.people else people[:1]
        merged.focus_path = heuristic.focus_path
    elif layout == LayoutType.SCREEN:
        merged.screen_box = screen
        merged.screen_focus = _box_from_1000(result.get("screen_focus", []))
    return merged


# ------------------------------------------------------------------
# Service
# ------------------------------------------------------------------


class LayoutAnalyzer:
    """Analyzes a clip's shots and picks a 9:16 framing per shot."""

    def __init__(self):
        self.settings = get_settings()
        # One YuNet detector per executor thread: clips render concurrently,
        # and a shared detector's input size/buffers race (OpenCV 5 asserts).
        self._local = threading.local()
        self._http_client: Optional[httpx.AsyncClient] = None
        # Reuse vision answers across clips of the same video: (hist, face signature, result)
        self._vision_cache: list[tuple[Any, tuple, dict]] = []

    @property
    def available(self) -> bool:
        return cv2 is not None and os.path.isfile(self._model_path())

    def _model_path(self) -> str:
        return os.path.abspath(os.path.join(
            os.path.dirname(__file__), "..", "..", "assets", "models",
            "face_detection_yunet_2023mar.onnx",
        ))

    async def analyze(
        self,
        video_path: str,
        start_ms: int,
        duration_ms: int,
        src_w: int,
        src_h: int,
        style: str = LayoutStyle.AUTO,
        vision: bool = True,
    ) -> Optional[ClipLayoutPlan]:
        """Plan the framing for the render window [start_ms, start_ms + duration_ms).

        `vision=False` skips the paid vision model: heuristics only, used when
        the plan only informs pacing (Classic style, 16:9 output).
        """
        if style == LayoutStyle.FIT:
            return ClipLayoutPlan(
                shots=[ShotLayout(0, duration_ms, LayoutType.SCREEN, source="style")],
                source_width=src_w, source_height=src_h,
            )
        if not self.available:
            logger.warning("Layout analysis unavailable (OpenCV or face model missing); using letterbox")
            return None

        loop = asyncio.get_running_loop()
        frames, keyframes = await loop.run_in_executor(
            None, self._decode_and_detect, video_path, start_ms, duration_ms, src_w, src_h,
        )
        if not frames:
            logger.warning("Layout analysis decoded no frames; using letterbox")
            return None

        crop_w_frac = min(1.0, (src_h * 9 / 16) / src_w)
        shots: list[ShotLayout] = []
        vision_cost = 0.0

        for shot_start, shot_end in segment_shots(frames, duration_ms):
            shot_frames = [f for f in frames if shot_start <= f.t_ms < shot_end]
            tracks = track_faces(shot_frames)
            shot, main_track = classify_shot(tracks, len(shot_frames), src_w, src_h)

            if main_track is not None:
                rel = [(t - shot_start, b) for t, b in main_track.samples]
                shot.focus_path = smooth_focus_path(rel, shot_end - shot_start, crop_w_frac)

            if vision and self._vision_enabled():
                keyframe = self._pick_keyframe(keyframes, (shot_start + shot_end) // 2)
                if keyframe is not None:
                    result, cost = await self._vision_classify(keyframe, shot_frames, shot)
                    vision_cost += cost
                    if result:
                        refined = merge_vision_result(shot, result, src_w, src_h)
                        if refined.layout == LayoutType.TALKING_HEAD and not refined.focus_path:
                            focus = refined.people[0] if refined.people else None
                            refined.focus_path = [(0, focus.cx, focus.cy)] if focus else [(0, 0.5, 0.5)]
                        shot = refined

            shot.start_ms, shot.end_ms = shot_start, shot_end
            if shot.layout == LayoutType.SCREEN_CAM:
                sub_shots = self._follow_webcam(shot, shot_frames, src_w, src_h)
            else:
                sub_shots = [shot]
            shots.extend(apply_style(sub, style, src_w, src_h) for sub in sub_shots)

        shots = self._merge_adjacent(shots)
        plan = ClipLayoutPlan(
            shots=shots, source_width=src_w, source_height=src_h, vision_cost_usd=vision_cost,
            face_samples=[(f.t_ms, f.faces) for f in frames],
        )
        logger.info(
            "Layout plan: " + ", ".join(
                f"{s.layout}[{s.start_ms / 1000:.1f}-{s.end_ms / 1000:.1f}s,{s.source}]" for s in shots
            ) + (f" (vision ${vision_cost:.4f})" if vision_cost else "")
        )
        return plan

    @staticmethod
    def _follow_webcam(
        shot: ShotLayout, frames: list[FrameInfo], src_w: int, src_h: int,
    ) -> list[ShotLayout]:
        """Split a screen+webcam shot where the overlay moves, resizes or disappears."""
        cam = shot.cam_box
        vision = shot.source == "vision"
        seed = shot.cam_face or Box(cam.cx - cam.w * 0.15, cam.cy - cam.h * 0.25, cam.w * 0.3, cam.h * 0.4)
        segments = split_overlay_segments(
            frames, shot.start_ms, shot.end_ms, seed, region=cam if vision else None,
        )

        # The vision model saw the frame at the shot's midpoint; that segment's
        # face anchors its webcam box for the others.
        mid = (shot.start_ms + shot.end_ms) // 2
        ref_face = next((f for a, b, f in segments if a <= mid < b and f), None) or shot.cam_face

        result = []
        for start, end, face in segments:
            if face is None and vision:
                # The vision model saw the webcam; YuNet missing its face
                # (profile, lighting, a big close-up) doesn't remove it.
                result.append(ShotLayout(
                    start, end, LayoutType.SCREEN_CAM, source=shot.source,
                    screen_box=shot.screen_box, screen_focus=shot.screen_focus,
                    cam_box=cam, cam_face=shot.cam_face,
                ))
                continue
            if face is None:
                result.append(ShotLayout(
                    start, end, LayoutType.SCREEN, source=shot.source,
                    screen_box=shot.screen_box, screen_focus=shot.screen_focus,
                ))
                continue
            if vision and ref_face is not None:
                cam_box = transfer_cam_box(cam, ref_face, face)
            elif vision and cam.contains(face.cx, face.cy):
                cam_box = cam
            else:
                cam_box = estimate_cam_box(face, src_w, src_h)
            result.append(ShotLayout(
                start, end, LayoutType.SCREEN_CAM, source=shot.source,
                screen_box=shot.screen_box, screen_focus=shot.screen_focus,
                cam_box=cam_box, cam_face=face,
            ))
        return result

    # -- decoding & detection -------------------------------------------------

    def _decode_and_detect(
        self, video_path: str, start_ms: int, duration_ms: int, src_w: int, src_h: int,
    ) -> tuple[list[FrameInfo], list[tuple[int, bytes]]]:
        width, height = analysis_dimensions(src_w, src_h)
        if not 0 < duration_ms <= MAX_ANALYSIS_DURATION_MS or start_ms < 0:
            raise MediaProcessError("Layout analysis window exceeds supported limits")
        frame_limit = min(MAX_ANALYSIS_FRAMES, math.ceil(duration_ms / 1000 * ANALYSIS_FPS) + 1)
        cmd = [
            "ffmpeg", "-nostdin", "-v", "error",
            "-ss", f"{start_ms / 1000:.3f}",
            "-protocol_whitelist", "file,pipe,fd", "-format_whitelist", "mov,matroska,webm,avi,flv,mpegts", "-i", video_path,
            "-t", f"{duration_ms / 1000:.3f}",
            "-vf", f"fps={ANALYSIS_FPS},scale={width}:{height}",
            "-f", "rawvideo", "-pix_fmt", "bgr24", "-",
        ]
        detector = self._get_detector(width, height)
        frame_bytes = width * height * 3
        frames: list[FrameInfo] = []
        keyframes: list[tuple[int, bytes]] = []
        keyframe_every = max(1, int(round(ANALYSIS_FPS / KEYFRAME_FPS)),
                             math.ceil(frame_limit / MAX_RETAINED_KEYFRAMES))
        keyframe_bytes = 0

        with media_process(cmd, timeout=30 * 60) as (proc, _stderr):
            index = 0
            while True:
                raw = proc.stdout.read(frame_bytes)
                if not raw:
                    break
                if len(raw) != frame_bytes:
                    raise MediaProcessError("Incomplete layout analysis frame")
                if index >= frame_limit:
                    raise MediaProcessError("Layout analysis exceeds the frame limit")
                image = np.frombuffer(raw, np.uint8).reshape(height, width, 3)
                t_ms = int(index * 1000 / ANALYSIS_FPS)

                _, faces = detector.detect(image)
                boxes = []
                candidates = sorted(faces, key=lambda row: float(row[14]), reverse=True)[:MAX_FACES_PER_FRAME] if faces is not None else []
                for row in candidates:
                    if float(row[14]) < FACE_SCORE_THRESHOLD:
                        continue
                    x, y, w, h = (float(v) for v in row[:4])
                    boxes.append(Box(x / width, y / height, w / width, h / height).clamp())

                hsv = cv2.cvtColor(cv2.resize(image, (160, 90)), cv2.COLOR_BGR2HSV)
                hist = cv2.calcHist([hsv], [0, 1], None, [24, 16], [0, 180, 0, 256])
                cv2.normalize(hist, hist)
                frames.append(FrameInfo(t_ms=t_ms, faces=boxes, hist=hist))

                if index % keyframe_every == 0:
                    ok, jpg = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 80])
                    if ok:
                        encoded = jpg.tobytes()
                        if len(encoded) > MAX_KEYFRAME_BYTES - keyframe_bytes:
                            raise MediaProcessError("Layout keyframes exceed the size limit")
                        keyframe_bytes += len(encoded)
                        keyframes.append((t_ms, encoded))
                index += 1
        if proc.returncode:
            raise MediaProcessError("Layout decoding failed")
        return frames, keyframes

    def _get_detector(self, width: int, height: int):
        detector = getattr(self._local, "detector", None)
        if detector is None:
            detector = cv2.FaceDetectorYN.create(
                self._model_path(), "", (width, height), FACE_SCORE_THRESHOLD, 0.3, 50,
            )
            self._local.detector = detector
        detector.setInputSize((width, height))
        return detector

    @staticmethod
    def _pick_keyframe(keyframes: list[tuple[int, bytes]], t_ms: int) -> Optional[bytes]:
        if not keyframes:
            return None
        return min(keyframes, key=lambda k: abs(k[0] - t_ms))[1]

    @staticmethod
    def _merge_adjacent(shots: list[ShotLayout]) -> list[ShotLayout]:
        """Join neighbouring shots that ended up with the same static framing."""
        merged: list[ShotLayout] = []
        for shot in shots:
            prev = merged[-1] if merged else None
            same_static = (
                prev is not None
                and prev.layout == shot.layout
                and shot.layout in (LayoutType.SCREEN, LayoutType.SCREEN_CAM)
                and (shot.layout == LayoutType.SCREEN or (
                    prev.cam_box and shot.cam_box
                    and abs(prev.cam_box.cx - shot.cam_box.cx) < 0.05
                    and abs(prev.cam_box.cy - shot.cam_box.cy) < 0.05
                    and 0.85 <= shot.cam_box.h / max(prev.cam_box.h, 1e-6) <= 1.18
                ))
            )
            if same_static:
                prev.end_ms = shot.end_ms
            else:
                merged.append(shot)
        return merged

    # -- vision ---------------------------------------------------------------

    def _vision_enabled(self) -> bool:
        return bool(self.settings.layout_vision_enabled and self.settings.openrouter_api_key)

    async def _vision_classify(
        self, keyframe: bytes, shot_frames: list[FrameInfo], heuristic: ShotLayout,
    ) -> tuple[Optional[dict], float]:
        """Ask the vision model about one keyframe; cached per visual setup."""
        signature = (heuristic.layout, len(heuristic.people))
        image = cv2.imdecode(np.frombuffer(keyframe, np.uint8), cv2.IMREAD_COLOR)
        hsv = cv2.cvtColor(cv2.resize(image, (160, 90)), cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [24, 16], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        for cached_hist, cached_sig, cached in self._vision_cache:
            if cached_sig == signature and cv2.compareHist(hist, cached_hist, cv2.HISTCMP_BHATTACHARYYA) < 0.2:
                return cached, 0.0

        faces = sorted(
            {tuple(round(v, 3) for v in b.to_list()) for f in shot_frames[:: max(1, len(shot_frames) // 4)] for b in f.faces}
        )[:6]
        payload: dict[str, Any] = {
            "model": self.settings.layout_vision_model,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": VISION_PROMPT.replace("{faces}", json.dumps(faces) or "[]")},
                    {"type": "image_url", "image_url": {
                        "url": "data:image/jpeg;base64," + base64.b64encode(keyframe).decode(),
                    }},
                ],
            }],
            "max_tokens": 4000,
            "response_format": json_schema_format("frame_layout", VISION_SCHEMA),
            "provider": {"require_parameters": True},
        }
        fallbacks = self.settings.get_layout_vision_fallback_models()
        if fallbacks:
            payload["models"] = fallbacks
        apply_reasoning(payload, self.settings.layout_vision_reasoning_effort, temperature=0.0)

        client = await self._get_client()
        for attempt in range(2):
            try:
                body, usage = await chat_completion(client, payload)
                content, _ = message_text(body)
                result = json.loads(content or "")
                self._vision_cache.append((hist, signature, result))
                return result, usage.get("cost") or 0.0
            except OpenRouterError as e:
                if not e.retryable or attempt == 1:
                    logger.warning(f"Layout vision failed, using heuristics: {e}")
                    return None, 0.0
                await asyncio.sleep(1.5)
            except (json.JSONDecodeError, TypeError) as e:
                logger.warning(f"Layout vision returned invalid JSON, using heuristics: {e}")
                return None, 0.0
        return None, 0.0

    async def _get_client(self) -> httpx.AsyncClient:
        if self._http_client is None or self._http_client.is_closed:
            self._http_client = httpx.AsyncClient(
                base_url=self.settings.openrouter_base_url,
                timeout=httpx.Timeout(120.0, connect=20.0),
                headers={
                    "Authorization": f"Bearer {self.settings.openrouter_api_key}",
                    "HTTP-Referer": "https://github.com/bridge-mind/bridgeclip",
                    "X-Title": "BridgeClip AI Clipping Agent",
                },
            )
        return self._http_client

    async def close(self) -> None:
        if self._http_client:
            await self._http_client.aclose()
