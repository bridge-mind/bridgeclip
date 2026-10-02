"""Validated caption-lab snapshots shared by automatic rendering and manual exports."""
import math
import re
import json
from pathlib import Path
from .config import CaptionStyle, get_caption_preset

FONTS = {'Montserrat Black', 'Montserrat ExtraBold', 'Poppins Black', 'Poppins ExtraBold', 'Anton', 'Archivo Black', 'Instrument Serif Italic'}
INTEGERS = {'font_size': (40, 160), 'outline_width': (0, 12), 'max_words_per_line': (1, 6),
    'letter_spacing': (0, 8), 'shadow_blur': (0, 32), 'shadow_offset': (0, 24), 'shadow_spread': (0, 16),
    'highlight_box_padding': (0, 32), 'glow_radius': (0, 24), 'glow_blur': (0, 32), 'line_box_padding': (0, 40)}
PROBABILITIES = {'dim_opacity', 'line_box_opacity', 'shadow_opacity', 'glow_opacity'}
FLAGS = {'italic', 'uppercase', 'entrance_pop', 'karaoke_fill', 'color_transition', 'bold', 'word_by_word_highlight', 'glow_active_only'}
COLORS = {'primary_color', 'highlight_color', 'outline_color', 'shadow_color'}
OPTIONAL_COLORS = {'highlight_box_color', 'glow_color', 'line_box_color'}
# Compatibility data for old partial snapshots; independent of the live catalog.
LEGACY_RENDERING = json.loads((Path(__file__).parent / 'data' / 'legacy-caption-rendering.json').read_text())


def validate_custom_caption(value, preset_id=None):
    def fail():
        raise ValueError('Invalid custom caption style')
    if not isinstance(value, dict):
        fail()
    if not isinstance(value.get('id'), str) or not re.fullmatch(r'custom-[a-zA-Z0-9-]{1,56}', value['id']):
        fail()
    name = value.get('name')
    if not isinstance(name, str) or not name.strip() or len(name.encode('utf-16-le', errors='surrogatepass')) // 2 > 48 or any(ord(c) < 32 for c in name):
        fail()
    base = value.get('baseId')
    if not isinstance(base, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', base) or (preset_id is not None and base != preset_id):
        fail()
    style = value.get('style')
    if isinstance(style, dict) and base in LEGACY_RENDERING['presets']:
        style = {**LEGACY_RENDERING['common'], **LEGACY_RENDERING['presets'][base], **style}
    keys = set(INTEGERS) | PROBABILITIES | FLAGS | COLORS | OPTIONAL_COLORS | {'font_name', 'future_words', 'position', 'alignment'}
    if not isinstance(style, dict) or set(style) - {'max_lines'} != keys:
        fail()
    max_lines = style.get('max_lines')
    if max_lines is not None and (type(max_lines) is not int or not 1 <= max_lines <= 3):
        fail()
    if not isinstance(style['font_name'], str) or style['font_name'] not in FONTS or style['future_words'] not in ('show', 'dim', 'hide'):
        fail()
    if style['position'] not in ('top', 'center', 'bottom') or style['alignment'] not in ('left', 'center', 'right'):
        fail()
    for key, (low, high) in INTEGERS.items():
        if type(style[key]) is not int or not low <= style[key] <= high:
            fail()
    for key in PROBABILITIES:
        if type(style[key]) not in (int, float) or not math.isfinite(style[key]) or not 0 <= style[key] <= 1:
            fail()
    for key in FLAGS:
        if type(style[key]) is not bool:
            fail()
    for key in COLORS | OPTIONAL_COLORS:
        if key in OPTIONAL_COLORS and style[key] is None:
            continue
        if not isinstance(style[key], str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', style[key]):
            fail()
    return {'id': value['id'], 'name': name.strip(), 'baseId': base, 'style': {**style, 'max_lines': max_lines}}


def resolve_caption_style(preset_id, custom=None):
    if custom is None:
        return get_caption_preset(preset_id)
    snapshot = validate_custom_caption(custom, preset_id)
    style = CaptionStyle()
    for key, value in snapshot['style'].items():
        setattr(style, key, value)
    # A custom highlight is authoritative, including on planner-emphasized words.
    style.emphasis_color = None
    return style
