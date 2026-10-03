import asyncio
import json
import os
import re
import sys
import shutil
import subprocess
from dataclasses import make_dataclass
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from clip_engine.config import CaptionStyle, Settings, get_caption_preset
from clip_engine.custom_captions import resolve_caption_style, validate_custom_caption
from clip_engine.services.caption_generator import CaptionGeneratorService
from clip_engine.services.transcription_service import TranscriptSegment, TranscriptWord

ROOT = Path(__file__).resolve().parents[2]
DEFAULTS = json.loads((ROOT / 'src/shared/caption-style-defaults.ts').read_text().split('export default ', 1)[1].rsplit(' as const', 1)[0])


def custom():
    return {'id': 'custom-test', 'name': 'My Pop', 'baseId': 'pop', 'style': dict(DEFAULTS['pop'])}


def test_lab_starting_values_match_every_engine_preset():
    for name, fields in DEFAULTS.items():
        assert set(fields) == set(CaptionStyle.__annotations__) - {'emphasis_color', 'line_box_padding_x', 'line_box_padding_y'}
        base = get_caption_preset(name)
        assert base.line_box_padding_x is None and base.line_box_padding_y is None
        for key, value in fields.items():
            assert getattr(base, key) == value, (name, key)


@pytest.mark.parametrize('base', list(DEFAULTS))
def test_custom_styles_keep_all_rendering_details_after_the_default_is_removed(base, monkeypatch, tmp_path):
    import clip_engine.custom_captions as module
    complete = {'id': 'custom-retired', 'name': 'Independent', 'baseId': base, 'style': dict(DEFAULTS[base])}
    legacy = {**complete, 'style': {k: v for k, v in complete['style'].items() if k not in module.LEGACY_RENDERING['common']}}
    expected = resolve_caption_style(base, complete)
    monkeypatch.setattr(module, 'get_caption_preset', lambda _: pytest.fail('Custom captions must not read the default catalog'))
    retired = {**complete, 'baseId': 'retired-default'}
    for snapshot in (legacy, retired):
        restored = resolve_caption_style(snapshot['baseId'], snapshot)
        assert {k: getattr(restored, k) for k in CaptionStyle.__annotations__} == {k: getattr(expected, k) for k in CaptionStyle.__annotations__}
    words = [TranscriptWord('Keep', 0, 300), TranscriptWord('this', 300, 600), TranscriptWord('look', 600, 900)]
    transcript = [TranscriptSegment(0, 900, 'Keep this look', words=words)]
    contents = []
    for index, snapshot in enumerate((complete, legacy, retired)):
        output = tmp_path / f'{index}.ass'
        asyncio.run(CaptionGeneratorService().generate_captions(transcript, 0, 1000, str(output),
            caption_style=resolve_caption_style(snapshot['baseId'], snapshot)))
        contents.append(output.read_text())
    assert contents[0] == contents[1] == contents[2]


def test_clipping_mode_labels_match_the_models_used_to_find_moments():
    labels = (ROOT / 'src/shared/clipping-modes.ts').read_text()
    settings = Settings(_env_file=None)
    quality = re.search(r"quality: \{ planner: '([^']+)'", labels)[1]
    economy = re.search(r"economy: \{ planner: '([^']+)'", labels)[1]
    assert quality == settings.planner_model
    assert f'os.environ["PLANNER_MODEL"] = "{economy}"' in (ROOT / 'bridge/bridge_runner.py').read_text()
    assert settings.editorial_repair_model == 'openai/gpt-6-sol'


@pytest.mark.parametrize('patch', [{'font_size': 2000}, {'outline_width': -1}, {'font_name': 'file:///tmp/custom.ttf'}, {'font_name': []},
    {'primary_color': '{\\pos(0,0)}'}, {'line_box_opacity': float('nan')}, {'uppercase': 1}, {'shell': 'bad'}])
def test_invalid_custom_styles_are_rejected(patch):
    snapshot = custom()
    snapshot['style'].update(patch)
    with pytest.raises(ValueError):
        validate_custom_caption(snapshot, 'pop')


def test_legacy_custom_captions_normalize_to_automatic_lines():
    snapshot = custom()
    snapshot['style'].pop('max_lines', None)
    normalized = validate_custom_caption(snapshot)
    assert normalized['style'] == {**snapshot['style'], 'max_lines': None}
    assert 'max_lines' not in snapshot['style']
    assert resolve_caption_style('pop', snapshot).max_lines is None
    for limit in (None, 1, 2, 3):
        snapshot['style']['max_lines'] = limit
        assert validate_custom_caption(snapshot)['style']['max_lines'] == limit


