"""Unit tests for caption generation timing and reveal behavior."""

from clip_engine.config import CaptionStyle
from clip_engine.services.caption_generator import CaptionGeneratorService
from clip_engine.services.rendering_service import RenderingService
from clip_engine.services.transcription_service import TranscriptWord


def _events(style, words, emphasis=None, tmp_path=None):
    import asyncio

    from clip_engine.services.transcription_service import TranscriptSegment

    out = tmp_path / "c.ass"
    asyncio.run(CaptionGeneratorService().generate_captions(
        transcript_segments=[TranscriptSegment(
            words[0].start_time_ms, words[-1].end_time_ms,
            " ".join(w.word for w in words), words=words,
        )],
        clip_start_ms=0, clip_end_ms=words[-1].end_time_ms + 2000, output_path=str(out),
        caption_style=style, emphasis_words=emphasis,
    ))
    return [l for l in out.read_text().splitlines() if l.startswith("Dialogue:")]


WORDS = [
    TranscriptWord(word="We", start_time_ms=0, end_time_ms=300),
    TranscriptWord(word="made", start_time_ms=300, end_time_ms=600),
    TranscriptWord(word="$14,500.", start_time_ms=600, end_time_ms=1200),
]


def test_every_preset_renders_layered_events(tmp_path):
    from clip_engine.config import get_available_presets, get_caption_preset

    for preset in get_available_presets():
        events = _events(get_caption_preset(preset["id"]), WORDS, tmp_path=tmp_path)
        assert events, preset["id"]
        # The crisp face is always the top layer.
        assert any(e.startswith("Dialogue: 4,") for e in events), preset["id"]


def test_hide_mode_hides_future_words_on_the_face(tmp_path):
    style = CaptionStyle()
    style.future_words = "hide"
    style.uppercase = False
    face = [e for e in _events(style, WORDS, tmp_path=tmp_path) if e.startswith("Dialogue: 4,")]
    assert "\\alpha&HFF&" in face[0].split("}made")[0].rsplit("{", 1)[1]
    assert "\\alpha&HFF&" not in face[-1]


def test_group_pops_in_once(tmp_path):
    style = CaptionStyle()
    face = [e for e in _events(style, WORDS, tmp_path=tmp_path) if e.startswith("Dialogue: 4,")]
    assert "\\fscx82" in face[0]
    assert not any("\\fscx82" in e for e in face[1:])


def test_group_clears_after_linger(tmp_path):
    from clip_engine.services.caption_generator import MAX_LINGER_MS

    events = _events(CaptionStyle(), WORDS, tmp_path=tmp_path)
    last_end = max(CaptionGeneratorService._parse_ass_time(e.split(",")[2]) for e in events)
    assert last_end == WORDS[-1].end_time_ms + MAX_LINGER_MS


def test_silence_breaks_group_and_clears_before_next_word(tmp_path):
    from clip_engine.services.caption_generator import MAX_LINGER_MS

    words = [
        TranscriptWord(word="Wait", start_time_ms=0, end_time_ms=300),
        TranscriptWord(word="Hello", start_time_ms=3500, end_time_ms=3900),
    ]
    face = [e for e in _events(CaptionStyle(), words, tmp_path=tmp_path) if e.startswith("Dialogue: 4,")]
    assert len(face) == 2
    first_end = CaptionGeneratorService._parse_ass_time(face[0].split(",")[2])
    second_start = CaptionGeneratorService._parse_ass_time(face[1].split(",")[1])
    assert first_end == 300 + MAX_LINGER_MS
    assert second_start == 3500
    assert "HELLO" not in face[0]


def test_trailing_punctuation_dropped():
    service = CaptionGeneratorService()
    style = CaptionStyle()
    assert service._display_word("business.", style) == "BUSINESS"
    assert service._display_word("really?", style) == "REALLY?"
    assert service._display_word("{bad}", style) == "BAD"


