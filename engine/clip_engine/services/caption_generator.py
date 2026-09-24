"""
Caption Generator Service - Generates short-form ASS captions with word-by-word highlighting.

Each caption event is drawn as a stack of layers that share the same text, so
the glyphs line up exactly and every effect is a real blurred bitmap:

    0 plate   - rounded translucent box behind the whole line
    1 shadow  - soft (blurred) drop shadow
    2 glow    - blurred bloom around the text or the active word
    3 pill    - rounded box behind the active word
    4 face    - the crisp text with its stroke

Rounded boxes come from a thick glyph border (libass joins borders round), so
no text measurement is needed. Words keep their advance widths on every layer,
which keeps the stack aligned while words change color.
"""

import glob
import logging
import math
import os
import re
import struct
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Callable, Optional

from clip_engine.config import CaptionStyle, get_settings
from clip_engine.services.transcription_service import TranscriptSegment, TranscriptWord

logger = logging.getLogger(__name__)

SENTENCE_END_CHARS = frozenset(".!?")

# A group stays up at most this long after its last word ends (silences clear it).
MAX_LINGER_MS = 700

# Group entrance: scale overshoot, then settle.
POP_TAGS = r"\fscx82\fscy82\t(0,90,\fscx106\fscy106)\t(90,170,\fscx100\fscy100)"

LAYER_PLATE, LAYER_SHADOW, LAYER_GLOW, LAYER_PILL, LAYER_FACE = range(5)

PAST, ACTIVE, FUTURE = "past", "active", "future"

# SRT sidecar cues (subtitle conventions: 2 lines, readable pace).
SRT_LINE_CHARS = 42
SRT_MAX_CUE_MS = 6000
SRT_PAUSE_BREAK_MS = 700
SRT_LINGER_MS = 400


def _norm(word: str) -> str:
    """Comparison key for emphasis matching ("$14,500" -> "14500")."""
    return re.sub(r"[^a-z0-9]", "", word.lower())

# Side margins of the base style; libass wraps lines wider than the rest.
SIDE_MARGIN = 60
# Advance width per character (share of the font size) when the preset's font
# file can't be measured. Heavy caps run up to ~0.9; erring wide is safe.
FALLBACK_CHAR_EM = 0.75

# Pixel-placed caption blocks: (start_ms, end_ms, block_w, block_h) -> (alignment, y).
Placer = Callable[[int, int, int, int], tuple[int, int]]

FONTS_DIRS = (
    os.path.join(os.path.dirname(__file__), "..", "..", "assets", "fonts"),
    os.path.join("/app", "assets", "fonts"),
)


@dataclass(frozen=True)
class _FontMetrics:
    """A caption face at PIL size 100 and the line libass lays it out on."""

    font: Any  # PIL FreeTypeFont
    ascent: float  # baseline below the line top, px at size 100
    height: float  # line height, px at size 100


def _win_metrics(path: str) -> Optional[tuple[float, float]]:
    """OS/2 (winAscent, winDescent) as shares of the em, or None."""
    try:
        with open(path, "rb") as f:
            data = f.read()
        tables = {}
        for i in range(struct.unpack(">H", data[4:6])[0]):
            tag, _, offset, _ = struct.unpack(">4sIII", data[12 + 16 * i: 28 + 16 * i])
            tables[tag] = offset
        head, os2 = tables[b"head"], tables[b"OS/2"]
        units = struct.unpack(">H", data[head + 18: head + 20])[0]
        ascent, descent = struct.unpack(">HH", data[os2 + 74: os2 + 78])
    except (OSError, KeyError, struct.error):
        return None
    return (ascent / units, descent / units) if units and ascent + descent else None