@pytest.mark.parametrize('axis', ['line_box_padding_x', 'line_box_padding_y'])
@pytest.mark.parametrize('value', [None, False, -1, 41, 1.5, '10'])
def test_invalid_background_padding_is_rejected(axis, value):
    snapshot = custom()
    snapshot['style'][axis] = value
    with pytest.raises(ValueError):
        validate_custom_caption(snapshot)


def test_background_padding_preserves_legacy_exports_and_scales_each_axis(tmp_path):
    from clip_engine.services.rendering_service import RenderingService

    snapshot = custom()
    snapshot['style'].update(line_box_color='#00FF00', line_box_padding=31, outline_width=0, shadow_opacity=0, entrance_pop=False)
    service = CaptionGeneratorService()
    legacy = resolve_caption_style('pop', snapshot)
    equal = resolve_caption_style('pop', {**snapshot, 'style': {**snapshot['style'], 'line_box_padding_x': 31, 'line_box_padding_y': 31}})
    assert service._plate_tags(None, legacy) == service._plate_tags(None, equal)
    assert service._block_size(['Hello'], legacy, 1080) == service._block_size(['Hello'], equal, 1080)
    snapshot['style'].update(line_box_padding_x=40, line_box_padding_y=0)
    style = resolve_caption_style('pop', snapshot)
    assert r'\xbord40\ybord0' in service._plate_tags(None, style)
    size = service._block_size(['Hello'], style, 1080)
    style.line_box_padding_y = 20
    taller = service._block_size(['Hello'], style, 1080)
    assert taller[0] == size[0] and taller[1] == size[1] + 40
    style.line_box_padding_x = 10
    narrower = service._block_size(['Hello'], style, 1080)
    assert narrower[0] == taller[0] - 60 and narrower[1] == taller[1]
    scaled = RenderingService._landscape_caption_style(style, 1080)
    assert (scaled.line_box_padding_x, scaled.line_box_padding_y) == (6, 13)
    assert (style.line_box_padding_x, style.line_box_padding_y) == (10, 20)


def test_background_padding_changes_only_its_axis_in_baked_pixels(tmp_path):
    import numpy as np
    from PIL import Image

    ffmpeg = str(ROOT / 'engine-bin/ffmpeg') if (ROOT / 'engine-bin/ffmpeg').exists() else shutil.which('ffmpeg')
    if not ffmpeg:
        pytest.skip('FFmpeg is needed for the background render check')
    bounds = []
    for x, y in [(10, 8), (35, 8), (35, 30)]:
        snapshot = custom()
        snapshot['style'].update(line_box_color='#00FF00', line_box_opacity=1, line_box_padding_x=x, line_box_padding_y=y,
            primary_color='#FFFFFF', highlight_color='#FFFFFF', outline_width=0, shadow_opacity=0, entrance_pop=False)
        ass = tmp_path / f'padding-{x}-{y}.ass'
        asyncio.run(CaptionGeneratorService().generate_captions([TranscriptSegment(0, 1000, 'Hello')],
            0, 1000, str(ass), caption_style=resolve_caption_style('pop', snapshot), output_width=600, output_height=1000))
        frame = ass.with_suffix('.png')
        subprocess.run([ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=600x1000:r=1:d=1',
            '-vf', f'ass={ass}:fontsdir={ROOT / "engine/assets/fonts"}', '-frames:v', '1', str(frame)],
            capture_output=True, check=True, timeout=30)
        pixels = np.asarray(Image.open(frame).convert('RGB'))
        rows, columns = np.where((pixels[:, :, 1] > 100) & (pixels[:, :, 0] < 40) & (pixels[:, :, 2] < 40))
        bounds.append((columns.min(), columns.max(), rows.min(), rows.max()))
    normal, wide, tall = bounds
    assert normal[2:] == wide[2:]
    assert abs((wide[1] - wide[0]) - (normal[1] - normal[0]) - 50) <= 2
    assert wide[:2] == tall[:2]
    assert abs((tall[3] - tall[2]) - (wide[3] - wide[2]) - 44) <= 2


@pytest.mark.parametrize('limit', [False, True, 0, -1, 4, 1.5, '2', [], {}])
def test_invalid_line_caps_are_rejected(limit):
    snapshot = custom()
    snapshot['style']['max_lines'] = limit
    with pytest.raises(ValueError):
        validate_custom_caption(snapshot)