def test_provider_line_breaks_cannot_inject_subtitle_script_lines(tmp_path):
    from clip_engine.config import get_caption_preset
    from clip_engine.services.transcription_service import TranscriptSegment

    injected = ("hi\r\n[V4+ Styles]\nStyle: Default,Arial,400,&H000000FF,&H000000FF,&H0,&H0,0,0,0,0,"
                "100,100,0,0,1,0,0,5,0,0,0,1\n[Events]\nDialogue: 9,0:00:00.00,9:00:00.00,Default,,0,0,0,,INJECTED")
    words = [WORDS[0], TranscriptWord(word=injected, start_time_ms=300, end_time_ms=600), WORDS[2]]
    events = _events(get_caption_preset("editorial"), words, tmp_path=tmp_path)
    lines = (tmp_path / "c.ass").read_text().splitlines()
    assert sum(line.startswith("Style:") for line in lines) == 1
    assert sum(line.startswith("[") for line in lines) == 3
    assert not any(line.startswith("Dialogue: 9,") for line in lines)
    assert all(line.startswith("Dialogue: ") for line in lines[lines.index("[Events]") + 2:])
    assert events

    cue = TranscriptWord(word="hi\n\n2\n00:00:00,000 --> 09:00:00,000\nFAKE", start_time_ms=300, end_time_ms=600)
    srt = CaptionGeneratorService().generate_srt(
        [TranscriptSegment(0, 1200, "x", words=[WORDS[0], cue, WORDS[2]])], 0, 2000, str(tmp_path / "c.srt"))
    blocks = open(srt, encoding="utf-8").read().strip().split("\n\n")
    assert len(blocks) == 1 and len(blocks[0].splitlines()) <= 4


def test_karaoke_sweep_spans_gaps_between_words(tmp_path):
    from clip_engine.config import get_caption_preset

    words = [
        TranscriptWord(word="one", start_time_ms=0, end_time_ms=200),
        TranscriptWord(word="two", start_time_ms=500, end_time_ms=700),
    ]
    face = [e for e in _events(get_caption_preset("sweep"), words, tmp_path=tmp_path)
            if e.startswith("Dialogue: 4,")]
    assert len(face) == 1
    assert "\\kf50" in face[0] and "\\kf20" in face[0]


def test_emphasis_words_get_accent_color(tmp_path):
    from clip_engine.config import get_caption_preset

    style = get_caption_preset("pop")
    events = [e for e in _events(style, WORDS, ["14,500"], tmp_path) if e.startswith("Dialogue: 4,")]
    accent = CaptionGeneratorService()._hex_to_ass(style.emphasis_color)
    # Emphasized before it's spoken and while spoken, never for other words.
    assert all(f"\\1c{accent}}}$14,500" in e for e in events)
    assert not any(f"{accent}}}WE" in e or f"{accent}}}MADE" in e for e in events)


def test_caption_timebase_includes_audio_padding(monkeypatch, tmp_path):
    """Captions are timed against the padded render window and end with the edited output."""
    import asyncio

    from clip_engine.services.clip_editor import TimeMap
    from clip_engine.services.layout_analyzer import ClipLayoutPlan, LayoutType, ShotLayout
    from clip_engine.services.rendering_service import RenderRequest
    from clip_engine.services.transcription_service import TranscriptSegment

    monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda self: None)
    service = RenderingService()
    captured = {}

    async def fake_generate(**kwargs):
        captured.update(kwargs)
        return None

    monkeypatch.setattr(service.caption_generator, "generate_captions", fake_generate)

    start_ms, duration_ms = 1000, 2000
    window_start_ms, window_ms = service._compute_padded_range(start_ms, duration_ms)
    words = [TranscriptWord(word="hello", start_time_ms=1200, end_time_ms=1600)]
    request = RenderRequest(
        video_path="in.mp4", output_path=str(tmp_path / "out.mp4"),
        start_time_ms=start_ms, end_time_ms=start_ms + duration_ms,
        source_width=1920, source_height=1080,
        transcript_segments=[TranscriptSegment(1200, 1600, "hello", words=words)],
    )
    plan = ClipLayoutPlan([ShotLayout(0, window_ms, LayoutType.SCREEN)], 1920, 1080)
    asyncio.run(service._generate_captions(
        request, 1080, 1920, window_start_ms, TimeMap([(0, window_ms)]), plan, False,
    ))

    pad_ms = service.settings.audio_padding_ms
    assert captured["clip_start_ms"] == start_ms - pad_ms
    assert captured["clip_end_ms"] == start_ms + duration_ms + pad_ms