@lru_cache(maxsize=16)
def _caption_font(font_name: str) -> Optional[_FontMetrics]:
    """Metrics of a bundled caption face ("Montserrat Black", "Anton"), or None.

    libass (like VSFilter) sizes a font so its OS/2 winAscent + winDescent
    equals the font size, which draws it smaller than the same size elsewhere.
    """
    try:
        from PIL import ImageFont
    except ImportError:  # pragma: no cover - Pillow ships with the engine
        return None
    wanted = font_name.lower()
    for directory in FONTS_DIRS:
        for path in sorted(glob.glob(os.path.join(os.path.abspath(directory), "*.[ot]tf"))):
            try:
                font = ImageFont.truetype(path, 100)
            except OSError:
                continue
            family, face = font.getname()
            if wanted not in (f"{family} {face}".lower(), family.lower() if face == "Regular" else None):
                continue
            win = _win_metrics(path)
            ascent, descent = (win[0] * 100, win[1] * 100) if win else font.getmetrics()
            if ascent + descent > 0:
                return _FontMetrics(font, ascent, ascent + descent)
    return None


ALIGNMENT_MAP = {
    "left": {"top": 7, "center": 4, "bottom": 1},
    "center": {"top": 8, "center": 5, "bottom": 2},
    "right": {"top": 9, "center": 6, "bottom": 3},
}


@dataclass
class WordGroup:
    """A group of words to display together."""

    words: list[TranscriptWord]
    start_time_ms: int
    end_time_ms: int
    text: str


@dataclass
class _Token:
    """One word of a caption event and how it should be drawn."""

    text: str
    state: str
    emphasized: bool
    karaoke_cs: int = 0