def _line_cap_captions(tmp_path, limit, karaoke=False, timed=True, pill=False):
    snapshot = custom()
    snapshot['style'].update(font_size=160, uppercase=False, max_words_per_line=6,
        max_lines=limit, entrance_pop=False, karaoke_fill=karaoke, highlight_box_color='#123456' if pill else None)
    style = resolve_caption_style('pop', snapshot)
    words = [TranscriptWord(word, index * 400, index * 400 + 300)
             for index, word in enumerate(['Build', 'better', 'ideas', 'work', 'fresh', 'today!'])]
    transcript = [TranscriptSegment(0, 2400, ' '.join(w.word for w in words), words=words if timed else [])]
    output = tmp_path / f'lines-{limit}-{karaoke}-{timed}-{pill}.ass'
    asyncio.run(CaptionGeneratorService().generate_captions(transcript, 0, 3000, str(output), caption_style=style,
        output_width=600, output_height=1000))
    return style, words, output.read_text()


@pytest.mark.parametrize('limit', [1, 2, 3])
@pytest.mark.parametrize('karaoke,pill', [(False, False), (True, False), (False, True)])
def test_line_caps_preserve_words_timing_font_size_and_karaoke(tmp_path, limit, karaoke, pill):
    style, words, ass = _line_cap_captions(tmp_path, limit, karaoke, pill=pill)
    service = CaptionGeneratorService()
    face = [line.split(',', 9) for line in ass.splitlines() if line.startswith('Dialogue: 4,')]
    groups = []
    for fields in face:
        text = fields[9]
        assert '\\q2\\fs160' in text
        assert text.count('\\N') < limit
        shown = re.sub(r'\{[^}]*\}', '', text).replace('\\h', ' ')
        lines = shown.split('\\N')
        assert all(service._text_width(line, style) <= 480 for line in lines)
        group = shown.replace('\\N', ' ').split()
        assert len(group) <= style.max_words_per_line
        assert len(lines) == min(limit, len(group))
        if not groups or groups[-1] != group:
            groups.append(group)
    assert [word for group in groups for word in group] == [w.word for w in words]
    if karaoke:
        assert len(face) == len(groups)
        for fields, group in zip(face, groups):
            first_index = [w.word for w in words].index(group[0])
            assert service._parse_ass_time(fields[1]) == words[first_index].start_time_ms
            assert [int(v) for v in re.findall(r'\\kf(\d+)', fields[9])] == [40] * (len(group) - 1) + [30]
    else:
        assert [service._parse_ass_time(fields[1]) for fields in face] == [w.start_time_ms for w in words]
    # The cap applies to backing/glow/pill/shadow layers, not just the face.
    assert all('\\q2' in line and line.count('\\N') < limit
               for line in ass.splitlines() if line.startswith('Dialogue:'))


@pytest.mark.parametrize('limit', [1, 2, 3])
def test_segment_fallback_respects_line_caps_without_losing_text(tmp_path, limit):
    _, words, ass = _line_cap_captions(tmp_path, limit, timed=False)
    face = [line.split(',', 9) for line in ass.splitlines() if line.startswith('Dialogue: 4,')]
    assert all(fields[9].count('\\N') < limit for fields in face)
    assert [word for fields in face for word in re.sub(r'\{[^}]*\}', '', fields[9]).replace('\\N', ' ').split()] == [w.word for w in words]
    assert CaptionGeneratorService._parse_ass_time(face[0][1]) == 0
    assert CaptionGeneratorService._parse_ass_time(face[-1][2]) == 2400


