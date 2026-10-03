import { app } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { isCaptionPresetId } from '../shared/caption-presets'
import { isCaptionStyleId, type CaptionPreferences } from '../shared/caption-preferences'
import { listCaptionStyles } from './caption-library'

const preferencesPath = (): string => join(app.getPath('userData'), 'caption-preferences.json')

function parsePreferences(value: unknown, saved = false): CaptionPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid caption preferences')
  const { defaultId, favorites } = value as CaptionPreferences
  // A retired built-in can appear in an older file; ignore it without losing
  // the remaining bookmarks. New selections must be currently available.
  const validId = saved ? (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id) : isCaptionStyleId
  if ((defaultId !== null && !validId(defaultId)) || !Array.isArray(favorites) || favorites.length > 256 || !favorites.every(validId)) throw new Error('Invalid caption preferences')
  return { defaultId: isCaptionStyleId(defaultId) ? defaultId : null, favorites: [...new Set(favorites.filter(isCaptionStyleId))] }
}

function writePreferences(preferences: CaptionPreferences): CaptionPreferences {
  const path = preferencesPath(), temporary = `${path}.${randomUUID()}.tmp`
  mkdirSync(app.getPath('userData'), { recursive: true })
  try {
    writeFileSync(temporary, JSON.stringify(preferences, null, 2), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
  return preferences
}

/** Import older renderer bookmarks once; the main process then owns preferences. */
export function loadCaptionPreferences(legacyFavorites?: unknown): CaptionPreferences {
  const path = preferencesPath()
  if (!existsSync(path)) {
    const preferences = parsePreferences({ defaultId: null, favorites: legacyFavorites ?? [] })
    return legacyFavorites === undefined ? preferences : writePreferences(preferences)
  }
  let preferences: CaptionPreferences
  try { preferences = parsePreferences(JSON.parse(readFileSync(path, 'utf8')), true) }
  catch { throw new Error('Could not read your caption preferences. The saved file has been kept for recovery.') }
  if (preferences.defaultId && !isCaptionPresetId(preferences.defaultId) && !listCaptionStyles().some(style => style.id === preferences.defaultId)) preferences.defaultId = null
  return preferences
}

export function saveCaptionPreferences(patch: unknown): CaptionPreferences {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['defaultId', 'favorites'].includes(key))) throw new Error('Invalid caption preferences')
  const preferences = parsePreferences({ ...loadCaptionPreferences(), ...patch })
  if (preferences.defaultId && !isCaptionPresetId(preferences.defaultId) && !listCaptionStyles().some(style => style.id === preferences.defaultId)) throw new Error('This caption preset is no longer available.')
  return writePreferences(preferences)
}
