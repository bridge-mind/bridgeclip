"""
Rendering Service - FFmpeg rendering with smart framing, pacing and captions.

render_clip pipeline:
  1. Layout plan (9:16): per-shot framing from LayoutAnalyzer.
  2. Pacing: keep intervals from ClipEditor (tight pacing cuts dead air/fillers).
  3. One filter graph: video and audio edited on the same presentation clock.
  4. Captions and title/banner overlays remapped onto the edited timeline.
"""

import asyncio
import copy
import json
import logging
import math
import os
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Optional, Union

from PIL import Image, ImageDraw, ImageFont

from clip_engine.config import CaptionStyle, LayoutStyle, get_landscape_dimensions, get_output_dimensions, get_settings
from clip_engine.services.caption_generator import CaptionGeneratorService
from clip_engine.services.clip_editor import (
    Pacing,
    TimeMap,
    compute_keep_intervals,
    reaction_intervals,
    remap_plan,
    remap_segments,
    subtract_intervals,
    window_words,
)
from clip_engine.services.layout_analyzer import ClipLayoutPlan, LayoutAnalyzer, LayoutType, ShotLayout
from clip_engine.services.media_process import MEDIA_INPUT_OPTIONS, PROBE_TIMEOUT_SECONDS, media_process, run_media, validate_video_dimensions
from clip_engine.services.layout_renderer import (
    AUDIO_FORMAT,
    AUDIO_SYNC,
    CaptionPlacer,
    banner_y,
    build_layout_graph,
    caption_anchor,
    face_zones,
    measured_loudness_filter,
    per_shot_expr,
    title_y,
)
from clip_engine.services.transcription_service import TranscriptSegment
from clip_engine.services.video_speed import scaled_duration_ms, speed_video_filter, validate_video_speed

logger = logging.getLogger(__name__)

# (png_path, x_expr, y_expr) for an image composited over the video, or
# (png_path, x_expr, y_expr, enable_expr, image_filter) for one shown only
# while enable_expr holds, with image_filter (e.g. alpha fades) applied first.
Overlay = Union[tuple[str, str, str], tuple[str, str, str, str, str]]

# Landscape title card: on screen for the opening seconds only (a title
# pinned over a 15 minute episode just covers the video).
LANDSCAPE_TITLE_SHOW_S = (0.4, 5.5)
LANDSCAPE_TITLE_FADE_S = 0.4
# Output frame rates a landscape render keeps from its source (higher is capped).
MAX_OUTPUT_FPS = 60
# Landscape H.264 bitrates (Mbps) by output height at 30 fps, after
# YouTube's upload recommendations; 60 fps sources get 1.5x.
LANDSCAPE_BITRATE_MBPS = {1080: 12, 1440: 20, 2160: 45}
# Leave room for input/output paths and codec options below Windows' process
# command-line limit. Long edits can contain hundreds of trims and concats.
MAX_INLINE_FILTER_GRAPH_BYTES = 8192


@dataclass
class RenderRequest:
    """Request for rendering a clip."""

    video_path: str
    output_path: str
    start_time_ms: int
    end_time_ms: int
    source_width: int
    source_height: int

    # Word timings drive tight pacing as well as captions, so they are passed
    # even when captions are off.
    transcript_segments: Optional[list[TranscriptSegment]] = None
    include_captions: bool = True
    caption_style: Optional[CaptionStyle] = None

    title_text: Optional[str] = None
    # Planner-chosen punch words highlighted in the captions.
    emphasis_words: list[str] = field(default_factory=list)

    banner_platform: Optional[str] = None
    banner_channel_url: Optional[str] = None

    include_audio: bool = True
    apply_padding: bool = True
    aspect_ratio: str = "9:16"
    # Framing for 9:16 output: auto (smart per-shot), fill or fit.
    layout_style: str = LayoutStyle.AUTO
    # tight: cut dead air and filler words; natural: original timing.
    pacing: str = Pacing.TIGHT
    video_speed: float = 1.0
    # Longform episode (16:9, 5+ min): gentler pacing, SRT sidecar, and the
    # planner's skips (source ms, cut at any pacing) and chapters (source ms).
    longform: bool = False
    skip_ranges_ms: list[tuple[int, int]] = field(default_factory=list)
    chapters: list[tuple[int, str]] = field(default_factory=list)


@dataclass
class RenderResult:
    """Result of rendering operation."""

    output_path: str
    file_size_bytes: int
    duration_ms: int  # of the rendered file, after pacing cuts and speed
    removed_ms: int = 0  # dead air / fillers cut by tight pacing
    layout_type: str = "fit"
    layout_shots: list[dict] = field(default_factory=list)
    layout_cost_usd: float = 0.0
    # Which fallback produced the file: None (as planned), "letterbox" (smart
    # framing dropped, pacing kept) or "letterbox_natural" (both dropped).
    render_fallback: Optional[str] = None
    # Chapters as (output ms, title) on the edited timeline.
    chapters: list[tuple[int, str]] = field(default_factory=list)
    # SRT sidecar for longform clips, next to the clip.
    subtitle_path: Optional[str] = None
    output_width: int = 0
    output_height: int = 0


