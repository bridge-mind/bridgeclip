import { app, safeStorage } from 'electron'
import { closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { isAbsolute, join } from 'path'
import { randomUUID } from 'crypto'

/**
 * BridgeClip is bring-your-own-key: every provider call is made from this
 * machine with the user's own keys. Keys are encrypted with the OS keychain
 * (safeStorage) when it is available.
 */
export interface AppSettings {
  openrouterApiKey: string
  /** Optional: connects social accounts for posting. Used only by the main process, never sent to the engine. */
  zernioApiKey: string
  outputDirectory: string
  pythonPath: string
  /** Names and jargon the speech-to-text should spell correctly, one per line. */
  customVocabulary: string
}

export type ApiKeyName = 'openrouterApiKey' | 'zernioApiKey'
export type PublicSettings = Pick<AppSettings, 'outputDirectory' | 'pythonPath' | 'customVocabulary'> & {
  openrouterConfigured: boolean
  zernioConfigured: boolean
}

const SECRET_KEYS = ['openrouterApiKey', 'zernioApiKey'] as const
type SecretKey = (typeof SECRET_KEYS)[number]

const DEFAULT_SETTINGS: AppSettings = {
  openrouterApiKey: '',
  zernioApiKey: '',
  outputDirectory: join(app.getPath('home'), 'BridgeClip'),
  pythonPath: process.platform === 'win32' ? 'python' : 'python3',
  customVocabulary: ''
}

const SETTINGS_VERSION = 7

type PersistedSecret = { scheme: 'safeStorage' | 'base64'; value: string } | ''

interface PersistedSettings {
  version: number
  openrouterApiKey: PersistedSecret
  zernioApiKey: PersistedSecret
  outputDirectory: string
  pythonPath: string
  customVocabulary?: string
}

function ensureDir(dir: string): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  return dir
}

function getSettingsPath(): string {
  return join(ensureDir(app.getPath('userData')), 'settings.json')
}

function normalizeSettings(settings: Partial<AppSettings>): AppSettings {
  if (!settings || typeof settings !== 'object') throw new Error('Invalid settings')
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
    if (settings[key] !== undefined && (typeof settings[key] !== 'string' || settings[key]!.length > 8192 || settings[key]!.includes('\0'))) throw new Error(`Invalid ${key}`)
  }
  const normalized: AppSettings = {
    openrouterApiKey: (settings.openrouterApiKey ?? DEFAULT_SETTINGS.openrouterApiKey).trim(),
    zernioApiKey: (settings.zernioApiKey ?? DEFAULT_SETTINGS.zernioApiKey).trim(),
    outputDirectory: (settings.outputDirectory || DEFAULT_SETTINGS.outputDirectory).trim(),
    pythonPath: (settings.pythonPath || DEFAULT_SETTINGS.pythonPath).trim(),
    customVocabulary: vocabularyTerms(settings.customVocabulary ?? DEFAULT_SETTINGS.customVocabulary).join('\n')
  }
  normalized.outputDirectory ||= DEFAULT_SETTINGS.outputDirectory
  normalized.pythonPath ||= DEFAULT_SETTINGS.pythonPath
  if (!isAbsolute(normalized.outputDirectory)) throw new Error('Settings folders must be absolute paths')
  return normalized
}

function canEncrypt(): boolean {
  return app.isReady() && safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
}

function encodeSecret(value: string): PersistedSecret {
  if (!value) return ''
  if (canEncrypt()) {
    return { scheme: 'safeStorage', value: safeStorage.encryptString(value).toString('base64') }
  }
  throw new Error('Secure key storage is unavailable. Unlock or configure your operating system keychain before saving API keys.')
}

/**
 * Decodes a stored secret. Accepts the current `{scheme, value}` shape and the
 * plain base64 strings written by versions <= 0.1.16. `legacy` reports whether
 * the value should be re-encrypted.
 */
function decodeSecret(value: unknown): { value: string; legacy: boolean } {
  if (!value) return { value: '', legacy: false }
  if (typeof value === 'string') {
    if (!canEncrypt()) throw new Error('Secure key storage is unavailable')
    try {
      return { value: Buffer.from(value, 'base64').toString('utf-8'), legacy: true }
    } catch {
      return { value: '', legacy: false }
    }
  }
  if (typeof value === 'object') {
    const obj = value as { scheme?: string; value?: string }
    if (!obj.value) return { value: '', legacy: false }
    try {
      if (obj.scheme === 'safeStorage') {
        if (!canEncrypt()) throw new Error('Secure key storage is unavailable')
        return { value: safeStorage.decryptString(Buffer.from(obj.value, 'base64')), legacy: false }
      }
      if (obj.scheme === 'base64') {
        if (!canEncrypt()) throw new Error('Secure key storage is unavailable')
        return { value: Buffer.from(obj.value, 'base64').toString('utf-8'), legacy: true }
      }
    } catch {
      throw new Error('Could not decrypt saved API keys. Unlock the system keychain and retry.')
    }
  }
  return { value: '', legacy: false }
}

