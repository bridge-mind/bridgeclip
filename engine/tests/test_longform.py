"""
Longform (16:9, 5+ minute) clips: feasible clip counts, the longform planner
prompt and schema, skips and chapters, gentler pacing, source-resolution and
frame-rate output, two-pass loudness, a timed title card, landscape captions
and the SRT sidecar. Ends with a real FFmpeg render.
"""

import asyncio
import json
import os
import shutil
import subprocess

import pytest

from clip_engine.config import Settings, get_caption_preset, get_landscape_dimensions, is_longform
from clip_engine.services import intelligence_planner as planner_module
from clip_engine.services.caption_generator import CaptionGeneratorService
from clip_engine.services.clip_editor import (
    LONGFORM_MIN_PAUSE_MS,
    MIN_PIECE_MS,
    TimeMap,
    WindowWord,
    compute_keep_intervals,
    subtract_intervals,
)
from clip_engine.services.intelligence_planner import IntelligencePlannerService
from clip_engine.services.layout_analyzer import ClipLayoutPlan, LayoutType, ShotLayout
from clip_engine.services.layout_renderer import measured_loudness_filter, shot_chain
from clip_engine.services.rendering_service import RenderingService, RenderRequest
from clip_engine.services.transcription_service import TranscriptSegment, TranscriptionResult, TranscriptWord


def make_transcript(n_sentences, words_per=12, word_ms=300, gap_ms=80, pause_ms=400):
    """Sentences of `words_per` words (~5 s each); each ends with '.'."""
    segments, t = [], 1000
    for s in range(n_sentences):
        words = []
        for w in range(words_per):
            words.append(TranscriptWord(f"w{s}_{w}" + ("." if w == words_per - 1 else ""), t, t + word_ms))
            t += word_ms + gap_ms
        t += pause_ms
        segments.append(TranscriptSegment(
            words[0].start_time_ms, words[-1].end_time_ms, " ".join(x.word for x in words), "S1", words,
        ))
    return segments


def planner_for(transcript, ranges, aspect="16:9"):
    planner = IntelligencePlannerService()
    planner.settings = Settings(_env_file=None, openrouter_api_key="test")
    planner._current_duration_ranges = ranges
    planner._current_min_duration = None
    planner._current_max_duration = None
    planner._current_transcript = transcript
    planner._start_time_seconds = None
    planner._end_time_seconds = None
    planner._current_longform = is_longform(aspect, 600)
    return planner


def completion(clips):
    content = json.dumps({"insights": "podcast", "clips": clips})
    return {"choices": [{"message": {"content": content}, "finish_reason": "stop"}]}


def longform_clip(start, end, skip=(), chapters=(), description="About things."):
    return {
        "start_time": start, "end_time": end, "summary": "The Real Story", "tags": ["a"], "emphasis": [],
        "scores": {k: 7 for k in ("hook", "standalone", "arc", "quotability", "ending")},
        "skip": [{"start_time": a, "end_time": b} for a, b in skip],
        "chapters": [{"time": t, "title": title} for t, title in chapters],
        "description": description,
    }


class TestConfig:
    @pytest.mark.parametrize("src,expected", [
        ((3840, 2160), (3840, 2160)),
        ((2560, 1440), (2560, 1440)),
        ((1920, 1080), (1920, 1080)),
        ((1280, 720), (1920, 1080)),     # never below 1080p
        ((1440, 1080), (1920, 1080)),    # 4:3 fills a 1080p 16:9 frame at most
        ((2880, 2160), (2560, 1440)),    # 4:3 4K fills 1440p
        ((1080, 1920), (1920, 1080)),    # vertical source
        ((0, 0), (1920, 1080)),
    ])
    def test_landscape_dimensions_follow_the_source(self, src, expected):
        assert get_landscape_dimensions(*src) == expected

    def test_longform_is_16_9_and_five_minutes_plus(self):
        assert is_longform("16:9", 600)
        assert is_longform("16:9", 300)
        assert not is_longform("16:9", 120)
        assert not is_longform("9:16", 600)