class CaptionGeneratorService:
    """Service for generating layered ASS captions from a CaptionStyle."""

    def __init__(self):
        self.settings = get_settings()
        self._emphasis: set[str] = set()

    async def generate_captions(
        self,
        transcript_segments: list[TranscriptSegment],
        clip_start_ms: int,
        clip_end_ms: int,
        output_path: str,
        caption_style: Optional[CaptionStyle] = None,
        output_width: int = 1080,
        output_height: int = 1920,
        video_region_y: Optional[int] = None,
        video_region_height: Optional[int] = None,
        anchors: Optional[list[tuple[int, int, int]]] = None,
        emphasis_words: Optional[list[str]] = None,
        placer: Optional[Placer] = None,
    ) -> Optional[str]:
        """Generate ASS captions for a clip.

        Args:
            video_region_y: Y offset where the video content starts in the output frame.
            video_region_height: Height of the video content region in pixels.
                When provided, captions are positioned relative to the video
                region rather than the full output frame.
            anchors: Optional per-layout placement as (until_ms, alignment, y)
                in clip time, sorted. Each caption event is pinned with
                an/pos override tags to the anchor active at its start, so captions move
                with mid-clip layout changes.
            emphasis_words: Punch words to render in the style's emphasis color.
            placer: Optional per-group placement (see layout_renderer.CaptionPlacer),
                called with each word group's (start_ms, end_ms, width, height)
                in clip time. Every event of a group gets the same an/pos, so
                captions never jump mid-phrase. Replaces `anchors`.
        """
        style = caption_style or self.settings.get_caption_style()
        self._emphasis = {
            _norm(t) for w in (emphasis_words or []) for t in w.split() if len(_norm(t)) >= 2
        } if style.emphasis_color else set()

        relevant_segments = [
            seg for seg in transcript_segments
            if seg.end_time_ms > clip_start_ms and seg.start_time_ms < clip_end_ms
        ]

        if not relevant_segments:
            logger.debug(f"No transcript segments found for clip {clip_start_ms}-{clip_end_ms}")
            return None

        has_word_timing = any(
            seg.words and len(seg.words) > 0
            for seg in relevant_segments
        )

        header = self._generate_ass_header(
            style, output_width, output_height, video_region_y, video_region_height,
        )
        place = None
        if placer is not None:
            def place(events: list[str], words: list[str]) -> list[str]:
                if not events:
                    return events
                times = [line[len("Dialogue: "):].split(",", 3)[1:3] for line in events]
                start = min(self._parse_ass_time(t[0]) for t in times)
                end = max(self._parse_ass_time(t[1]) for t in times)
                width, height = self._block_size(words, style, output_width)
                alignment, y = placer(start, end, width, height)
                return [self._pin(line, alignment, output_width // 2, y) for line in events]

        if has_word_timing and style.word_by_word_highlight:
            events = self._word_by_word_events(relevant_segments, clip_start_ms, clip_end_ms, style, place)
        else:
            events = self._segment_events(relevant_segments, clip_start_ms, clip_end_ms, style, place)
        ass_content = header + self._events_header() + "\n".join(events)

        if anchors and placer is None:
            ass_content = self._apply_anchors(ass_content, anchors, output_width)

        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(ass_content)

        logger.debug(
            f"Generated ASS captions: {output_path} "
            f"(word_timing={has_word_timing}, segments={len(relevant_segments)})"
        )

        return output_path

    def generate_srt(
        self,
        transcript_segments: list[TranscriptSegment],
        clip_start_ms: int,
        clip_end_ms: int,
        output_path: str,
    ) -> Optional[str]:
        """Write a standard SRT subtitle file for the clip (sidecar for uploads).

        Cues follow broadcast subtitle conventions: up to two lines of
        SRT_LINE_CHARS, at most SRT_MAX_CUE_MS on screen, breaking at sentence
        ends and pauses. Returns the path, or None when there is no speech.
        """
        words: list[TranscriptWord] = []
        for segment in transcript_segments:
            words.extend(segment.words or self._split_segment_into_words(segment))
        words = [
            w for w in sorted(words, key=lambda w: w.start_time_ms)
            if w.end_time_ms > clip_start_ms and w.start_time_ms < clip_end_ms and w.word.strip()
        ]
        if not words:
            return None

        cues: list[list[TranscriptWord]] = []
        current: list[TranscriptWord] = []
        for word in words:
            if current:
                text = " ".join(w.word.strip() for w in current + [word])
                too_long = len(text) > 2 * SRT_LINE_CHARS
                too_slow = word.end_time_ms - current[0].start_time_ms > SRT_MAX_CUE_MS
                paused = word.start_time_ms - current[-1].end_time_ms > SRT_PAUSE_BREAK_MS
                if too_long or too_slow or paused:
                    cues.append(current)
                    current = []
            current.append(word)
            if word.word.strip()[-1] in SENTENCE_END_CHARS and len(current) >= 3:
                cues.append(current)
                current = []
        if current:
            cues.append(current)

        blocks = []
        for index, cue in enumerate(cues):
            start = max(0, cue[0].start_time_ms - clip_start_ms)
            end = cue[-1].end_time_ms - clip_start_ms + SRT_LINGER_MS
            if index + 1 < len(cues):
                end = min(end, cues[index + 1][0].start_time_ms - clip_start_ms)
            end = min(end, clip_end_ms - clip_start_ms)
            if end <= start:
                continue
            text = " ".join(w.word.strip().replace("{", "").replace("}", "") for w in cue)
            blocks.append(
                f"{len(blocks) + 1}\n{self._format_srt_time(start)} --> {self._format_srt_time(end)}\n"
                f"{self._wrap_subtitle(text)}\n"
            )
        if not blocks:
            return None
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write("\n".join(blocks))
        return output_path

    @staticmethod
    def _wrap_subtitle(text: str) -> str:
        """Split a cue into at most two balanced lines."""
        if len(text) <= SRT_LINE_CHARS:
            return text
        words = text.split()
        best, best_diff = text, None
        for i in range(1, len(words)):
            top, bottom = " ".join(words[:i]), " ".join(words[i:])
            diff = abs(len(top) - len(bottom))
            if best_diff is None or diff < best_diff:
                best, best_diff = f"{top}\n{bottom}", diff
        return best

    @staticmethod
    def _format_srt_time(ms: int) -> str:
        """HH:MM:SS,mmm"""
        ms = max(0, int(ms))
        return f"{ms // 3_600_000:02d}:{ms // 60_000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"

    def _word_by_word_events(
        self,
        segments: list[TranscriptSegment],
        clip_start_ms: int,
        clip_end_ms: int,
        style: CaptionStyle,
        place: Optional[Callable[[list[str], list[str]], list[str]]] = None,
    ) -> list[str]:
        all_words: list[TranscriptWord] = []
        for segment in segments:
            if segment.words and len(segment.words) > 0:
                all_words.extend(segment.words)
            else:
                all_words.extend(self._split_segment_into_words(segment))

        clip_words = [
            w for w in all_words
            if w.end_time_ms > clip_start_ms and w.start_time_ms < clip_end_ms
        ]
        word_groups = self._group_words(clip_words, style.max_words_per_line)

        events: list[str] = []
        for group_idx, group in enumerate(word_groups):
            if group_idx < len(word_groups) - 1:
                next_group_start_ms = word_groups[group_idx + 1].words[0].start_time_ms
            else:
                next_group_start_ms = None
            group_events = self._generate_word_group_events(
                group, clip_start_ms, style, next_group_start_ms
            )
            events.extend(place(group_events, [w.word for w in group.words]) if place else group_events)
        return events

    def _segment_events(
        self,
        segments: list[TranscriptSegment],
        clip_start_ms: int,
        clip_end_ms: int,
        style: CaptionStyle,
        place: Optional[Callable[[list[str], list[str]], list[str]]] = None,
    ) -> list[str]:
        """Whole segments without word timing: every word drawn as already spoken."""
        events: list[str] = []
        for segment in segments:
            start_ms = max(0, segment.start_time_ms - clip_start_ms)
            end_ms = min(clip_end_ms - clip_start_ms, segment.end_time_ms - clip_start_ms)
            if end_ms <= start_ms:
                continue
            tokens = [
                _Token(self._display_word(w, style), PAST, self._is_emphasis(w))
                for w in segment.text.split()
            ]
            segment_events = self._layered_events(tokens, start_ms, end_ms, style, entrance=False)
            events.extend(place(segment_events, segment.text.split()) if place else segment_events)
        return events

    def _apply_anchors(
        self,
        ass_content: str,
        anchors: list[tuple[int, int, int]],
        output_width: int,
    ) -> str:
        r"""Prefix each Dialogue with the \an/\pos of the layout active at its start."""
        lines = []
        prefix = "Dialogue: "
        for line in ass_content.split("\n"):
            if line.startswith(prefix):
                start_ms = self._parse_ass_time(line[len(prefix):].split(",", 2)[1])
                alignment, y = anchors[-1][1], anchors[-1][2]
                for until_ms, a, ay in anchors:
                    if start_ms < until_ms:
                        alignment, y = a, ay
                        break
                line = self._pin(line, alignment, output_width // 2, y)
            lines.append(line)
        return "\n".join(lines)

    @staticmethod
    def _pin(line: str, alignment: int, x: int, y: int) -> str:
        r"""A Dialogue line with an \an/\pos override in front of its text."""
        prefix = "Dialogue: "
        fields = line[len(prefix):].split(",", 9)
        fields[9] = f"{{\\an{alignment}\\pos({x},{y})}}" + fields[9]
        return prefix + ",".join(fields)

    def _block_size(self, words: list[str], style: CaptionStyle, output_width: int) -> tuple[int, int]:
        r"""Approximate drawn (width, height) of one caption group, in output px.

        Follows how libass lays the events out: explicit lines of
        max_words_per_line words, wrapped again past the side margins, with
        the block centered on its \pos. Measured to the glyphs actually drawn,
        then grown by the widest effect around them and the pop-in overshoot.
        The height is symmetric about the \pos (twice the larger half).
        """
        wrap_w = max(1, output_width - 2 * SIDE_MARGIN)
        pill = bool(style.highlight_box_color and not style.karaoke_fill)
        gap = "  " if pill else " "
        per_line = max(1, style.max_words_per_line)
        shown = [self._display_word(w, style) for w in words if w.strip()] or [""]
        texts = [gap.join(shown[i:i + per_line]) for i in range(0, len(shown), per_line)]
        size = style.font_size

        metrics = _caption_font(style.font_name)
        if metrics is not None:
            scale = size / metrics.height
            widths = [metrics.font.getlength(t) * scale + style.letter_spacing * len(t) for t in texts]
            _, ink_top, _, ink_bottom = metrics.font.getbbox(" ".join(texts), anchor="ls")
            baseline, ink_top, ink_bottom = metrics.ascent * scale, ink_top * scale, ink_bottom * scale
        else:
            widths = [len(t) * (size * FALLBACK_CHAR_EM + style.letter_spacing) for t in texts]
            baseline, ink_top, ink_bottom = size, -size, 0  # the whole line box
        lines = sum(max(1, math.ceil(w / wrap_w)) for w in widths)

        # From the \pos (block center) to the first line's glyph tops and the
        # last line's glyph bottoms; each line is font_size tall.
        block_top = -lines * size / 2
        top = block_top + baseline + ink_top
        bottom = block_top + (lines - 1) * size + baseline + ink_bottom
        # Soft shadows and glows reach about their blur past their border.
        pad = max(
            style.outline_width,
            style.outline_width + style.shadow_spread + style.shadow_blur if style.shadow_opacity > 0 else 0,
            style.line_box_padding + 1 if style.line_box_color else 0,
            style.glow_radius + style.glow_blur if style.glow_color else 0,
            style.highlight_box_padding + 1 if pill else 0,
        )
        shadow = style.shadow_offset if style.shadow_opacity > 0 else 0
        grow = 1.06 if style.entrance_pop else 1.0
        half = max(pad - top, bottom + pad + shadow) * grow
        return round((min(max(widths), wrap_w) + 2 * pad) * grow), round(2 * half)

    @staticmethod
    def _parse_ass_time(value: str) -> int:
        hours, minutes, rest = value.split(":")
        seconds, centis = rest.split(".")
        return ((int(hours) * 60 + int(minutes)) * 60 + int(seconds)) * 1000 + int(centis) * 10

    # ------------------------------------------------------------------
    # ASS Header Generation
    # ------------------------------------------------------------------

    def _generate_ass_header(
        self,
        style: CaptionStyle,
        output_width: int,
        output_height: int,
        video_region_y: Optional[int] = None,
        video_region_height: Optional[int] = None,
    ) -> str:
        """One base style; every layer sets its own colors and borders inline."""
        alignment = ALIGNMENT_MAP[style.alignment][style.position]
        margin_v = self._calculate_margin_v(
            style, output_height, video_region_y, video_region_height,
        )

        # ASS Style format:
        # Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour,
        # BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing,
        # Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
        default_style = (
            f"Style: Default,{style.font_name},{style.font_size},"
            f"{self._hex_to_ass(style.primary_color)},{self._hex_to_ass(style.highlight_color)},"
            f"{self._hex_to_ass(style.outline_color)},{self._hex_to_ass(style.shadow_color)},"
            f"{-1 if style.bold else 0},{-1 if style.italic else 0},0,0,100,100,{style.letter_spacing},0,"
            f"1,{style.outline_width},0,"
            f"{alignment},60,60,{margin_v},1"
        )

        return f"""[Script Info]
Title: BridgeClip Captions
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: {output_width}
PlayResY: {output_height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
{default_style}

"""

    def _calculate_margin_v(
        self,
        style: CaptionStyle,
        output_height: int,
        video_region_y: Optional[int],
        video_region_height: Optional[int],
    ) -> int:
        """Calculate vertical margin to position captions in the bottom blurred bar.

        Places captions in the upper portion of the bottom bar so they sit
        just below the video content without overlaying it.
        """
        if video_region_y is not None and video_region_height is not None:
            video_bottom = video_region_y + video_region_height
            bottom_bar = output_height - video_bottom
            # Place captions in the upper portion of the bottom bar,
            # leaving room for the platform banner below
            margin_v = int(bottom_bar * 0.55)
            return max(margin_v, 30)

        # Fallback for non-letterbox rendering
        if style.position == "top":
            return 100
        elif style.position == "center":
            return 450
        else:
            return 100

    def _events_header(self) -> str:
        return "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"

    # ------------------------------------------------------------------
    # Word Group Events
    # ------------------------------------------------------------------

    def _generate_word_group_events(
        self,
        group: WordGroup,
        clip_start_ms: int,
        style: CaptionStyle,
        next_group_start_ms: Optional[int] = None,
    ) -> list[str]:
        r"""Generate ASS dialogue events for a word group.

        Karaoke styles get one event per group with \kf tags that sweep color
        across each word in sync with speech. Otherwise each word gets its own
        event with that word active; the group pops in on its first event.
        """
        words = group.words
        if not words:
            return []

        last_end = words[-1].end_time_ms + MAX_LINGER_MS
        group_end = min(next_group_start_ms, last_end) if next_group_start_ms is not None else last_end

        if style.karaoke_fill:
            start = max(0, words[0].start_time_ms - clip_start_ms)
            end = max(0, group_end - clip_start_ms)
            if end <= start:
                return []
            # Each sweep lasts until the next word starts, so gaps don't make it drift.
            tokens = [
                _Token(
                    self._display_word(w.word, style), FUTURE, self._is_emphasis(w.word),
                    karaoke_cs=max(1, round((
                        (words[k + 1].start_time_ms if k + 1 < len(words) else w.end_time_ms)
                        - w.start_time_ms
                    ) / 10)),
                )
                for k, w in enumerate(words)
            ]
            return self._layered_events(tokens, start, end, style, entrance=style.entrance_pop)

        events: list[str] = []
        for i, current_word in enumerate(words):
            word_start = max(0, current_word.start_time_ms - clip_start_ms)
            if i < len(words) - 1:
                word_end = max(0, words[i + 1].start_time_ms - clip_start_ms)
            else:
                word_end = max(0, group_end - clip_start_ms)
            if word_end <= word_start:
                continue

            tokens = [
                _Token(
                    self._display_word(w.word, style),
                    ACTIVE if j == i else (PAST if j < i else FUTURE),
                    self._is_emphasis(w.word),
                )
                for j, w in enumerate(words)
            ]
            events.extend(self._layered_events(
                tokens, word_start, word_end, style,
                entrance=style.entrance_pop and not events,
                active_ms=word_end - word_start,
            ))

        return events

    def _layered_events(
        self,
        tokens: list[_Token],
        start_ms: int,
        end_ms: int,
        style: CaptionStyle,
        entrance: bool,
        active_ms: int = 0,
    ) -> list[str]:
        """One Dialogue line per enabled layer, all sharing the same words."""
        layers: list[tuple[int, Callable[[_Token], str]]] = []
        if style.line_box_color:
            layers.append((LAYER_PLATE, lambda t: self._plate_tags(t, style)))
        if style.shadow_opacity > 0:
            layers.append((LAYER_SHADOW, lambda t: self._shadow_tags(t, style)))
        if style.glow_color:
            layers.append((LAYER_GLOW, lambda t: self._glow_tags(t, style)))
        if style.highlight_box_color and not style.karaoke_fill:
            layers.append((LAYER_PILL, lambda t: self._pill_tags(t, style)))
        layers.append((LAYER_FACE, lambda t: self._face_tags(t, style, active_ms)))

        lead = POP_TAGS if entrance else ""
        # The pill overhangs its word; hard spaces keep it clear of the neighbors
        # (on every event, so words don't shift as the pill moves).
        gap = " \\h" if style.highlight_box_color and not style.karaoke_fill else " "
        start, end = self._format_ass_time(start_ms), self._format_ass_time(end_ms)
        events = []
        for layer, tags_for in layers:
            parts = []
            for t in tokens:
                karaoke = f"\\kf{t.karaoke_cs}" if t.karaoke_cs else ""
                parts.append(f"{{{karaoke}{tags_for(t)}}}{t.text}")
            text = "\\N".join(self._wrap_words(parts, style.max_words_per_line, gap))
            events.append(f"Dialogue: {layer},{start},{end},Default,,0,0,0,,{{{lead}}}{text}")
        return events

    # ------------------------------------------------------------------
    # Per-layer word tags
    # ------------------------------------------------------------------

    def _visibility(self, token: _Token, style: CaptionStyle) -> float:
        """0..1 opacity multiplier for a word (unspoken words may be dimmed or hidden)."""
        if token.state != FUTURE or style.karaoke_fill:
            return 1.0
        if style.future_words == "hide":
            return 0.0
        if style.future_words == "dim":
            return style.dim_opacity
        return 1.0

    def _face_tags(self, token: _Token, style: CaptionStyle, active_ms: int) -> str:
        emphasis = self._hex_to_ass(style.emphasis_color) if token.emphasized else None
        primary = self._hex_to_ass(style.primary_color)
        highlight = self._hex_to_ass(style.highlight_color)
        alpha = self._alpha(self._visibility(token, style))
        border = f"\\bord{style.outline_width}\\3c{self._hex_to_ass(style.outline_color)}"

        if style.karaoke_fill:
            # \kf sweeps from SecondaryColour (unspoken) to PrimaryColour (spoken).
            spoken = emphasis or highlight
            return (
                f"\\1c{spoken}\\2c{primary}\\1a&H00&\\2a{self._alpha(style.dim_opacity)}"
                f"\\3a&H00&{border}"
            )

        if token.state == ACTIVE:
            color = emphasis or highlight
            if style.highlight_box_color:
                # Text on the pill needs no stroke.
                border = "\\bord0"
            if style.color_transition and active_ms >= 150:
                return (
                    f"\\alpha&H00&{border}\\1c{primary}"
                    f"\\t(0,{int(active_ms * 0.3)},\\1c{color})"
                )
            return f"\\alpha&H00&{border}\\1c{color}"

        return f"\\alpha{alpha}{border}\\1c{emphasis or primary}"

    def _shadow_tags(self, token: _Token, style: CaptionStyle) -> str:
        visibility = self._visibility(token, style)
        if style.highlight_box_color and token.state == ACTIVE:
            visibility *= 0.5  # the pill carries its own weight
        return (
            f"\\1a&HFF&\\3a&HFF&\\4a{self._alpha(style.shadow_opacity * visibility)}"
            f"\\4c{self._hex_to_ass(style.shadow_color)}\\bord{style.outline_width + style.shadow_spread}"
            f"\\xshad0\\yshad{style.shadow_offset}\\blur{style.shadow_blur}"
        )

    def _glow_tags(self, token: _Token, style: CaptionStyle) -> str:
        lit = token.state == ACTIVE or not style.glow_active_only or style.karaoke_fill
        opacity = style.glow_opacity * self._visibility(token, style) if lit else 0.0
        return (
            f"\\1a&HFF&\\3a{self._alpha(opacity)}\\3c{self._hex_to_ass(style.glow_color)}"
            f"\\bord{style.glow_radius}\\shad0\\blur{style.glow_blur}"
        )

    def _pill_tags(self, token: _Token, style: CaptionStyle) -> str:
        if token.state != ACTIVE:
            return "\\alpha&HFF&\\bord0\\shad0"
        color = self._hex_to_ass(style.highlight_box_color)
        pad = style.highlight_box_padding
        # The pill swells into place so the jump between words reads as motion.
        return (
            f"\\alpha&H00&\\1c{color}\\3c{color}\\shad0\\blur0.8"
            f"\\bord{max(1, pad // 2)}\\t(0,80,\\bord{pad})"
        )

    def _plate_tags(self, token: _Token, style: CaptionStyle) -> str:
        # Unspoken words keep their plate so the box never changes size.
        color = self._hex_to_ass(style.line_box_color)
        return (
            f"\\1a&HFF&\\3a{self._alpha(style.line_box_opacity)}\\3c{color}"
            f"\\bord{style.line_box_padding}\\shad0\\blur1"
        )

    def _is_emphasis(self, word: str) -> bool:
        key = _norm(word)
        return bool(key) and (key in self._emphasis or key.rstrip("s") in self._emphasis)

    # ------------------------------------------------------------------
    # Word Grouping (punctuation-aware)
    # ------------------------------------------------------------------

    def _group_words(
        self,
        words: list[TranscriptWord],
        max_per_group: int,
    ) -> list[WordGroup]:
        """Group words into display groups, breaking at natural pauses."""
        groups: list[WordGroup] = []
        current: list[TranscriptWord] = []

        for word in words:
            current.append(word)

            at_limit = len(current) >= max_per_group
            stripped = word.word.strip()
            at_sentence_end = stripped and stripped[-1] in SENTENCE_END_CHARS
            at_comma = stripped and stripped[-1] == "," and len(current) >= 2

            if at_limit or at_sentence_end or at_comma:
                groups.append(WordGroup(
                    words=list(current),
                    start_time_ms=current[0].start_time_ms,
                    end_time_ms=current[-1].end_time_ms,
                    text=" ".join(w.word for w in current),
                ))
                current = []

        if current:
            groups.append(WordGroup(
                words=current,
                start_time_ms=current[0].start_time_ms,
                end_time_ms=current[-1].end_time_ms,
                text=" ".join(w.word for w in current),
            ))

        return groups

    # ------------------------------------------------------------------
    # Utilities
    # ------------------------------------------------------------------

    def _display_word(self, word: str, style: CaptionStyle) -> str:
        """Caption text for a word: trailing commas/periods dropped, ASS braces removed."""
        text = word.strip().replace("{", "").replace("}", "").replace("\\", "")
        if len(text) > 1 and text[-1] in ",.;:":
            text = text.rstrip(",.;:")
        return text.upper() if style.uppercase else text

    def _split_segment_into_words(
        self, segment: TranscriptSegment,
    ) -> list[TranscriptWord]:
        text = segment.text.strip()
        word_strings = text.split()
        if not word_strings:
            return []

        duration = segment.end_time_ms - segment.start_time_ms
        word_duration = duration / len(word_strings)

        return [
            TranscriptWord(
                word=word,
                start_time_ms=int(segment.start_time_ms + i * word_duration),
                end_time_ms=int(segment.start_time_ms + (i + 1) * word_duration),
            )
            for i, word in enumerate(word_strings)
        ]

    def _wrap_words(self, words: list[str], max_words_per_line: int, gap: str = " ") -> list[str]:
        lines: list[str] = []
        for i in range(0, len(words), max_words_per_line):
            line_words = words[i:min(i + max_words_per_line, len(words))]
            lines.append(gap.join(line_words))
        return lines

    @staticmethod
    def _alpha(opacity: float) -> str:
        """ASS alpha tag value for an opacity in 0..1 (ASS alpha is inverted)."""
        opacity = min(1.0, max(0.0, opacity))
        return f"&H{round((1.0 - opacity) * 255):02X}&"

    def _hex_to_ass(self, hex_color: str) -> str:
        """Convert #RRGGBB to ASS &H00BBGGRR format (fully opaque)."""
        clean = hex_color.lstrip("#")
        r = int(clean[0:2], 16)
        g = int(clean[2:4], 16)
        b = int(clean[4:6], 16)
        return f"&H00{b:02X}{g:02X}{r:02X}"

    def _format_ass_time(self, ms: int) -> str:
        """Format milliseconds to ASS time format (H:MM:SS.CC)."""
        total_seconds = ms // 1000
        centiseconds = round((ms % 1000) / 10)
        if centiseconds >= 100:
            centiseconds = 0
            total_seconds += 1
        seconds = total_seconds % 60
        minutes = (total_seconds // 60) % 60
        hours = total_seconds // 3600
        return f"{hours}:{minutes:02d}:{seconds:02d}.{centiseconds:02d}"