export function loadSettings(): AppSettings {
  const path = getSettingsPath()
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS }

  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    let needsMigration = raw.version !== SETTINGS_VERSION || Object.hasOwn(raw, 'elevenLabsApiKey')
    const secrets = {} as Record<SecretKey, string>
    for (const key of SECRET_KEYS) {
      const decoded = decodeSecret(raw[key])
      secrets[key] = decoded.value
      if (decoded.legacy) needsMigration = true
    }

    const settings = normalizeSettings({
      ...secrets,
      outputDirectory: typeof raw.outputDirectory === 'string' ? raw.outputDirectory : DEFAULT_SETTINGS.outputDirectory,
      pythonPath: typeof raw.pythonPath === 'string' ? raw.pythonPath : DEFAULT_SETTINGS.pythonPath,
      customVocabulary: typeof raw.customVocabulary === 'string' ? raw.customVocabulary : DEFAULT_SETTINGS.customVocabulary
    })

    if (needsMigration && canEncrypt()) writeSettings(settings)
    return settings
  } catch (error) {
    throw new Error('Could not read saved settings. The settings file was kept for recovery.', { cause: error })
  }
}

function writeSettings(settings: AppSettings): void {
  const path = getSettingsPath()
  const tempPath = `${path}.${randomUUID()}.tmp`

  const persisted: PersistedSettings = {
    version: SETTINGS_VERSION,
    openrouterApiKey: encodeSecret(settings.openrouterApiKey),
    zernioApiKey: encodeSecret(settings.zernioApiKey),
    outputDirectory: settings.outputDirectory,
    pythonPath: settings.pythonPath,
    customVocabulary: settings.customVocabulary
  }

  let fd: number | undefined
  try {
    fd = openSync(tempPath, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(persisted, null, 2), { encoding: 'utf-8' })
    fchmodSync(fd, 0o600)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tempPath, path)
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(tempPath)) unlinkSync(tempPath)
  }
}

export function saveSettings(settings: AppSettings): AppSettings {
  writeSettings(normalizeSettings(settings))
  return loadSettings()
}

export function publicSettings(settings: AppSettings): PublicSettings {
  return {
    outputDirectory: settings.outputDirectory,
    pythonPath: settings.pythonPath,
    customVocabulary: settings.customVocabulary,
    openrouterConfigured: Boolean(settings.openrouterApiKey),
    zernioConfigured: Boolean(settings.zernioApiKey)
  }
}

export function savePublicSettings(update: Pick<PublicSettings, 'outputDirectory' | 'pythonPath' | 'customVocabulary'>): PublicSettings {
  const current = loadSettings()
  return publicSettings(saveSettings({
    ...current,
    outputDirectory: update.outputDirectory,
    pythonPath: update.pythonPath,
    customVocabulary: update.customVocabulary
  }))
}

/**
 * Conservative vocabulary hints for MAI Transcribe 2: one term per line or comma,
 * at most five words and 49 characters each, none of <>{}[]\, deduplicated
 * case-insensitively. These application limits keep phrase hints short and bounded.
 */
export function vocabularyTerms(value: string): string[] {
  const terms: string[] = []
  const seen = new Set<string>()
  for (const line of value.split(/[\n,]/)) {
    const term = line.replace(/\s+/g, ' ').trim()
    if (!term || term.length > 49 || term.split(' ').length > 5 || /[<>{}[\]\\]/.test(term)) continue
    const key = term.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(term)
    if (terms.length >= 200) break
  }
  return terms
}

export function replaceApiKey(key: ApiKeyName, value: string): PublicSettings {
  if (!SECRET_KEYS.includes(key) || typeof value !== 'string' || value.length > 8192 || value.includes('\0')) throw new Error('Invalid API key update')
  const current = loadSettings()
  return publicSettings(saveSettings({ ...current, [key]: value.trim() }))
}

export function getSettingsForBridge(settings: AppSettings): Record<string, string> {
  return {
    OPENROUTER_API_KEY: settings.openrouterApiKey,
    LOCAL_MODE: 'true',
    LOCAL_OUTPUT_DIR: settings.outputDirectory
  }
}