class RenderingService:
    """
    Service for rendering clips using FFmpeg.

    Renders 9:16 vertical clips with per-shot smart framing (speaker crop,
    stacked splits, screen + webcam, or letterbox) and ASS caption burning.
    """

    def __init__(self):
        self.settings = get_settings()
        self.caption_generator = CaptionGeneratorService()
        self.layout_analyzer = LayoutAnalyzer()
        self._verify_ffmpeg()
        self._font_path = self._resolve_font()
        self._fonts_dir = self._resolve_fonts_dir()

    def _resolve_font(self) -> str:
        """Find Montserrat Black font, falling back to ExtraBold then Liberation Sans Bold."""
        candidates = [
            os.path.join(os.path.dirname(__file__), "..", "..", "assets", "fonts", "Montserrat-Black.ttf"),
            os.path.join("/app", "assets", "fonts", "Montserrat-Black.ttf"),
            os.path.join(os.path.dirname(__file__), "..", "..", "assets", "fonts", "Montserrat-ExtraBold.ttf"),
            os.path.join("/app", "assets", "fonts", "Montserrat-ExtraBold.ttf"),
            "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        ]
        for p in candidates:
            resolved = os.path.abspath(p)
            if os.path.isfile(resolved):
                logger.info(f"Using font: {resolved}")
                return resolved
        return "Sans"

    @staticmethod
    def _resolve_fonts_dir() -> Optional[str]:
        """Bundled caption fonts. libass only sees fonts it is pointed at: without
        this, captions fall back to a system face (Helvetica, DejaVu) whatever
        the preset asks for."""
        for p in (
            os.path.join(os.path.dirname(__file__), "..", "..", "assets", "fonts"),
            os.path.join("/app", "assets", "fonts"),
        ):
            resolved = os.path.abspath(p)
            if os.path.isdir(resolved):
                return resolved
        logger.warning("Caption fonts directory not found; captions will use system fonts")
        return None

    def _verify_ffmpeg(self):
        """Verify ffmpeg is available."""
        if not shutil.which("ffmpeg"):
            raise RuntimeError("ffmpeg not found in PATH")
        logger.info("FFmpeg available")

    def _video_codec_args(self, out_w: int = 1080, out_h: int = 1920, fps: str = "30") -> list[str]:
        """Use the LGPL macOS encoder in BridgeClip; retain server encoding.

        Keyframes every 2 s keep long clips seekable. Landscape bitrates scale
        with resolution and frame rate (VideoToolbox is bitrate-driven).
        """
        rate = float(Fraction(fps))
        gop = ["-g", str(max(1, round(rate * 2)))]
        if self.settings.local_mode and sys.platform == "darwin":
            if out_w > out_h:
                mbps = LANDSCAPE_BITRATE_MBPS.get(out_h, 12) * (1.5 if rate > 31 else 1)
                return ["-c:v", "h264_videotoolbox", "-profile:v", "high", "-b:v", f"{mbps:g}M", *gop]
            return ["-c:v", "h264_videotoolbox", "-b:v", "8M", *gop]
        return ["-c:v", "libx264", "-preset", self.settings.ffmpeg_preset,
                "-crf", str(self.settings.ffmpeg_crf), *gop]

    async def render_clip(self, request: RenderRequest) -> RenderResult:
        """
        Render a clip in the requested aspect ratio.

        9:16 (vertical): Smart framing per shot (see LayoutAnalyzer), or the
            blurred-background letterbox for the "fit" style / as a fallback.
        16:9 (landscape): Whole frame at the source's resolution (1080p-4K)
            and frame rate, over a blurred fill when the source isn't 16:9.
        """
        validate_video_speed(request.video_speed)
        os.makedirs(os.path.dirname(request.output_path), exist_ok=True)

        duration_ms = request.end_time_ms - request.start_time_ms
        if duration_ms <= 0:
            raise RenderingError("Invalid clip duration")

        is_landscape = request.aspect_ratio == "16:9"

        source_w = request.source_width
        source_h = request.source_height

        actual_width, actual_height = await self._get_video_dimensions(request.video_path)
        if actual_width > 0 and actual_height > 0:
            source_w = actual_width
            source_h = actual_height

        if is_landscape:
            target_width, target_height = get_landscape_dimensions(source_w, source_h)
            fps = await self._probe_fps(request.video_path)
        else:
            target_width, target_height = get_output_dimensions(request.aspect_ratio)
            fps = "30"

        logger.info(
            f"Rendering clip: {request.start_time_ms}ms-{request.end_time_ms}ms, "
            f"output={target_width}x{target_height}@{fps} ({request.aspect_ratio}"
            f"{', longform' if request.longform else ''}), include_audio={request.include_audio}"
        )

        if request.apply_padding:
            window_start_ms, window_ms = self._compute_padded_range(request.start_time_ms, duration_ms)
        else:
            window_start_ms, window_ms = request.start_time_ms, duration_ms

        plan: Optional[ClipLayoutPlan] = None
        if not is_landscape:
            plan = await self._plan_layout(request, source_w, source_h, window_start_ms, window_ms)
        analyzed = plan is not None
        # Pacing needs to know what's on screen even when the framing doesn't
        # use it (Classic style, 16:9 output): a silent screen demo isn't dead air.
        pacing_plan = plan
        if pacing_plan is None and (is_landscape or request.layout_style == LayoutStyle.FIT) and self._paces(request):
            pacing_plan = await self._content_plan(request, source_w, source_h, window_start_ms, window_ms)
        # Faces seen while analyzing, kept by every fallback so captions still
        # stay off them.
        face_samples = pacing_plan.face_samples if pacing_plan is not None else []
        if plan is None:
            plan = ClipLayoutPlan(
                shots=[ShotLayout(0, window_ms, LayoutType.SCREEN, source="style")],
                source_width=source_w, source_height=source_h, face_samples=face_samples,
            )

        skips = self._window_skips(request, window_start_ms, window_ms)
        keeps = self._keep_intervals(request, pacing_plan, window_start_ms, window_ms)
        time_map = TimeMap(subtract_intervals(keeps, skips), window_ms)
        # Natural timing still honours the planner's skips: they're edit
        # decisions, not pacing.
        natural_map = TimeMap(subtract_intervals([(0, window_ms)], skips), window_ms)
        smart = analyzed and not plan.is_letterbox_only
        vision_cost = plan.vision_cost_usd if analyzed else 0.0

        # Longform audio gets two-pass (linear) loudness normalization.
        loudness_filter = None
        if request.longform and request.include_audio and await self._has_audio(request.video_path):
            loudness_filter = await self._measure_loudness(request.video_path, window_start_ms, window_ms)

        # A layout or pacing edge case must not cost the clip. Fallback ladder:
        # as planned -> letterbox with the same cuts -> letterbox at natural
        # timing (a pacing edge case can be what failed, so cuts go last).
        letterbox = ClipLayoutPlan(
            shots=[ShotLayout(0, window_ms, LayoutType.SCREEN, source="fallback")],
            source_width=source_w, source_height=source_h, face_samples=face_samples,
        )
        ladder: list[tuple[ClipLayoutPlan, TimeMap, Optional[str]]] = [(plan, time_map, None)]
        if smart:
            ladder.append((letterbox, time_map, "letterbox"))
        if time_map.keeps != natural_map.keeps:
            ladder.append((letterbox, natural_map, "letterbox_natural"))

        render_fallback: Optional[str] = None
        for step, (step_plan, step_map, fallback) in enumerate(ladder):
            try:
                await self._render_edit(
                    request, step_plan, step_map, window_start_ms, window_ms,
                    target_width, target_height, is_landscape, fps, loudness_filter,
                )
            except Exception as e:
                # Any failure (FFmpeg, or a bug building the graph, captions or
                # overlays) moves down the ladder; only the last step raises.
                if step == len(ladder) - 1:
                    raise
                logger.warning(
                    f"Render failed, retrying as {ladder[step + 1][2]}: {e}",
                    exc_info=not isinstance(e, RenderingError),
                )
                continue
            plan, time_map, render_fallback = step_plan, step_map, fallback
            break
        if render_fallback:
            smart, analyzed = False, False

        file_size = os.path.getsize(request.output_path)
        removed_ms = time_map.removed_ms
        chapters = self._output_chapters(request, window_start_ms, time_map)
        subtitle_path = await self._write_subtitles(request, window_start_ms, time_map)
        logger.info(
            f"Clip rendered: {request.output_path} ({file_size / 1024 / 1024:.1f} MB, "
            f"{scaled_duration_ms(time_map.output_ms, request.video_speed) / 1000:.1f}s at {request.video_speed:g}x"
            + (f", pacing removed {removed_ms / 1000:.1f}s in {time_map.cut_count} cuts" if removed_ms else "")
            + (f", fallback={render_fallback}" if render_fallback else "")
            + ")"
        )
        return RenderResult(
            output_path=request.output_path,
            file_size_bytes=file_size,
            duration_ms=scaled_duration_ms(time_map.output_ms, request.video_speed),
            removed_ms=removed_ms,
            layout_type=plan.dominant_layout if smart else "fit",
            layout_shots=[shot.summary() for shot in plan.shots] if analyzed else [],
            # Vision calls made for the plan are paid for even if a fallback rendered.
            layout_cost_usd=vision_cost,
            render_fallback=render_fallback,
            chapters=chapters,
            subtitle_path=subtitle_path,
            output_width=target_width,
            output_height=target_height,
        )

    @staticmethod
    def _window_skips(request: RenderRequest, window_start_ms: int, window_ms: int) -> list[tuple[int, int]]:
        """The planner's skips in window time, clipped to the window."""
        skips = []
        for start, end in request.skip_ranges_ms:
            s, e = max(0, start - window_start_ms), min(window_ms, end - window_start_ms)
            if e > s:
                skips.append((s, e))
        return skips

    @staticmethod
    def _output_chapters(
        request: RenderRequest, window_start_ms: int, time_map: TimeMap,
    ) -> list[tuple[int, str]]:
        """Chapters moved onto the edited timeline; the first starts at 0."""
        chapters: list[tuple[int, str]] = []
        for t_ms, title in request.chapters:
            out = scaled_duration_ms(time_map.to_output_clamped(max(0, t_ms - window_start_ms)), request.video_speed)
            if chapters and out - chapters[-1][0] < 10_000:
                continue  # YouTube needs 10 s+ per chapter
            if out < scaled_duration_ms(time_map.output_ms, request.video_speed) - 10_000:
                chapters.append((out, title))
        if chapters:
            chapters[0] = (0, chapters[0][1])
        return chapters

    async def _write_subtitles(
        self, request: RenderRequest, window_start_ms: int, time_map: TimeMap,
    ) -> Optional[str]:
        """SRT sidecar on the edited timeline, for longform uploads."""
        if not (request.longform and request.transcript_segments):
            return None
        try:
            segments = remap_segments(request.transcript_segments, window_start_ms, time_map)
            for segment in segments:
                for item in [segment, *segment.words]:
                    item.start_time_ms = window_start_ms + scaled_duration_ms(item.start_time_ms - window_start_ms, request.video_speed)
                    item.end_time_ms = max(item.start_time_ms + 1, window_start_ms + scaled_duration_ms(item.end_time_ms - window_start_ms, request.video_speed))
            path = os.path.splitext(request.output_path)[0] + ".srt"
            return self.caption_generator.generate_srt(
                segments, window_start_ms, window_start_ms + scaled_duration_ms(time_map.output_ms, request.video_speed), path,
            )
        except Exception as e:
            logger.warning(f"Subtitle sidecar failed; the clip is unaffected: {e}")
            return None

    async def _render_edit(
        self,
        request: RenderRequest,
        plan: ClipLayoutPlan,
        time_map: TimeMap,
        window_start_ms: int,
        window_ms: int,
        target_width: int,
        target_height: int,
        is_landscape: bool,
        fps: str = "30",
        loudness_filter: Optional[str] = None,
    ) -> None:
        """Build the graph, captions and overlays for one edit and run FFmpeg."""
        has_audio = request.include_audio and await self._has_audio(request.video_path)
        graph = build_layout_graph(
            plan, target_width, target_height, time_map.keeps, has_audio, landscape=is_landscape,
            fps=fps, loudness_filter=loudness_filter,
            video_speed=request.video_speed,
        )
        out_plan = remap_plan(plan, time_map)
        caption_path = await self._generate_captions(
            request, target_width, target_height, window_start_ms, time_map, out_plan, is_landscape, plan,
        )
        graph += f";[base]{self._caption_filter(caption_path)}[captioned]"
        overlays = self._overlays(request, out_plan, target_width, target_height, is_landscape)
        # Burn captions and animate framing/overlays on the edited source clock,
        # then speed up the entire composited picture to match the tempo audio.
        filter_complex, extra_inputs = self._compose_overlays(
            graph, overlays, speed_video_filter(request.video_speed, fps),
        )

        try:
            await self._run_ffmpeg_complex(
                input_path=request.video_path,
                output_path=request.output_path,
                start_time_ms=window_start_ms,
                duration_ms=window_ms,
                filter_complex=filter_complex,
                audio_label="[aout]" if has_audio else None,
                extra_inputs=extra_inputs if extra_inputs else None,
                fps=fps,
                output_size=(target_width, target_height),
                output_duration_ms=scaled_duration_ms(time_map.output_ms, request.video_speed),
            )
        finally:
            for path in extra_inputs:
                try:
                    os.remove(path)
                except OSError:
                    pass

        if not os.path.isfile(request.output_path):
            raise RenderingError("Render failed: output file not created")

    async def _plan_layout(
        self,
        request: RenderRequest,
        source_w: int,
        source_h: int,
        window_start_ms: int,
        window_ms: int,
    ) -> Optional[ClipLayoutPlan]:
        """Analyze the render window's shots. None means use the letterbox."""
        if request.layout_style == LayoutStyle.FIT:
            return None
        try:
            return await self.layout_analyzer.analyze(
                request.video_path, window_start_ms, window_ms, source_w, source_h, request.layout_style,
            )
        except Exception as e:
            logger.warning(f"Layout analysis failed, falling back to letterbox: {e}", exc_info=True)
            return None

    async def _content_plan(
        self,
        request: RenderRequest,
        source_w: int,
        source_h: int,
        window_start_ms: int,
        window_ms: int,
    ) -> Optional[ClipLayoutPlan]:
        """Heuristic shot analysis for pacing only (no paid vision call). None if unavailable."""
        try:
            return await self.layout_analyzer.analyze(
                request.video_path, window_start_ms, window_ms, source_w, source_h, LayoutStyle.AUTO, vision=False,
            )
        except Exception as e:
            logger.warning(f"Content analysis for pacing failed; using the default pause limit: {e}", exc_info=True)
            return None

    @staticmethod
    def _paces(request: RenderRequest) -> bool:
        """Whether tight pacing will cut anything (it needs word timings)."""
        return request.pacing == Pacing.TIGHT and bool(request.transcript_segments)

    @staticmethod
    def _keep_intervals(
        request: RenderRequest,
        plan: Optional[ClipLayoutPlan],
        window_start_ms: int,
        window_ms: int,
    ) -> list[tuple[int, int]]:
        """Window intervals to keep. `plan` is None when shot content is unknown."""
        if not RenderingService._paces(request):
            return [(0, window_ms)]
        words = window_words(request.transcript_segments, window_start_ms, window_ms)
        protected = reaction_intervals(request.transcript_segments, window_start_ms, window_ms)
        return compute_keep_intervals(words, window_ms, plan, protected, longform=request.longform)

    def _overlays(
        self,
        request: RenderRequest,
        out_plan: ClipLayoutPlan,
        target_width: int,
        target_height: int,
        is_landscape: bool,
    ) -> list[Overlay]:
        """Title card and channel banner, positioned per shot on the output timeline."""
        src_w, src_h = out_plan.source_width, out_plan.source_height
        overlays: list[Overlay] = []
        # Landscape overlays were sized for 1080p; scale them with the output.
        scale = target_height / 1080 if is_landscape else 1.0
        title = self._title_overlay_image(request, target_width, scale)
        if title:
            path, _, height = title
            if is_landscape:
                show_from, show_to = LANDSCAPE_TITLE_SHOW_S
                fade = LANDSCAPE_TITLE_FADE_S
                overlays.append((
                    path, "(W-w)/2", f"{round(40 * scale)}",
                    f"between(t,{show_from},{show_to})",
                    f"format=rgba,fade=t=in:st={show_from}:d={fade}:alpha=1,"
                    f"fade=t=out:st={show_to - fade}:d={fade}:alpha=1",
                ))
            else:
                overlays.append((path, "(W-w)/2", per_shot_expr(out_plan, [
                    title_y(s, src_w, src_h, target_width, target_height, height) for s in out_plan.shots
                ])))
        banner = self._banner_overlay_image(request, round(28 * scale) if is_landscape else 34)
        if banner:
            if is_landscape:
                overlays.append((banner[0], f"W-w-{round(20 * scale)}", f"H-h-{round(16 * scale)}"))
            else:
                overlays.append((banner[0], "(W-w)/2", per_shot_expr(out_plan, [
                    banner_y(s, src_w, src_h, target_width, target_height) for s in out_plan.shots
                ])))
        return overlays

    def _caption_filter(self, caption_path: Optional[str]) -> str:
        """`ass=` filter for the caption file, or a no-op."""
        if caption_path and os.path.isfile(caption_path):
            ass = f"ass={self._escape_filter_path(caption_path)}"
            if self._fonts_dir:
                ass += f":fontsdir={self._escape_filter_path(self._fonts_dir)}"
            return ass
        return "null"

    @staticmethod
    def _compose_overlays(graph: str, overlays: list[Overlay], video_filter: str = "null") -> tuple[str, list[str]]:
        """Append image overlays to a graph ending in [captioned]; output is [out].

        Returns the full filter_complex and the extra input paths, in input
        order (the video is input 0, overlays follow).
        """
        if not overlays:
            return f"{graph};[captioned]{video_filter}[out]", []
        parts = [graph]
        current = "captioned"
        for index, overlay in enumerate(overlays, start=1):
            _, x_expr, y_expr = overlay[:3]
            label = "composited" if index == len(overlays) else f"ov{index}"
            image, enable = f"[{index}:v]", ""
            if len(overlay) == 5:
                enable_expr, image_filter = overlay[3], overlay[4]
                parts.append(f"[{index}:v]{image_filter}[img{index}]")
                image, enable = f"[img{index}]", f":enable='{enable_expr}'"
            parts.append(
                f"[{current}]{image}overlay=x='{x_expr}':y='{y_expr}':shortest=1{enable}[{label}]"
            )
            current = label
        parts.append(f"[composited]{video_filter}[out]")
        return ";".join(parts), [overlay[0] for overlay in overlays]

    def _title_overlay_image(
        self, request: RenderRequest, target_width: int, scale: float = 1.0,
    ) -> Optional[tuple[str, int, int]]:
        """Render the title card PNG. Returns (path, width, height) or None."""
        if not request.title_text:
            return None
        path = os.path.join(
            os.path.dirname(request.output_path),
            f"title-{request.start_time_ms}-{request.end_time_ms}.png",
        )
        result = self._build_title_card(request.title_text, target_width, 0, path, scale)
        if not result:
            return None
        return path, result["width"], result["height"]

    async def _generate_captions(
        self,
        request: RenderRequest,
        target_width: int,
        target_height: int,
        window_start_ms: int,
        time_map: TimeMap,
        out_plan: ClipLayoutPlan,
        is_landscape: bool,
        plan: Optional[ClipLayoutPlan] = None,
    ) -> Optional[str]:
        """ASS captions on the edited timeline, positioned per shot (9:16).

        With the window-time `plan`, each caption group also moves off any
        face it would cover (see CaptionPlacer).
        """
        if not (request.include_captions and request.transcript_segments):
            return None
        segments = remap_segments(request.transcript_segments, window_start_ms, time_map)
        if not segments:
            return None

        anchors = None
        if not is_landscape:
            src_w, src_h = out_plan.source_width, out_plan.source_height
            anchors = []
            for shot in out_plan.shots:
                alignment, y = caption_anchor(shot, src_w, src_h, target_width, target_height)
                anchors.append((shot.end_ms, alignment, y))
            anchors[-1] = (10**9, anchors[-1][1], anchors[-1][2])

        placer = None
        if anchors and plan is not None:
            zones = face_zones(plan, time_map, target_width, target_height)
            if zones:
                placer = CaptionPlacer(anchors, zones, target_width, target_height)

        caption_path = os.path.join(
            os.path.dirname(request.output_path),
            f"clip-{request.start_time_ms}-{request.end_time_ms}.ass",
        )
        style = request.caption_style
        if is_landscape:
            style = self._landscape_caption_style(style or self.settings.get_caption_style(), target_height)
        return await self.caption_generator.generate_captions(
            transcript_segments=segments,
            clip_start_ms=window_start_ms,
            clip_end_ms=window_start_ms + time_map.output_ms,
            output_path=caption_path,
            caption_style=style,
            output_width=target_width,
            output_height=target_height,
            anchors=anchors,
            emphasis_words=request.emphasis_words,
            placer=placer,
        )

    # Pixel-sized caption style fields, scaled together for landscape output.
    _CAPTION_PIXEL_FIELDS = (
        "font_size", "outline_width", "shadow_blur", "shadow_offset", "shadow_spread",
        "highlight_box_padding", "glow_radius", "glow_blur", "line_box_padding", "letter_spacing",
    )

    @classmethod
    def _landscape_caption_style(cls, style: CaptionStyle, out_h: int) -> CaptionStyle:
        """The preset resized for a 16:9 frame.

        Presets are tuned for 1080x1920, where an 84 px line is ~4% of the
        height; on 1080p landscape it would be ~8%. Scale to ~5% of the height
        and show longer phrases, which reads like subtitles across a long
        episode instead of flashing 3-word bursts.
        """
        scaled = copy.copy(style)
        factor = out_h / 1080 * 0.65
        for name in cls._CAPTION_PIXEL_FIELDS:
            value = getattr(style, name, None)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                setattr(scaled, name, max(0, round(value * factor)) if value else value)
        scaled.max_words_per_line = max(style.max_words_per_line, 6)
        return scaled

    async def _probe_fps(self, video_path: str) -> str:
        """Source frame rate as an FFmpeg rational, capped at MAX_OUTPUT_FPS.

        Keeps 24/25/30/60 fps sources at their own rate (resampling 24 fps
        film to 30 judders; 60 fps gameplay loses its smoothness). "30" when
        the probe fails or returns nonsense.
        """
        cmd = [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=avg_frame_rate,r_frame_rate", "-of", "json",
            "-protocol_whitelist", "file,pipe,fd", "-format_whitelist", "mov,matroska,webm,avi,flv,mpegts", video_path,
        ]
        try:
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                None, lambda: run_media(cmd, timeout=PROBE_TIMEOUT_SECONDS),
            )
            stream = json.loads(result.stdout or b"{}").get("streams", [{}])[0]
            for key in ("avg_frame_rate", "r_frame_rate"):
                raw = stream.get(key, "0/0")
                num, _, den = raw.partition("/")
                if not den or int(den) == 0 or int(num) == 0:
                    continue
                rate = Fraction(int(num), int(den))
                if 10 <= rate <= MAX_OUTPUT_FPS + 0.5:
                    return f"{rate.numerator}/{rate.denominator}" if rate.denominator != 1 else str(rate.numerator)
                if rate > MAX_OUTPUT_FPS:
                    return str(MAX_OUTPUT_FPS)
        except Exception as e:
            logger.warning(f"Failed to probe frame rate, using 30 fps: {e}")
        return "30"

    async def _measure_loudness(self, video_path: str, start_ms: int, duration_ms: int) -> Optional[str]:
        """First loudnorm pass over the render window; returns the linear
        second-pass filter, or None to fall back to single-pass."""
        cmd = [
            "ffmpeg", "-nostdin", "-nostats", "-hide_banner", "-nostats", "-ss", f"{start_ms / 1000:.3f}",
            "-t", f"{duration_ms / 1000:.3f}",
            "-protocol_whitelist", "file,pipe,fd", "-format_whitelist", "mov,matroska,webm,avi,flv,mpegts", "-i", video_path,
            "-map", "0:a:0", "-vn", "-af",
            f"{AUDIO_FORMAT},{AUDIO_SYNC},loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json",
            "-f", "null", "-",
        ]
        try:
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                None, lambda: run_media(cmd),
            )
            text = result.stderr.decode(errors="replace")
            match = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", text)
            if result.returncode != 0 or not match:
                raise ValueError("no loudnorm measurement in output")
            loudness = measured_loudness_filter(json.loads(match.group()))
            if loudness:
                logger.info("Two-pass loudness normalization enabled for this clip")
            return loudness
        except Exception as e:
            logger.warning(f"Loudness measurement failed; using single-pass normalization: {e}")
            return None

    async def _has_audio(self, video_path: str) -> bool:
        """Whether the source has an audio stream (the graph maps [0:a] only if so)."""
        cmd = [
            "ffprobe", "-v", "error", "-select_streams", "a",
            "-show_entries", "stream=index", "-of", "csv=p=0",
            "-protocol_whitelist", "file,pipe,fd", "-format_whitelist", "mov,matroska,webm,avi,flv,mpegts", video_path,
        ]
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, lambda: run_media(cmd, timeout=PROBE_TIMEOUT_SECONDS))
        if result.returncode != 0:
            raise RenderingError("Could not verify the source audio track")
        return bool(result.stdout.strip())

    def _build_title_card(
        self,
        title_text: str,
        target_width: int,
        overlay_y: int,
        output_path: str,
        scale: float = 1.0,
    ) -> Optional[dict]:
        """Generate a rounded-rect PNG with title text and return positioning info."""
        clean = title_text.replace("\n", " ").strip()

        if not clean:
            return None

        words = clean.split()

        if len(words) < 2:
            words = (words * 2)[:2]
        elif len(words) > 7:
            words = words[:7]

        if len(words) <= 3:
            lines = [" ".join(words)]
        else:
            mid = (len(words) + 1) // 2
            lines = [" ".join(words[:mid]), " ".join(words[mid:])]

        font_size = round(42 * scale)
        pad_x = round(28 * scale)
        pad_y = round(20 * scale)
        line_spacing = int(font_size * 1.35)
        corner_radius = round(16 * scale)

        try:
            font = ImageFont.truetype(self._font_path, font_size)
        except Exception:
            font = ImageFont.load_default()

        temp_img = Image.new("RGBA", (1, 1))
        temp_draw = ImageDraw.Draw(temp_img)

        line_widths = []
        for line in lines:
            bbox = temp_draw.textbbox((0, 0), line, font=font)
            line_widths.append(bbox[2] - bbox[0])

        max_text_w = max(line_widths)
        text_block_h = font_size + max(0, len(lines) - 1) * line_spacing

        img_w = max_text_w + pad_x * 2
        img_h = text_block_h + pad_y * 2

        img = Image.new("RGBA", (img_w, img_h), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)

        draw.rounded_rectangle(
            [(0, 0), (img_w - 1, img_h - 1)],
            radius=corner_radius,
            fill=(255, 255, 255, 242),
        )

        for i, line in enumerate(lines):
            bbox = temp_draw.textbbox((0, 0), line, font=font)
            tw = bbox[2] - bbox[0]
            x = (img_w - tw) // 2
            y = pad_y + i * line_spacing
            draw.text((x, y), line, font=font, fill=(0, 0, 0, 255))

        img.save(output_path, "PNG")

        bar_center = overlay_y // 2
        card_y = max(10, bar_center - img_h // 2)

        return {"y": card_y, "width": img_w, "height": img_h}

    def _banner_overlay_image(self, request: RenderRequest, font_size: int) -> Optional[tuple[str, int, int]]:
        """Render the channel URL banner as a transparent PNG.

        Drawn with Pillow rather than FFmpeg's drawtext: the static FFmpeg
        builds BridgeClip ships (6.1+) omit drawtext, which made any render with
        a banner fail.

        Returns (path, width, height) or None when no banner is configured.
        """
        if not (request.banner_platform and request.banner_channel_url):
            return None
        text = request.banner_channel_url.upper().strip()
        path = os.path.join(
            os.path.dirname(request.output_path),
            f"banner-{request.start_time_ms}-{request.end_time_ms}.png",
        )
        try:
            font = ImageFont.truetype(self._font_path, font_size)
        except Exception:
            font = ImageFont.load_default()
        bbox = ImageDraw.Draw(Image.new("RGBA", (1, 1))).textbbox((0, 0), text, font=font)
        shadow = 2
        width = bbox[2] - bbox[0] + shadow + 4
        height = bbox[3] - bbox[1] + shadow + 4
        image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        origin = (2 - bbox[0], 2 - bbox[1])
        draw.text((origin[0] + shadow, origin[1] + shadow), text, font=font, fill=(0, 0, 0, 128))
        draw.text(origin, text, font=font, fill=(255, 255, 255, 255))
        image.save(path, "PNG")
        return path, width, height

    async def _get_video_dimensions(self, video_path: str) -> tuple[int, int]:
        """Get actual video dimensions using ffprobe."""
        cmd = [
            "ffprobe",
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=s=x:p=0",
            "-protocol_whitelist", "file,pipe,fd", "-format_whitelist", "mov,matroska,webm,avi,flv,mpegts",
            video_path,
        ]
        try:
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                None,
                lambda: run_media(cmd, timeout=PROBE_TIMEOUT_SECONDS)
            )
            dims = result.stdout.decode().strip().split("x")
            width, height = int(dims[0]), int(dims[1])
            validate_video_dimensions(width, height)
            return width, height
        except Exception as e:
            logger.warning(f"Failed to probe video dimensions: {e}")
            return 0, 0

    async def _run_ffmpeg_complex(
        self,
        input_path: str,
        output_path: str,
        start_time_ms: int,
        duration_ms: int,
        filter_complex: str,
        audio_label: Optional[str] = None,
        extra_inputs: Optional[list[str]] = None,
        fps: str = "30",
        output_size: tuple[int, int] = (1080, 1920),
        output_duration_ms: Optional[int] = None,
    ) -> None:
        """Run FFmpeg over the render window [start, start + duration) with a filter graph.

        The graph must output [out] and, when `audio_label` is given, that audio label.
        """
        start_sec = start_time_ms / 1000
        duration_sec = duration_ms / 1000

        cmd = [
            "ffmpeg", "-nostdin", "-nostats",
            "-y",
            "-accurate_seek",
            "-ss", f"{start_sec:.6f}",
            # Input option: bound the source read to the window. (After -i it
            # would apply to the next input - the looped title image - and the
            # source would be read past the window.)
            "-t", f"{duration_sec:.6f}",
            "-protocol_whitelist", "file,pipe,fd", "-format_whitelist", "mov,matroska,webm,avi,flv,mpegts",
            "-i", input_path,
        ]

        for extra in (extra_inputs or []):
            cmd.extend(["-loop", "1", "-protocol_whitelist", "file,pipe,fd", "-i", extra])

        cmd.extend([
            "-filter_complex", filter_complex,
            "-map", "[out]",
            # MP4 edit lists account for AAC priming and reordered video.
            # make_zero shifts presentation time by encoder delay, moving the
            # media away from captions and the edit's zero-based clock.
            *self._video_codec_args(output_size[0], output_size[1], fps),
            "-pix_fmt", "yuv420p",
            "-r", fps,
            "-movflags", "+faststart",
        ])

        if audio_label:
            cmd.extend(["-map", audio_label, "-c:a", "aac", "-b:a", "192k"])
        else:
            cmd.append("-an")

        if extra_inputs:
            cmd.append("-shortest")

        cmd.append(output_path)

        try:
            await self._run_cmd(cmd)
            await self._validate_output_timing(
                output_path, output_duration_ms if output_duration_ms is not None else duration_ms,
                fps, bool(audio_label),
            )
        except RenderingError:
            # A failed validation enters the existing fallback ladder. Never
            # leave the failed export looking like a completed clip.
            try:
                os.remove(output_path)
            except OSError:
                pass
            raise

    async def _validate_output_timing(
        self, output_path: str, duration_ms: int, fps: str, with_audio: bool,
    ) -> None:
        """Check the encoded presentation clock before publishing an export.

        This catches missing/truncated tracks and mux/encoder timing shifts,
        including gaps inside audio whose overall start/end times look valid.
        Content-level lip sync is covered by decoded flash/beep regressions;
        stream metadata alone cannot detect an already out-of-sync source.
        """
        cmd = [
            "ffprobe", "-v", "error", *MEDIA_INPUT_OPTIONS,
            "-show_entries", "stream=codec_type,start_time,duration", "-of", "json", output_path,
        ]
        try:
            result = await asyncio.to_thread(run_media, cmd, timeout=PROBE_TIMEOUT_SECONDS)
            if result.returncode != 0:
                raise ValueError("probe failed")
            streams = json.loads(result.stdout)["streams"]
            expected = duration_ms / 1000
            for kind in (["video", "audio"] if with_audio else ["video"]):
                matches = [s for s in streams if s.get("codec_type") == kind]
                if len(matches) != 1:
                    raise ValueError(f"missing or ambiguous {kind} track")
                start = float(matches[0]["start_time"])
                duration = float(matches[0]["duration"])
                # One video frame, plus one AAC packet for audio, plus mux rounding.
                # Audio can only end as precisely as the last frame it plays under.
                frame = 1 / float(Fraction(fps))
                tolerance = (frame if kind == "video" else frame + 1024 / 48000) + 0.003
                if not (math.isfinite(start) and math.isfinite(duration) and duration > 0):
                    raise ValueError(f"invalid {kind} timing")
                if abs(start) > 0.003 or abs(start + duration - expected) > tolerance:
                    logger.warning(
                        "Export %s timing rejected: start=%.6fs, duration=%.6fs, expected=%.6fs, tolerance=%.6fs",
                        kind, start, duration, expected, tolerance,
                    )
                    raise ValueError(f"{kind} timing differs from the edit")
            if with_audio:
                await asyncio.to_thread(self._validate_audio_packets, output_path)
            logger.info("Export timing verified: %.3fs at %s fps, audio=%s", expected, fps, with_audio)
        except Exception as exc:
            raise RenderingError("Export timing validation failed; the clip was not saved") from exc

    @staticmethod
    def _validate_audio_packets(output_path: str) -> None:
        """Verify the continuous 48 kHz AAC clock, with bounded memory.

        MP4 can hide a PTS jump by extending the preceding packet's duration;
        compare against AAC's 1024 samples as well as adjacent timestamps.
        The final packet may be shorter and the priming packet may start
        before zero. Neither should shift the audible presentation clock.
        """
        cmd = [
            "ffprobe", "-v", "error", *MEDIA_INPUT_OPTIONS,
            "-select_streams", "a:0", "-show_entries",
            "packet=pts_time,duration_time:packet_side_data=",
            "-of", "compact=p=0:nk=0", output_path,
        ]
        packet_seconds = 1024 / 48000
        tolerance = 1 / 48000 + 0.000002  # One sample plus probe rounding.
        previous = None
        with media_process(cmd, timeout=PROBE_TIMEOUT_SECONDS) as (process, _):
            while line := process.stdout.readline(512):
                fields = dict(part.split(b"=", 1) for part in line.strip().split(b"|") if b"=" in part)
                start = float(fields[b"pts_time"])
                duration = float(fields[b"duration_time"])
                if not (math.isfinite(start) and math.isfinite(duration) and 0 < duration <= packet_seconds + tolerance):
                    raise ValueError("invalid AAC packet duration")
                if previous is not None and abs(start - previous - packet_seconds) > tolerance:
                    raise ValueError("discontinuous AAC packet timestamps")
                previous = start
        if process.returncode != 0 or previous is None:
            raise ValueError("could not verify AAC packet timestamps")

    def _compute_padded_range(self, start_time_ms: int, duration_ms: int) -> tuple[int, int]:
        """Compute padded start and duration for consistent A/V trimming."""
        audio_padding_ms = self.settings.audio_padding_ms
        if audio_padding_ms <= 0:
            return start_time_ms, duration_ms

        adjusted_start_ms = max(0, start_time_ms - audio_padding_ms)
        start_adjustment = start_time_ms - adjusted_start_ms
        adjusted_duration_ms = duration_ms + start_adjustment + audio_padding_ms
        return adjusted_start_ms, adjusted_duration_ms

    async def _run_cmd(self, cmd: list[str]) -> None:
        """Run a command asynchronously."""
        logger.debug(f"Running: {' '.join(cmd[:10])}...")

        def invoke():
            # Keep the script inside the worker: cancelling the await does not
            # stop run_media's thread, so the file must outlive that thread.
            try:
                graph_index = cmd.index("-filter_complex")
            except ValueError:
                return run_media(cmd)
            graph = cmd[graph_index + 1]
            if len(graph.encode("utf-8")) <= MAX_INLINE_FILTER_GRAPH_BYTES:
                return run_media(cmd)

            script_path = None
            try:
                # NamedTemporaryFile creates a private file. Close it before
                # FFmpeg opens it, which is required on Windows.
                with tempfile.NamedTemporaryFile(
                    mode="w", encoding="utf-8", suffix=".ffgraph",
                    prefix="bridgeclip-filter-", delete=False,
                ) as script:
                    script_path = script.name
                    script.write(graph)
                script_cmd = cmd.copy()
                script_cmd[graph_index:graph_index + 2] = ["-/filter_complex", script_path]
                result = run_media(script_cmd)
                # FFmpeg 6 (Ubuntu 24.04) predates file-backed option values;
                # FFmpeg 9 removed the older script option. Retry only when the
                # first option itself is unknown, before any render can start.
                if result.returncode != 0:
                    stderr = result.stderr or b""
                    if (b"Unrecognized option '/filter_complex'." in stderr and
                            b"Error splitting the argument list: Option not found" in stderr):
                        script_cmd[graph_index] = "-filter_complex_script"
                        result = run_media(script_cmd)
                return result
            finally:
                if script_path is not None:
                    os.remove(script_path)

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            invoke,
        )

        if result.returncode != 0:
            error_msg = result.stderr.decode()[-1000:] if result.stderr else "Unknown error"
            raise RenderingError(f"FFmpeg failed: {error_msg}")

    def _escape_filter_path(self, path: str) -> str:
        """Escape file path for FFmpeg filter usage."""
        import sys

        escaped = path.replace("\\", "/")

        if sys.platform == "win32" and len(escaped) >= 2 and escaped[1] == ":":
            escaped = escaped[0] + "\\:" + escaped[2:]

        escaped = escaped.replace("'", "'\\''")
        escaped = escaped.replace("[", "\\[")
        escaped = escaped.replace("]", "\\]")

        return f"'{escaped}'"


class RenderingError(Exception):
    """Exception raised when rendering fails."""
    pass