@pytest.mark.parametrize('limit', [1, 2, 3])
@pytest.mark.parametrize('karaoke', [False, True])
def test_numeric_lines_split_normal_sized_groups_even_when_they_fit_one_row(tmp_path, limit, karaoke):
    style = get_caption_preset('pop')
    style.font_size, style.max_words_per_line, style.max_lines = 76, 3, limit
    style.karaoke_fill = karaoke
    words = [TranscriptWord(word, i * 400, i * 400 + 300)
             for i, word in enumerate(['MAKE', 'EACH', 'MOMENT', 'LOOK', 'EVEN', 'BETTER!'])]
    service = CaptionGeneratorService()
    groups = service._group_words(words, 3)
    assert all(service._text_width(group.text, style) < 960 for group in groups)
    assert service._cap_word_groups(groups, style, 1080) == groups
    output = tmp_path / 'numeric-lines.ass'
    asyncio.run(service.generate_captions([TranscriptSegment(0, 2400, ' '.join(w.word for w in words), words=words)],
        0, 3000, str(output), caption_style=style))
    events = [line.split(',', 9) for line in output.read_text().splitlines() if line.startswith('Dialogue:')]
    assert all(fields[9].count('\\N') == limit - 1 and '\\fs76' in fields[9] for fields in events)
    face = [fields for fields in events if fields[0] == 'Dialogue: 4']
    assert len(face) == (2 if karaoke else 6)
    assert [service._parse_ass_time(fields[1]) for fields in face] == ([0, 1200] if karaoke else [w.start_time_ms for w in words])
    for index, fields in enumerate(face):
        shown = re.sub(r'\{[^}]*\}', '', fields[9]).replace('\\N', ' ').split()
        group = groups[index if karaoke else index // 3]
        assert shown == [w.word for w in group.words]


def test_balanced_rows_minimize_width_and_prefer_fuller_early_rows_on_ties(monkeypatch):
    service = CaptionGeneratorService()
    style = get_caption_preset('pop')
    monkeypatch.setattr(service, '_text_width', lambda text, _: len(text))
    style.max_lines = 2
    assert service._line_ends(['A', 'B', 'C', 'D', 'E'], style, 1080) == [3, 5]
    assert service._line_ends(['LONG', 'A', 'B'], style, 1080) == [1, 3]
    style.max_lines = 3
    assert service._line_ends(['A', 'B', 'C', 'D', 'E', 'F'], style, 1080) == [2, 4, 6]
    assert service._line_ends(['ONE', 'TWO'], style, 1080) == [1, 2]
    style.max_lines = None
    assert service._line_ends(['ONE', 'TWO', 'THREE'], style, 1080) == [3]


def test_line_measurements_include_pill_spacing_and_oversize_words_stay_separate():
    service = CaptionGeneratorService()
    style = get_caption_preset('pop')
    style.max_lines = 3
    style.font_size = 160
    style.letter_spacing = 2
    width = 120 + service._text_width('HI HI', style) + 1
    assert service._greedy_line_ends(['HI', 'HI'], style, width) == [2]
    style.highlight_box_color = '#123456'
    assert service._greedy_line_ends(['HI', 'HI'], style, width) == [1, 2]
    word = 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS'
    words = [TranscriptWord(text, i * 400, i * 400 + 300) for i, text in enumerate(['HI', word, 'AGAIN!'])]
    groups = service._cap_word_groups(service._group_words(words, 6), style, 600)
    assert [group.words for group in groups] == [[words[0]], [words[1]], [words[2]]]
    fitted = service._fit_single_word([word], style, 600)
    assert fitted.font_size < 160
    assert service._text_width(word, fitted) <= 480
    assert style.font_size == 160


def test_capped_groups_keep_original_punctuation_boundaries_and_word_timestamps():
    service = CaptionGeneratorService()
    style = get_caption_preset('pop')
    style.max_lines, style.max_words_per_line = 3, 6
    words = [TranscriptWord(text, 100 + i * 350, 400 + i * 350)
             for i, text in enumerate(['Hello,', 'world,', 'why?', 'That', 'works.'])]
    original = service._group_words(words, style.max_words_per_line)
    capped = service._cap_word_groups(original, style, 400)
    assert [word for group in capped for word in group.words] == words
    assert all(any(group.start_time_ms >= base.start_time_ms and group.end_time_ms <= base.end_time_ms
                   for base in original) for group in capped)


def test_automatic_line_layout_remains_unchanged_for_legacy_snapshots(tmp_path):
    snapshot = custom()
    snapshot['style'].pop('max_lines', None)
    legacy = resolve_caption_style('pop', snapshot)
    explicit = resolve_caption_style('pop', {**snapshot, 'style': {**snapshot['style'], 'max_lines': None}})
    words = [TranscriptWord('old', 0, 300), TranscriptWord('captions!', 300, 600)]
    transcript = [TranscriptSegment(0, 600, 'old captions!', words=words)]
    contents = []
    for index, style in enumerate((legacy, explicit)):
        output = tmp_path / f'auto-{index}.ass'
        asyncio.run(CaptionGeneratorService().generate_captions(transcript, 0, 1000, str(output), caption_style=style))
        contents.append(output.read_text())
    assert contents[0] == contents[1]
    assert '\\q2' not in contents[0]


@pytest.mark.parametrize('limit', [1, 2, 3])
@pytest.mark.parametrize('font_size,output_width,text', [(160, 600, 'BUILD BETTER IDEAS WORK FRESH TODAY!'),
    (76, 1080, 'MAKE EACH MOMENT')])
def test_rendered_caption_pixels_use_selected_line_count(tmp_path, limit, font_size, output_width, text):
    import numpy as np
    from PIL import Image

    ffmpeg = str(ROOT / 'engine-bin/ffmpeg') if (ROOT / 'engine-bin/ffmpeg').exists() else shutil.which('ffmpeg')
    if not ffmpeg:
        pytest.skip('FFmpeg is needed for the caption line render check')
    filters = subprocess.run([ffmpeg, '-hide_banner', '-filters'], capture_output=True, text=True, check=True).stdout
    if not re.search(r'\bass\s+V->V', filters):
        pytest.skip('FFmpeg needs libass for the caption line render check')
    style = get_caption_preset('pop')
    style.max_lines, style.max_words_per_line, style.font_size = limit, 6, font_size
    style.shadow_opacity, style.outline_width, style.entrance_pop = 0, 0, False
    words = [TranscriptWord(word, i * 400, i * 400 + 300)
             for i, word in enumerate(text.split())]
    output = tmp_path / 'render-lines.ass'
    measured = []
    def place(start, end, width, height):
        measured.append((width, height))
        return 5, 500
    asyncio.run(CaptionGeneratorService().generate_captions(
        [TranscriptSegment(0, 2400, ' '.join(w.word for w in words), words=words)], 0, 3000, str(output),
        caption_style=style, output_width=output_width, output_height=1000, placer=place))
    frame = tmp_path / 'lines.png'
    subprocess.run([ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', f'color=c=black:s={output_width}x1000:r=1:d=1',
        '-vf', f'ass={output}:fontsdir={ROOT / "engine/assets/fonts"}', '-frames:v', '1', str(frame)],
        capture_output=True, check=True, timeout=30)
    pixels = np.asarray(Image.open(frame).convert('RGB'))
    occupied = np.any(pixels.max(axis=2) > 150, axis=1)
    bands = int(occupied[0]) + np.count_nonzero(occupied[1:] & ~occupied[:-1])
    assert bands == limit
    rows, columns = np.where(pixels.max(axis=2) > 150)
    assert columns.min() >= 55 and columns.max() <= output_width - 55
    assert rows.max() - rows.min() <= measured[0][1]


def test_snapshot_colors_font_and_animation_reach_ass_export(tmp_path):
    snapshot = custom()
    snapshot['style'].update(font_size=110, primary_color='#123456', highlight_color='#ABCDEF',
        karaoke_fill=True, entrance_pop=False, max_words_per_line=2)
    style = resolve_caption_style('pop', snapshot)
    assert style.font_size == 110
    assert style.emphasis_color is None
    assert get_caption_preset('pop').font_size == 84
    words = [TranscriptWord(word='Hello', start_time_ms=0, end_time_ms=500), TranscriptWord(word='world', start_time_ms=500, end_time_ms=1000)]
    transcript = [TranscriptSegment(text='Hello world', start_time_ms=0, end_time_ms=1000, words=words)]
    output = tmp_path / 'captions.ass'
    asyncio.run(CaptionGeneratorService().generate_captions(transcript, 0, 1000, str(output), caption_style=style))
    ass = output.read_text()
    assert 'Montserrat Black,110' in ass
    assert '563412' in ass and 'EFCDAB' in ass
    assert '\\kf' in ass
    with pytest.raises(ValueError):
        resolve_caption_style('glow', snapshot)


def test_bridge_passes_a_validated_snapshot_and_resolved_style_to_the_pipeline(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / 'bridge'))
    import bridge_runner
    import clip_engine.config as config_module
    import clip_engine.services.ai_clipping_pipeline as pipeline_module
    from clip_engine.bridge_contract import BRIDGE_CONTRACT_VERSION

    # Run the actual bridge validation and request construction without network calls.
    monkeypatch.setitem(sys.modules, 'network_guard', SimpleNamespace(install=lambda: None))
    monkeypatch.setattr(config_module, 'get_settings', lambda: SimpleNamespace(openrouter_api_key='test-key'))
    monkeypatch.setattr('clip_engine.logging_safety.install_safe_logging', lambda: None)
    output = make_dataclass('Output', [('clips', list)])([])
    process = AsyncMock(return_value=SimpleNamespace(status=pipeline_module.JobStatus.COMPLETED,
        output=output, job_id='caption-test'))
    monkeypatch.setattr(pipeline_module, 'AIClippingPipeline', lambda **kwargs: SimpleNamespace(process_video=process))
    snapshot = custom()
    snapshot['style'].update(font_size=111, highlight_color='#123456', entrance_pop=False, max_lines=2)
    snapshot['baseId'] = 'retired-default'
    config = {'contract_version': BRIDGE_CONTRACT_VERSION, 'job_id': 'caption-test',
        'video_url': 'https://example.com/video', 'layout_vision_enabled': False,
        'include_captions': True, 'caption_preset': 'retired-default', 'custom_caption': snapshot}
    with patch.dict(os.environ):
        assert asyncio.run(bridge_runner.run(config))
    request = process.call_args.args[0]
    assert request.custom_caption == snapshot
    assert request.caption_style.font_size == 111
    assert request.caption_style.highlight_color == '#123456'
    assert request.caption_style.entrance_pop is False
    assert request.caption_style.max_lines == 2
    snapshot['style']['font_size'] = 145
    assert request.custom_caption['style']['font_size'] == 111
    with pytest.raises(ValueError):
        bridge_runner.validate_config({**config, 'caption_preset': 'glow'})


