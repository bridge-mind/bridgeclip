import { CAPTION_PRESETS, DEFAULT_CAPTION_PRESET, isCaptionPresetId } from './caption-presets'
import type { CustomCaptionPreset } from './custom-captions'

export interface CaptionPreferences {
  /** Null follows the first available bookmark, then Pop. */
  defaultId: string | null
  favorites: string[]
}

export function isCaptionStyleId(id: unknown): id is string {
  return isCaptionPresetId(id) || typeof id === 'string' && /^custom-[a-zA-Z0-9-]{1,56}$/.test(id)
}

export function defaultCaptionId(preferences: CaptionPreferences, styles: CustomCaptionPreset[]): string {
  if (isCaptionPresetId(preferences.defaultId) || styles.some(style => style.id === preferences.defaultId)) return preferences.defaultId!
  return CAPTION_PRESETS.find(style => preferences.favorites.includes(style.id))?.id
    ?? styles.find(style => preferences.favorites.includes(style.id))?.id
    ?? DEFAULT_CAPTION_PRESET
}
