"""Regressions from the rendering/captions security audit.

Covers untrusted text reaching FFmpeg filter graphs and ASS subtitle files:
file paths built into the `ass=` filter, transcript words written into
Dialogue lines, and planner (LLM) output drawn on the title card or parsed as
timings. Real FFmpeg runs need a build with libass (the bundled engine-bin
one); those tests skip when none is available.
"""

import asyncio
import os
import shutil
import subprocess
import sys

import numpy as np
import pytest

from clip_engine.config import CaptionStyle
from clip_engine.services import rendering_service as module
from clip_engine.services.caption_generator import CaptionGeneratorService
from clip_engine.services.intelligence_planner import IntelligencePlannerService
from clip_engine.services.layout_analyzer import ClipLayoutPlan, LayoutType, ShotLayout
from clip_engine.services.rendering_service import MAX_TITLE_CHARS, RenderingService, RenderRequest
from clip_engine.services.transcription_service import TranscriptSegment, TranscriptWord

ENGINE_BIN = os.path.join(os.path.dirname(__file__), "..", "..", "engine-bin")


def _has_ass_filter(ffmpeg: str) -> bool:
    try:
        out = subprocess.run([ffmpeg, "-hide_banner", "-filters"], capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return any(line.split()[1:2] == ["ass"] for line in out.splitlines())


def _find_ffmpeg() -> tuple[str, str] | None:
    """(ffmpeg, ffprobe) of the first build that has the libass `ass` filter."""
    candidates = [os.environ.get("TEST_FFMPEG"), shutil.which("ffmpeg"), os.path.join(ENGINE_BIN, "ffmpeg")]
    for ffmpeg in candidates:
        if ffmpeg and os.path.isfile(ffmpeg) and _has_ass_filter(ffmpeg):
            ffprobe = os.path.join(os.path.dirname(ffmpeg), "ffprobe.exe" if sys.platform == "win32" else "ffprobe")
            if os.path.isfile(ffprobe):
                return os.path.abspath(ffmpeg), os.path.abspath(ffprobe)
    return None


FFMPEG_WITH_ASS = _find_ffmpeg()
needs_libass = pytest.mark.skipif(FFMPEG_WITH_ASS is None, reason="FFmpeg with libass required")

# Every character that means something to one of FFmpeg's two parsers, plus
# whitespace, a backslash and non-ASCII, in one directory name.
HOSTILE_DIR = "it's [x];y,z=w:q \\ é"
if sys.platform == "win32":
    HOSTILE_DIR = "it's [x];y,z=w;q é"

STYLES_FORMAT = (
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
    "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
    "Alignment, MarginL, MarginR, MarginV, Encoding"
)
# A transcript "word" that, if written into a Dialogue line unchanged, adds a
# style with an opaque white box big enough to cover the frame for ten hours.
INJECTED_WORD = (
    "HI\n[V4+ Styles]\n" + STYLES_FORMAT + "\n"
    "Style: Evil,Arial,200,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,3,400,0,5,0,0,0,1\n"
    "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    "Dialogue: 9,0:00:00.00,9:59:59.00,Evil,,0,0,0,,WWWWWWWW"
)


def frame_mean(ffmpeg: str, vf: str, size: str = "180x320", at: float = 0.5) -> float:
    """Mean gray level of one frame of black with `vf` applied (255 = all white)."""
    result = subprocess.run(
        [ffmpeg, "-v", "error", "-f", "lavfi", "-i", f"color=c=black:s={size}:d=1", "-vf", vf,
         "-ss", str(at), "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "-"],
        capture_output=True, timeout=120,
    )
    assert result.returncode == 0, result.stderr.decode(errors="replace")
    return float(np.frombuffer(result.stdout, np.uint8).mean())


def big_white_ass(path: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        f.write(
            "[Script Info]\nScriptType: v4.00+\nPlayResX: 180\nPlayResY: 320\n\n[V4+ Styles]\n" + STYLES_FORMAT + "\n"
            "Style: Default,Arial,200,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,3,400,0,5,0,0,0,1\n\n"
            "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
            "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,WWWWWWWW\n"
        )


# ------------------------------------------------------------------
# RENDER-1: file paths inside the ass= filter
# ------------------------------------------------------------------


def av_get_token(text: str, term: str) -> tuple[str, str]:
    """libavutil's av_get_token: one level of \\ escapes and '...' quoting.

    Returns (token, rest) where rest starts at the unescaped terminator.
    """
    out, i = [], 0
    while i < len(text) and text[i] not in term:
        c = text[i]
        i += 1
        if c == "\\" and i < len(text):
            out.append(text[i])
            i += 1
        elif c == "'":
            end = text.index("'", i)
            out.append(text[i:end])
            i = end + 1
        else:
            out.append(c)
    return "".join(out), text[i:]


def filter_options(args: str) -> list[tuple[str | None, str]]:
    """(name, value) pairs as the filter's option parser reads them: an
    option name is letters, digits, - _ / . followed by '=', anything else is
    a shorthand (positional) value up to the next ':'."""
    options = []
    while args:
        i = 0
        while i < len(args) and (args[i].isalnum() or args[i] in "-_/."):
            i += 1
        name = None
        if args[i:i + 1] == "=":
            name, args = args[:i], args[i + 1:]
        value, args = av_get_token(args, ":")
        options.append((name, value))
        args = args[1:]
    return options


@pytest.mark.parametrize("path", [
    "/tmp/plain/clip.ass",
    "/Users/Matt O'Brien/Library/Application Support/BridgeClip/work/clip.ass",
    "/out/" + HOSTILE_DIR + "/clip-0-6000.ass",
    "/out/x'\\''y/[a],b;c=d:e/clip.ass",
    "C:/Users/me/clip.ass",
    "/tmp/trailing space /clip.ass",
])
def test_filter_path_survives_both_parse_levels(path):
    fonts = "/app/assets/fonts"
    escaped = RenderingService._escape_filter_path(path)
    graph = f"[base]ass={escaped}:fontsdir={RenderingService._escape_filter_path(fonts)}[captioned];[captioned]null[out]"
    # Graph level: the filter's args end exactly at its output label.
    name, rest = av_get_token(graph[len("[base]"):], "=,;[]")
    assert name == "ass" and rest.startswith("=")
    args, rest = av_get_token(rest[1:], "[],;")
    assert rest == "[captioned];[captioned]null[out]"
    # Filter level: the path is the whole first (shorthand) value, and no
    # part of it became an option name or leaked into fontsdir.
    expected_path = path.replace("\\", "/") if sys.platform == "win32" else path
    assert filter_options(args) == [(None, expected_path), ("fontsdir", fonts)]


@needs_libass
def test_ass_filter_reads_caption_file_from_hostile_directory(tmp_path):
    ffmpeg, _ = FFMPEG_WITH_ASS
    folder = tmp_path / HOSTILE_DIR
    fonts = folder / "fonts"
    fonts.mkdir(parents=True)
    ass_path = str(folder / "clip-0-6000.ass")
    big_white_ass(ass_path)
    service = RenderingService.__new__(RenderingService)
    service._fonts_dir = str(fonts)
    vf = service._caption_filter(ass_path)
    assert vf.startswith("ass=") and ":fontsdir=" in vf
    # The captions are drawn (the whole frame turns white), so the filename
    # and fontsdir both reached the filter intact.
    assert frame_mean(ffmpeg, vf) > 250


@needs_libass
def test_render_burns_captions_when_the_output_folder_has_an_apostrophe(tmp_path, monkeypatch):
    ffmpeg, ffprobe = FFMPEG_WITH_ASS
    from .test_av_sync import source
    monkeypatch.setenv("PATH", os.path.dirname(ffmpeg) + os.pathsep + os.environ.get("PATH", ""))
    service = RenderingService()
    service._video_codec_args = lambda *args: ["-c:v", "mpeg4", "-q:v", "2", "-bf", "2"]
    monkeypatch.setattr(module, "get_output_dimensions", lambda *_: (180, 320))

    async def plan(request, width, height, start, duration):
        return ClipLayoutPlan([ShotLayout(0, duration, LayoutType.TALKING_HEAD)], width, height)

    monkeypatch.setattr(service, "_plan_layout", plan)
    path = source(tmp_path, duration=6)
    out_dir = tmp_path / HOSTILE_DIR
    out_dir.mkdir()
    transcript = [TranscriptSegment(2100, 2400, "SPEED", words=[TranscriptWord("SPEED", 2100, 2400)])]
    request = RenderRequest(str(path), str(out_dir / "clip.mp4"), 0, 6000, 64, 64, pacing="natural",
                            apply_padding=False, transcript_segments=transcript, include_captions=True)
    result = asyncio.run(service.render_clip(request))
    assert result.render_fallback is None
    means = []
    for timestamp in (2.2, 3.2):
        frame = subprocess.run(
            [ffmpeg, "-v", "error", "-ss", str(timestamp), "-i", result.output_path, "-frames:v", "1",
             "-pix_fmt", "gray", "-f", "rawvideo", "-"], capture_output=True, check=True, timeout=120,
        ).stdout
        means.append(float(np.frombuffer(frame, np.uint8).mean()))
    assert means[0] > means[1] + 1, means  # the caption is on the frame at 2.2 s only


# ------------------------------------------------------------------
# RENDER-2: transcript words inside ASS Dialogue lines
# ------------------------------------------------------------------


def sentence_case_style() -> CaptionStyle:
    style = CaptionStyle()
    style.uppercase = False  # as in the Editorial/Clean presets
    return style


def generate(tmp_path, word: str, style: CaptionStyle, name: str = "c.ass") -> str:
    segment = TranscriptSegment(0, 1000, word, words=[TranscriptWord(word, 0, 1000)])
    path = str(tmp_path / name)
    out = asyncio.run(CaptionGeneratorService().generate_captions(
        [segment], 0, 2000, path, caption_style=style, output_width=180, output_height=320,
    ))
    assert out == path
    return path


def test_transcript_word_cannot_add_ass_sections_or_events(tmp_path):
    path = generate(tmp_path, INJECTED_WORD, sentence_case_style())
    text = open(path, encoding="utf-8").read()
    lines = text.splitlines()
    assert lines.count("[Events]") == 1 and lines.count("[V4+ Styles]") == 1
    assert not any(line.startswith("Style: Evil") for line in lines)
    after_events = text.split("[Events]\n", 1)[1].splitlines()
    assert after_events[0].startswith("Format:")
    assert all(line.startswith("Dialogue: ") for line in after_events[1:] if line)
    # Every Dialogue line still uses the generated style, and the text of the
    # hostile word is on one line.
    for line in after_events[1:]:
        assert line.split(",", 9)[3] == "Default"
    assert "HI [V4+ Styles] Format:" in text
    # Ordinary punctuation is untouched.
    service = CaptionGeneratorService()
    assert service._display_word("Matt's", sentence_case_style()) == "Matt's"
    assert service._display_word("$14,500.", CaptionStyle()) == "$14,500"
    assert service._display_word("really?", CaptionStyle()) == "REALLY?"


@needs_libass
def test_injected_word_does_not_paint_the_frame(tmp_path):
    ffmpeg, _ = FFMPEG_WITH_ASS
    style = sentence_case_style()
    generator = CaptionGeneratorService()
    # Control: the same payload written verbatim (what the generator used to
    # do) covers the whole frame.
    control = tmp_path / "control.ass"
    control.write_text(
        generator._generate_ass_header(style, 180, 320) + generator._events_header()
        + "Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,," + INJECTED_WORD + "\n",
        encoding="utf-8",
    )
    escape = RenderingService._escape_filter_path
    assert frame_mean(ffmpeg, f"ass={escape(str(control))}") > 250
    path = generate(tmp_path, INJECTED_WORD, style)
    assert frame_mean(ffmpeg, f"ass={escape(path)}") < 128


def test_srt_sidecar_keeps_a_word_on_one_line(tmp_path):
    words = [TranscriptWord("one", 0, 400), TranscriptWord("two\n\n2\n00:00:00,000 --> 09:00:00,000\nX", 400, 800)]
    segment = TranscriptSegment(0, 800, "one two", words=words)
    path = CaptionGeneratorService().generate_srt([segment], 0, 2000, str(tmp_path / "c.srt"))
    lines = open(path, encoding="utf-8").read().splitlines()
    assert lines[:2] == ["1", "00:00:00,000 --> 00:00:01,200"]
    assert lines[2:] == ["one two 2 00:00:00,000 --> 09:00:00,000 X"]


# ------------------------------------------------------------------
# RENDER-3: planner (LLM) output on the title card and in timings
# ------------------------------------------------------------------


def test_title_card_is_bounded(tmp_path):
    service = RenderingService.__new__(RenderingService)
    service._font_path = service._resolve_font()
    huge = service._build_title_card("A" * 20000, 1080, 0, str(tmp_path / "huge.png"))
    normal = service._build_title_card("Why Most Developers Get This Wrong", 1080, 0, str(tmp_path / "ok.png"))
    assert huge and normal
    assert huge["width"] <= MAX_TITLE_CHARS * 80  # one line of at most MAX_TITLE_CHARS glyphs
    assert normal["width"] < 1080 and normal["height"] > 0
    assert service._build_title_card("  \n\t ", 1080, 0, str(tmp_path / "empty.png")) is None


@pytest.mark.parametrize("is_landscape", [False, True])
def test_title_card_can_be_turned_off(tmp_path, is_landscape):
    service = RenderingService.__new__(RenderingService)
    service._font_path = service._resolve_font()
    plan = ClipLayoutPlan([ShotLayout(0, 4000, LayoutType.TALKING_HEAD)], 640, 360)
    width, height = (1920, 1080) if is_landscape else (1080, 1920)

    def overlay_paths(**options):
        request = RenderRequest(str(tmp_path / "source.mp4"), str(tmp_path / "clip.mp4"), 0, 4000, 640, 360,
                                title_text="Why Most Developers Get This Wrong", **options)
        return [overlay[0] for overlay in service._overlays(request, plan, width, height, is_landscape)]

    assert overlay_paths() == [str(tmp_path / "title-0-4000.png")]
    assert overlay_paths(include_title=False) == []


def planner_with_state() -> IntelligencePlannerService:
    planner = IntelligencePlannerService()
    planner._current_transcript = []
    planner._current_min_duration = 15
    planner._current_max_duration = 90
    planner._current_duration_ranges = None
    planner._current_video_duration = 600.0
    planner._current_longform = False
    return planner


def completion(clips: list[dict]) -> dict:
    import json
    return {"choices": [{"message": {"content": json.dumps({"insights": "x", "clips": clips})}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2, "cost": 0}}


def test_planner_summary_is_a_bounded_single_line():
    planner = planner_with_state()
    scores = {k: 8 for k in ("hook", "standalone", "arc", "quotability", "ending")}
    response = completion([
        {"start_time": 10, "end_time": 40, "summary": "Line one\n" * 500, "scores": scores, "tags": [], "emphasis": []},
        {"start_time": 100, "end_time": 130, "summary": ["not", "a", "string"], "scores": scores, "tags": [], "emphasis": []},
        {"start_time": 200, "end_time": 230, "summary": "Why Most Developers Get This Wrong", "scores": scores, "tags": [], "emphasis": []},
    ])
    segments = sorted(planner._parse_clip_plan_response(response).segments, key=lambda s: s.start_time_ms)
    assert "\n" not in segments[0].summary and len(segments[0].summary) <= 200
    assert segments[1].summary is None
    assert segments[2].summary == "Why Most Developers Get This Wrong"


def test_longform_timings_beyond_float_range_are_dropped_not_fatal():
    skips = IntelligencePlannerService._clean_skips(
        [{"start_time": 1e308, "end_time": 1e308}, {"start_time": "inf", "end_time": 50}, {"start_time": 20, "end_time": 40}],
        0, 120_000, 60_000, [],
    )
    assert skips == [(20_000, 40_000)]
    chapters = IntelligencePlannerService._clean_chapters(
        [{"time": float("inf"), "title": "Overflow"}, {"time": 1e307, "title": "Far"}, {"time": 30, "title": "Real"}],
        0, 120_000, [], "Intro",
    )
    assert [title for _, title in chapters] == ["Intro", "Real"]