class TestPlanning:
    def run_plan(self, monkeypatch, transcript, ranges, aspect, clips=()):
        payloads = []

        async def fake_completion(client, payload):
            payloads.append(payload)
            usage = {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2, "cost": 0.0}
            return completion(list(clips)), usage

        monkeypatch.setattr(planner_module, "chat_completion", fake_completion)
        planner = IntelligencePlannerService()
        planner.settings = Settings(_env_file=None, openrouter_api_key="test")
        plan = asyncio.run(planner.plan_clips(
            TranscriptionResult(segments=transcript, full_text=""),
            duration_ranges=ranges, aspect_ratio=aspect,
        ))
        return plan, payloads[0]

    def test_clip_count_is_capped_to_what_fits(self, monkeypatch):
        transcript = make_transcript(300)          # ~25 minutes
        _, payload = self.run_plan(monkeypatch, transcript, ["extended"], "16:9")
        prompt = payload["messages"][0]["content"]
        final = payload["messages"][1]["content"][-1]["text"]
        # 25 minutes fits two 10-minute episodes, not the ~13 the curve asks for.
        assert "up to 2 standalone horizontal episodes" in prompt
        assert "up to 2 complete, self-contained longform episodes" in final
        schema = payload["response_format"]["json_schema"]["schema"]
        item = schema["properties"]["clips"]["items"]
        assert {"skip", "chapters", "description"} <= set(item["required"])

    def test_short_form_prompt_and_schema_are_unchanged(self, monkeypatch):
        transcript = make_transcript(300)
        _, payload = self.run_plan(monkeypatch, transcript, ["short"], "16:9")
        assert "scroll-stopping" in payload["messages"][0]["content"]
        item = payload["response_format"]["json_schema"]["schema"]["properties"]["clips"]["items"]
        assert "skip" not in item["properties"]

    def test_vertical_extended_clips_are_not_longform(self, monkeypatch):
        _, payload = self.run_plan(monkeypatch, make_transcript(300), ["extended"], "9:16")
        assert "senior YouTube editor" not in payload["messages"][0]["content"]

    def test_skips_and_chapters_are_cleaned(self):
        tr = make_transcript(200)
        planner = planner_for(tr, ["extended"])
        start = tr[0].start_time_ms / 1000
        end = tr[159].end_time_ms / 1000                        # ~13 min
        # A 60 s tangent starting mid-sentence, a 3 s "skip" (too short), and
        # a skip outside the clip.
        tangent = (tr[40].start_time_ms / 1000 + 1.0, tr[52].start_time_ms / 1000 + 0.5)
        response = completion([longform_clip(
            start, end,
            skip=[tangent, (tr[80].start_time_ms / 1000, tr[80].start_time_ms / 1000 + 3), (end + 10, end + 60)],
            chapters=[(start + 5, "Opening"), (tr[45].start_time_ms / 1000, "Inside skip"),
                      (tr[100].start_time_ms / 1000, "Main point"), (tr[101].start_time_ms / 1000, "Too close")],
        )])
        seg = planner._parse_clip_plan_response(response).segments[0]
        assert len(seg.skip_ranges_ms) == 1
        s_ms, e_ms = seg.skip_ranges_ms[0]
        ends = {s.words[-1].end_time_ms for s in tr}
        starts = {s.start_time_ms for s in tr}
        assert s_ms in ends and e_ms in starts                  # clean sentence-to-sentence jump
        titles = [title for _, title in seg.chapters]
        assert seg.chapters[0][0] == seg.start_time_ms
        assert titles == ["Opening", "Inside skip", "Main point"]
        assert seg.chapters[1][0] == e_ms                        # moved out of the skip
        assert seg.description == "About things."

    def test_skips_never_cut_below_the_minimum_runtime(self):
        tr = make_transcript(200)
        planner = planner_for(tr, ["extended"])                 # 600 s minimum
        start = tr[0].start_time_ms / 1000
        end = tr[125].end_time_ms / 1000                        # ~10.5 min
        big = (tr[20].start_time_ms / 1000, tr[60].start_time_ms / 1000)   # ~3.3 min
        seg = planner._parse_clip_plan_response(completion([longform_clip(start, end, skip=[big])])).segments[0]
        assert seg.skip_ranges_ms == []