def test_manual_project_keeps_snapshot_through_reload_and_export(monkeypatch, tmp_path):
    from clip_engine.services import manual_editor
    from clip_engine.services.intelligence_planner import ClipPlanSegment

    source = tmp_path / 'source.mp4'
    source.write_bytes(b'original')
    run = tmp_path / 'run'
    run.mkdir()
    snapshot = custom()
    snapshot['style'].update(font_size=118, font_name='Anton', highlight_color='#17ABCD',
        uppercase=False, entrance_pop=False, karaoke_fill=True, max_lines=1)
    request = SimpleNamespace(aspect_ratio='9:16', layout_style='fit', include_captions=True,
        caption_preset='pop', custom_caption=snapshot, video_speed=1)
    words = [TranscriptWord(word='Hello', start_time_ms=0, end_time_ms=500),
        TranscriptWord(word='world', start_time_ms=500, end_time_ms=1000)]
    transcript = [TranscriptSegment(0, 1000, 'Hello world', words=words)]
    renderer = SimpleNamespace(_get_video_dimensions=AsyncMock(return_value=(1920, 1080)),
        capture_framing_source=AsyncMock())
    monkeypatch.setattr(manual_editor, 'review_candidate', AsyncMock())
    asyncio.run(manual_editor.prepare_project(request, [ClipPlanSegment(0, 1000, .9, summary='Hello')],
        transcript, SimpleNamespace(video_path=str(source), metadata=SimpleNamespace(title='Video', duration_seconds=2)),
        renderer, None, str(run), lambda *_: None))
    project = json.loads((run / 'editor-project.json').read_text())
    candidate = project['candidates'][0]
    assert candidate['custom_caption'] == snapshot
    snapshot['style']['font_size'] = 150
    assert candidate['custom_caption']['style']['font_size'] == 118
    manual_editor.validate_candidate(candidate, project['duration_ms'], len(transcript))

    async def render(render_request):
        assert render_request.caption_style.font_size == 118
        assert render_request.caption_style.font_name == 'Anton'
        assert render_request.caption_style.highlight_color == '#17ABCD'
        assert render_request.caption_style.max_lines == 1
        await CaptionGeneratorService().generate_captions(render_request.transcript_segments,
            render_request.start_time_ms, render_request.end_time_ms, str(run / 'captions.ass'),
            caption_style=render_request.caption_style)
        Path(render_request.output_path).write_bytes(b'export')
        return SimpleNamespace(output_path=render_request.output_path, duration_ms=1000, layout_type='fit')

    monkeypatch.setattr(manual_editor, 'RenderingService', lambda: SimpleNamespace(render_clip=render))
    output = {'clips': []}
    assert asyncio.run(manual_editor.export_clip(run, project, candidate, output, str(source), transcript)) == 0
    assert (run / 'clip_00.mp4').read_bytes() == b'export'
    ass = (run / 'captions.ass').read_text()
    assert 'Anton,118' in ass and 'CDAB17' in ass and '\\kf' in ass
    assert '\\q2' in ass and '\\N' not in ass
    assert 'Hello' in ass
    candidate['custom_caption']['style']['font_size'] = 900
    with pytest.raises(ValueError):
        manual_editor.validate_candidate(candidate, project['duration_ms'], len(transcript))
