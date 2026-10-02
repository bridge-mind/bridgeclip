import defaults from './caption-style-defaults'
import type { CaptionPresetId } from './caption-presets'
import legacyRendering from '../../engine/clip_engine/data/legacy-caption-rendering.json'

export const CAPTION_FONTS = ['Montserrat Black', 'Montserrat ExtraBold', 'Poppins Black', 'Poppins ExtraBold', 'Anton', 'Archivo Black', 'Instrument Serif Italic'] as const
export interface CaptionStyleSettings {
  font_name: string
  font_size: number
  italic: boolean
  uppercase: boolean
  max_words_per_line: number
  /** Null keeps automatic wrapping; otherwise balance groups across this many rows. */
  max_lines: number | null
  primary_color: string
  highlight_color: string
  outline_color: string
  outline_width: number
  future_words: 'show' | 'dim' | 'hide'
  dim_opacity: number
  entrance_pop: boolean
  karaoke_fill: boolean
  color_transition: boolean
  highlight_box_color: string | null
  glow_color: string | null
  line_box_color: string | null
  line_box_opacity: number
  bold: boolean
  letter_spacing: number
  position: 'top' | 'center' | 'bottom'
  alignment: 'left' | 'center' | 'right'
  word_by_word_highlight: boolean
  shadow_color: string
  shadow_opacity: number
  shadow_blur: number
  shadow_offset: number
  shadow_spread: number
  highlight_box_padding: number
  glow_opacity: number
  glow_radius: number
  glow_blur: number
  glow_active_only: boolean
  line_box_padding: number
}

/** Embedded in jobs and editor projects so later library edits never change an existing clip. */
export interface CustomCaptionPreset {
  id: string
  name: string
  /** Starting-point metadata only; saved styles render without this default. */
  baseId: string
  style: CaptionStyleSettings
}

export function defaultCaptionStyle(id: CaptionPresetId): CaptionStyleSettings {
  return { ...defaults[id] } as CaptionStyleSettings
}

export function parseCustomCaption(value: unknown): CustomCaptionPreset {
  const fail = (): never => { throw new Error('Invalid custom caption style') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const v = value as CustomCaptionPreset
  if (typeof v.id !== 'string' || !/^custom-[a-zA-Z0-9-]{1,56}$/.test(v.id)) fail()
  // eslint-disable-next-line no-control-regex
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 48 || /[\u0000-\u001f]/.test(v.name)) fail()
  if (typeof v.baseId !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(v.baseId) || !v.style || typeof v.style !== 'object' || Array.isArray(v.style)) fail()
  // Frozen values recover older, partial snapshots even after a default retires.
  const legacy = Object.hasOwn(legacyRendering.presets, v.baseId)
    ? { ...legacyRendering.common, ...legacyRendering.presets[v.baseId as keyof typeof legacyRendering.presets] } : {}
  const s = { ...legacy, ...v.style, max_lines: v.style.max_lines ?? null }
  if (!(CAPTION_FONTS as readonly string[]).includes(s.font_name)) fail()
  for (const [key, low, high] of [['font_size', 40, 160], ['outline_width', 0, 12], ['max_words_per_line', 1, 6],
    ['letter_spacing', 0, 8], ['shadow_blur', 0, 32], ['shadow_offset', 0, 24], ['shadow_spread', 0, 16],
    ['highlight_box_padding', 0, 32], ['glow_radius', 0, 24], ['glow_blur', 0, 32], ['line_box_padding', 0, 40]] as const) {
    if (!Number.isInteger(s[key]) || s[key] < low || s[key] > high) fail()
  }
  if (s.max_lines !== null && (!Number.isInteger(s.max_lines) || s.max_lines < 1 || s.max_lines > 3)) fail()
  for (const key of ['dim_opacity', 'line_box_opacity', 'shadow_opacity', 'glow_opacity'] as const) {
    if (typeof s[key] !== 'number' || !Number.isFinite(s[key]) || s[key] < 0 || s[key] > 1) fail()
  }
  for (const key of ['italic', 'uppercase', 'entrance_pop', 'karaoke_fill', 'color_transition', 'bold', 'word_by_word_highlight', 'glow_active_only'] as const) {
    if (typeof s[key] !== 'boolean') fail()
  }
  if (!['show', 'dim', 'hide'].includes(s.future_words)) fail()
  if (!['top', 'center', 'bottom'].includes(s.position) || !['left', 'center', 'right'].includes(s.alignment)) fail()
  for (const key of ['primary_color', 'highlight_color', 'outline_color', 'shadow_color', 'highlight_box_color', 'glow_color', 'line_box_color'] as const) {
    if (s[key] === null && ['highlight_box_color', 'glow_color', 'line_box_color'].includes(key)) continue
    if (typeof s[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(s[key]!)) fail()
  }
  const keys: (keyof CaptionStyleSettings)[] = ['font_name', 'font_size', 'italic', 'uppercase', 'max_words_per_line', 'max_lines',
    'primary_color', 'highlight_color', 'outline_color', 'outline_width', 'future_words', 'dim_opacity', 'entrance_pop',
    'karaoke_fill', 'color_transition', 'highlight_box_color', 'glow_color', 'line_box_color', 'line_box_opacity',
    'bold', 'letter_spacing', 'position', 'alignment', 'word_by_word_highlight', 'shadow_color', 'shadow_opacity',
    'shadow_blur', 'shadow_offset', 'shadow_spread', 'highlight_box_padding', 'glow_opacity', 'glow_radius', 'glow_blur', 'glow_active_only', 'line_box_padding']
  if (Object.keys(s).some(key => !keys.includes(key as keyof CaptionStyleSettings))) fail()
  return { id: v.id, name: v.name.trim(), baseId: v.baseId, style: Object.fromEntries(keys.map(key => [key, s[key]])) as unknown as CaptionStyleSettings }
}