class TestPacing:
    def test_longform_keeps_natural_pauses(self):
        words = [WindowWord(0, 900, "a"), WindowWord(2000, 2900, "b"), WindowWord(5000, 5900, "c")]
        head = ClipLayoutPlan([ShotLayout(0, 6000, LayoutType.TALKING_HEAD)], 1920, 1080)
        tight = compute_keep_intervals(words, 6000, head)
        longform = compute_keep_intervals(words, 6000, head, longform=True)
        # The 1.1 s pause survives in longform; the 2.1 s one is still trimmed.
        assert len(tight) > len(longform)
        assert any(s <= 1000 and e >= 1900 for s, e in longform)
        assert 2100 > LONGFORM_MIN_PAUSE_MS
        assert sum(e - s for s, e in longform) < 6000

    def test_subtract_intervals(self):
        keeps = [(0, 10_000), (12_000, 30_000)]
        out = subtract_intervals(keeps, [(5_000, 15_000)])
        assert out[0][0] == 0 and abs(out[0][1] - 5_000) <= 34
        assert abs(out[1][0] - 15_000) <= 34 and out[1][1] == 30_000
        # A sliver left behind by a skip is dropped rather than flashed.
        sliver = subtract_intervals([(0, 10_000)], [(0, 10_000 - MIN_PIECE_MS // 2)])
        assert sliver == [(0, 10_000)] or all(e - s >= MIN_PIECE_MS for s, e in sliver)
        assert subtract_intervals(keeps, []) == keeps


class TestRendering:
    def test_measured_loudness_is_linear(self):
        measured = {"input_i": "-23.4", "input_tp": "-5.1", "input_lra": "6.2",
                    "input_thresh": "-33.9", "target_offset": "0.3"}
        f = measured_loudness_filter(measured)
        assert "measured_I=-23.40" in f and "linear=true" in f
        assert measured_loudness_filter({**measured, "input_i": "-inf"}) is None
        assert measured_loudness_filter({}) is None

    def test_landscape_chain_blurs_non_16_9_sources(self):
        shot = ShotLayout(0, 1000, LayoutType.SCREEN)
        assert "gblur" not in shot_chain(0, shot, 1920, 1080, 1920, 1080, landscape=True)
        assert "gblur" not in shot_chain(0, shot, 1920, 1088, 1920, 1080, landscape=True)
        assert "gblur" in shot_chain(0, shot, 1440, 1080, 1920, 1080, landscape=True)
        assert "gblur" in shot_chain(0, shot, 1080, 1920, 1920, 1080, landscape=True)

    def test_timed_overlay(self):
        graph, inputs = RenderingService._compose_overlays(
            "[0:v]null[captioned]",
            [("title.png", "(W-w)/2", "40", "between(t,0.4,5.5)", "format=rgba"), ("b.png", "W-w", "H-h")],
        )
        assert inputs == ["title.png", "b.png"]
        assert "[1:v]format=rgba[img1]" in graph
        assert "[captioned][img1]overlay=x='(W-w)/2':y='40':shortest=1:enable='between(t,0.4,5.5)'[ov1]" in graph
        assert "[ov1][2:v]overlay" in graph

    def test_chapters_follow_the_edit(self):
        request = RenderRequest("in.mp4", "out.mp4", 100_000, 700_000, 1920, 1080,
                                chapters=[(100_000, "Intro"), (280_000, "Middle"), (285_000, "Close"),
                                          (500_000, "End")])
        time_map = TimeMap([(0, 150_000), (250_000, 600_000)], 600_000)
        chapters = RenderingService._output_chapters(request, 100_000, time_map)
        # "Middle" sat in the cut and lands where the edit resumes; "Close" is
        # under 10 s after it and dropped.
        assert chapters == [(0, "Intro"), (150_000, "Middle"), (300_000, "End")]

    def test_landscape_caption_style_is_scaled(self):
        style = get_caption_preset("pop")
        scaled = RenderingService._landscape_caption_style(style, 1080)
        assert scaled.font_size == round(style.font_size * 0.65)
        assert scaled.max_words_per_line >= 6
        assert style.font_size != scaled.font_size                       # preset untouched
        assert RenderingService._landscape_caption_style(style, 2160).font_size == round(style.font_size * 1.3)

    def test_srt_sidecar(self, tmp_path):
        tr = make_transcript(6)
        path = CaptionGeneratorService().generate_srt(tr, 1000, 40_000, str(tmp_path / "c.srt"))
        text = open(path).read()
        blocks = text.strip().split("\n\n")
        assert blocks[0].startswith("1\n00:00:00,000 --> ")
        for block in blocks:
            lines = block.split("\n")
            assert len(lines) <= 4 and all(len(line) <= 60 for line in lines[2:])
        assert CaptionGeneratorService().generate_srt([], 0, 1000, str(tmp_path / "x.srt")) is None


# The render needs libass (burned captions). TEST_FFMPEG_DIR points at a
# directory holding ffmpeg + ffprobe, e.g. BridgeClip's bundled engine-bin.
TEST_FFMPEG_DIR = os.environ.get("TEST_FFMPEG_DIR") or os.path.dirname(shutil.which("ffmpeg") or "")


def _ffmpeg_has(kind: str, name: str) -> bool:
    binary = os.path.join(TEST_FFMPEG_DIR, "ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if not os.path.isfile(binary):
        return False
    listing = subprocess.run([binary, "-hide_banner", f"-{kind}"], capture_output=True, text=True).stdout
    return any(line.split()[1:2] == [name] for line in listing.splitlines() if line.strip())


@pytest.mark.skipif(not _ffmpeg_has("filters", "ass"), reason="FFmpeg with libass not available")
def test_longform_render_end_to_end(tmp_path, monkeypatch):
    """A 4:3 60 fps source renders at 60 fps in 1080p 16:9, with the skip cut
    out, captions, a timed title card, two-pass loudness, chapters and an SRT sidecar."""
    monkeypatch.setenv("PATH", TEST_FFMPEG_DIR + os.pathsep + os.environ.get("PATH", ""))
    videotoolbox_only = not _ffmpeg_has("encoders", "libx264")
    encoder = ["-c:v", "h264_videotoolbox", "-b:v", "4M"] if videotoolbox_only else ["-c:v", "libx264", "-preset", "ultrafast"]
    src = str(tmp_path / "src.mp4")
    subprocess.run([
        "ffmpeg", "-v", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=1440x1080:rate=60:duration=30",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=30",
        *encoder, "-c:a", "aac", "-shortest", src,
    ], check=True)
    tr = make_transcript(5, words_per=10)                        # speech from 1 s to ~22 s
    monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda self: None)
    service = RenderingService()
    service.settings = Settings(_env_file=None, local_mode=videotoolbox_only)
    request = RenderRequest(
        video_path=src, output_path=str(tmp_path / "out" / "clip.mp4"),
        start_time_ms=0, end_time_ms=30_000, source_width=1440, source_height=1080,
        transcript_segments=tr, include_captions=True, title_text="The Real Story",
        aspect_ratio="16:9", pacing="natural", longform=True,
        skip_ranges_ms=[(10_000, 20_000)], chapters=[(0, "Start"), (21_000, "After")],
    )
    result = asyncio.run(service.render_clip(request))
    probe = json.loads(subprocess.run([
        "ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height,avg_frame_rate",
        "-show_entries", "format=duration", "-of", "json", result.output_path,
    ], capture_output=True, check=True).stdout)
    video = next(s for s in probe["streams"] if s["codec_type"] == "video")
    assert (video["width"], video["height"]) == (1920, 1080)
    assert video["avg_frame_rate"] == "60/1"
    duration = float(probe["format"]["duration"])
    assert 19.5 < duration < 21.5                               # 30 s window minus the 10 s skip
    assert result.render_fallback is None
    assert result.chapters[0] == (0, "Start")
    assert result.subtitle_path and os.path.isfile(result.subtitle_path)
