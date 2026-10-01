import { JEV_DEFAULTS, JEV_FEATURE_DEFAULTS, type JevThresholdSettings } from '../shared/jev-settings'
import { app, safeStorage } from 'electron'
import { closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { isAbsolute, join } from 'path'
import { randomUUID } from 'crypto'

/**
 * BridgeClip is bring-your-own-key: every provider call is made from this
 * machine with the user's own keys. Keys are encrypted with the OS keychain
 * (safeStorage) when it is available.
 */
export interface AppSettings extends JevThresholdSettings {
  openrouterApiKey: string
  /** Optional: connects social accounts for posting. Used only by the main process, never sent to the engine. */
  zernioApiKey: string
  /** Opt-in beta: Jev review of automatic clips via the existing OpenRouter key. Review & edit always uses Jev. */
  jevEnabled: string
  /** Additional OpenRouter frame observations, explicitly opt-in. */
  jevVisualContext: string
  /** Opt-in beta: web research of public sources before transcription. */
  sourceContextWebResearch: string
  outputDirectory: string
  pythonPath: string
  /** Names and jargon the speech-to-text should spell correctly, one per line. */
  customVocabulary: string
}

export type ApiKeyName = 'openrouterApiKey' | 'zernioApiKey'
export type PublicSettings = Pick<AppSettings, 'outputDirectory' | 'pythonPath' | 'customVocabulary' | 'jevEnabled' | 'jevVisualContext' | 'sourceContextWebResearch' | keyof JevThresholdSettings> & {
  openrouterConfigured: boolean
  zernioConfigured: boolean
  /** Saved keys the system keychain can't decrypt right now. They stay saved until replaced or removed. */
  unreadableKeys: ApiKeyName[]
}

const SECRET_KEYS = ['openrouterApiKey', 'zernioApiKey'] as const
type SecretKey = (typeof SECRET_KEYS)[number]

const DEFAULT_SETTINGS: AppSettings = {
  ...JEV_DEFAULTS,
  ...JEV_FEATURE_DEFAULTS,
  openrouterApiKey: '',
  zernioApiKey: '',
  outputDirectory: join(app.getPath('home'), 'BridgeClip'),
  pythonPath: process.platform === 'win32' ? 'python' : 'python3',
  customVocabulary: ''
}

const SETTINGS_VERSION = 12
/**
 * Versions 9-11 (pre-release builds of this feature) saved Jev review and web
 * research as on by default, and older versions drop the fields entirely, so a
 * saved "on" before this version is not an opt-in. Those files load both as off.
 */
const OPT_IN_BETA_VERSION = 12
const SWITCHES = ['off', 'on']

type PersistedSecret = { scheme: 'safeStorage' | 'base64'; value: string } | ''

/** The keychain is locked, missing, or not the one that encrypted a saved key. */
class SecretUnavailableError extends Error {}

/**
 * Saved keys that the last load could not decrypt, as stored. A locked or
 * changed keychain must not lock people out of the app or lose their keys, so
 * these load as empty and are written back unchanged until replaced or removed.
 */
const unreadableSecrets = new Map<SecretKey, PersistedSecret>()

interface PersistedSettings extends JevThresholdSettings {
  version: number
  openrouterApiKey: PersistedSecret
  zernioApiKey: PersistedSecret
  jevEnabled: string
  jevVisualContext: string
  sourceContextWebResearch: string
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
    jevThreshold: settings.jevThreshold ?? JEV_DEFAULTS.jevThreshold,
    jevSelfContainedThreshold: settings.jevSelfContainedThreshold ?? JEV_DEFAULTS.jevSelfContainedThreshold,
    jevFaithfulToSourceThreshold: settings.jevFaithfulToSourceThreshold ?? JEV_DEFAULTS.jevFaithfulToSourceThreshold,
    jevTitleSupportedThreshold: settings.jevTitleSupportedThreshold ?? JEV_DEFAULTS.jevTitleSupportedThreshold,
    jevSponsorThreshold: settings.jevSponsorThreshold ?? JEV_DEFAULTS.jevSponsorThreshold,
    jevEvidenceThreshold: settings.jevEvidenceThreshold ?? JEV_DEFAULTS.jevEvidenceThreshold,
    jevCutThreshold: settings.jevCutThreshold ?? JEV_DEFAULTS.jevCutThreshold,

    openrouterApiKey: (settings.openrouterApiKey ?? DEFAULT_SETTINGS.openrouterApiKey).trim(),
    zernioApiKey: (settings.zernioApiKey ?? DEFAULT_SETTINGS.zernioApiKey).trim(),
    jevEnabled: settings.jevEnabled ?? DEFAULT_SETTINGS.jevEnabled,
    jevVisualContext: settings.jevVisualContext ?? DEFAULT_SETTINGS.jevVisualContext,
    sourceContextWebResearch: settings.sourceContextWebResearch ?? DEFAULT_SETTINGS.sourceContextWebResearch,
    outputDirectory: (settings.outputDirectory || DEFAULT_SETTINGS.outputDirectory).trim(),
    pythonPath: (settings.pythonPath || DEFAULT_SETTINGS.pythonPath).trim(),
    customVocabulary: vocabularyTerms(settings.customVocabulary ?? DEFAULT_SETTINGS.customVocabulary).join('\n')
  }
  for (const key of Object.keys(JEV_DEFAULTS) as (keyof JevThresholdSettings)[]) {
    const value = probability(normalized[key])
    if (value === null) throw new Error(`Invalid Jev threshold: ${key}. Use a probability from 0 to 1.`)
    normalized[key] = value
  }
  normalized.outputDirectory ||= DEFAULT_SETTINGS.outputDirectory
  normalized.pythonPath ||= DEFAULT_SETTINGS.pythonPath
  if (!SWITCHES.includes(normalized.jevEnabled)) throw new Error('Invalid Jev review setting')
  if (!SWITCHES.includes(normalized.jevVisualContext)) throw new Error('Invalid visual context setting')
  if (!SWITCHES.includes(normalized.sourceContextWebResearch)) throw new Error('Invalid source research setting')
  if (!isAbsolute(normalized.outputDirectory)) throw new Error('Settings folders must be absolute paths')
  return normalized
}

/** A canonical probability string from 0 to 1, or null. */
function probability(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(trimmed) || !Number.isFinite(Number(trimmed)) || Number(trimmed) > 1) return null
  return String(Number(trimmed))
}

/**
 * Saved Jev fields are optional preferences. One unreadable value falls back to
 * its own default instead of making the whole file (and the saved keys) unreadable.
 */
function savedJevSettings(raw: Record<string, unknown>): Pick<AppSettings, keyof JevThresholdSettings | 'jevEnabled' | 'jevVisualContext' | 'sourceContextWebResearch'> {
  const thresholds = Object.fromEntries((Object.keys(JEV_DEFAULTS) as (keyof JevThresholdSettings)[])
    .map((key) => [key, probability(raw[key]) ?? JEV_DEFAULTS[key]])) as JevThresholdSettings
  const switchValue = (value: unknown, fallback: string): string => typeof value === 'string' && SWITCHES.includes(value) ? value : fallback
  const optedIn = typeof raw.version === 'number' && raw.version >= OPT_IN_BETA_VERSION
  return {
    ...thresholds,
    jevEnabled: optedIn ? switchValue(raw.jevEnabled, DEFAULT_SETTINGS.jevEnabled) : 'off',
    jevVisualContext: switchValue(raw.jevVisualContext ?? raw.typesafeVisualContext, DEFAULT_SETTINGS.jevVisualContext),
    sourceContextWebResearch: optedIn ? switchValue(raw.sourceContextWebResearch, DEFAULT_SETTINGS.sourceContextWebResearch) : 'off'
  }
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
  throw new Error(process.platform === 'linux'
    ? 'No desktop keyring is available to encrypt API keys. Start and unlock GNOME Keyring, KWallet or another Secret Service keyring (such as KeePassXC), then try again.'
    : 'Secure key storage is unavailable. Unlock or configure your operating system keychain before saving API keys.')
}

/**
 * Decodes a stored secret. Accepts the current `{scheme, value}` shape and the
 * plain base64 strings written by versions <= 0.1.16. `legacy` reports whether
 * the value should be re-encrypted.
 */
function decodeSecret(value: unknown): { value: string; legacy: boolean } {
  if (!value) return { value: '', legacy: false }
  if (typeof value === 'string') {
    if (!canEncrypt()) throw new SecretUnavailableError('Secure key storage is unavailable')
    try {
      return { value: Buffer.from(value, 'base64').toString('utf-8'), legacy: true }
    } catch {
      return { value: '', legacy: false }
    }
  }
  if (typeof value === 'object') {
    const obj = value as { scheme?: string; value?: string }
    if (!obj.value) return { value: '', legacy: false }
    if (obj.scheme === 'safeStorage' || obj.scheme === 'base64') {
      if (!canEncrypt()) throw new SecretUnavailableError('Secure key storage is unavailable')
      if (obj.scheme === 'base64') return { value: Buffer.from(obj.value, 'base64').toString('utf-8'), legacy: true }
      try {
        return { value: safeStorage.decryptString(Buffer.from(obj.value, 'base64')), legacy: false }
      } catch {
        throw new SecretUnavailableError('Could not decrypt a saved API key')
      }
    }
  }
  return { value: '', legacy: false }
}

export function loadSettings(): AppSettings {
  const path = getSettingsPath()
  unreadableSecrets.clear()
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS }

  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    let needsMigration = raw.version !== SETTINGS_VERSION || Object.hasOwn(raw, 'elevenLabsApiKey') || Object.hasOwn(raw, 'typesafeApiKey')
    const secrets = {} as Record<SecretKey, string>
    for (const key of SECRET_KEYS) {
      try {
        const decoded = decodeSecret(raw[key])
        secrets[key] = decoded.value
        if (decoded.legacy) needsMigration = true
      } catch (error) {
        if (!(error instanceof SecretUnavailableError)) throw error
        secrets[key] = ''
        unreadableSecrets.set(key, raw[key] as PersistedSecret)
      }
    }

    const settings = normalizeSettings({
      ...secrets,
      ...savedJevSettings(raw),
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

/** A key that can't be decrypted right now stays saved until it is replaced or removed. */
function persistSecret(key: SecretKey, value: string): PersistedSecret {
  const unreadable = unreadableSecrets.get(key)
  return !value && unreadable !== undefined ? unreadable : encodeSecret(value)
}

function writeSettings(settings: AppSettings): void {
  const path = getSettingsPath()
  const tempPath = `${path}.${randomUUID()}.tmp`

  const persisted: PersistedSettings = {
    version: SETTINGS_VERSION,
    jevThreshold: settings.jevThreshold,
    jevSelfContainedThreshold: settings.jevSelfContainedThreshold,
    jevFaithfulToSourceThreshold: settings.jevFaithfulToSourceThreshold,
    jevTitleSupportedThreshold: settings.jevTitleSupportedThreshold,
    jevSponsorThreshold: settings.jevSponsorThreshold,
    jevEvidenceThreshold: settings.jevEvidenceThreshold,
    jevCutThreshold: settings.jevCutThreshold,

    openrouterApiKey: persistSecret('openrouterApiKey', settings.openrouterApiKey),
    zernioApiKey: persistSecret('zernioApiKey', settings.zernioApiKey),
    jevEnabled: settings.jevEnabled,
    jevVisualContext: settings.jevVisualContext,
    sourceContextWebResearch: settings.sourceContextWebResearch,
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
    jevThreshold: settings.jevThreshold,
    jevSelfContainedThreshold: settings.jevSelfContainedThreshold,
    jevFaithfulToSourceThreshold: settings.jevFaithfulToSourceThreshold,
    jevTitleSupportedThreshold: settings.jevTitleSupportedThreshold,
    jevSponsorThreshold: settings.jevSponsorThreshold,
    jevEvidenceThreshold: settings.jevEvidenceThreshold,
    jevCutThreshold: settings.jevCutThreshold,

    outputDirectory: settings.outputDirectory,
    pythonPath: settings.pythonPath,
    customVocabulary: settings.customVocabulary,
    openrouterConfigured: Boolean(settings.openrouterApiKey),
    zernioConfigured: Boolean(settings.zernioApiKey),
    unreadableKeys: SECRET_KEYS.filter((key) => unreadableSecrets.has(key)),
    jevEnabled: settings.jevEnabled,
    jevVisualContext: settings.jevVisualContext,
    sourceContextWebResearch: settings.sourceContextWebResearch
  }
}

export function savePublicSettings(update: Pick<PublicSettings, 'outputDirectory' | 'pythonPath' | 'customVocabulary' | 'jevEnabled' | 'jevVisualContext' | 'sourceContextWebResearch' | keyof JevThresholdSettings>): PublicSettings {
  const current = loadSettings()
  return publicSettings(saveSettings({
    ...current,
    jevThreshold: update.jevThreshold ?? current.jevThreshold,
    jevSelfContainedThreshold: update.jevSelfContainedThreshold ?? current.jevSelfContainedThreshold,
    jevFaithfulToSourceThreshold: update.jevFaithfulToSourceThreshold ?? current.jevFaithfulToSourceThreshold,
    jevTitleSupportedThreshold: update.jevTitleSupportedThreshold ?? current.jevTitleSupportedThreshold,
    jevSponsorThreshold: update.jevSponsorThreshold ?? current.jevSponsorThreshold,
    jevEvidenceThreshold: update.jevEvidenceThreshold ?? current.jevEvidenceThreshold,
    jevCutThreshold: update.jevCutThreshold ?? current.jevCutThreshold,
    outputDirectory: update.outputDirectory,
    pythonPath: update.pythonPath,
    customVocabulary: update.customVocabulary,
    jevEnabled: update.jevEnabled ?? current.jevEnabled,
    jevVisualContext: update.jevVisualContext ?? current.jevVisualContext,
    sourceContextWebResearch: update.sourceContextWebResearch ?? current.sourceContextWebResearch
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
  // Replacing or removing a key ends its unreadable copy.
  unreadableSecrets.delete(key)
  return publicSettings(saveSettings({ ...current, [key]: value.trim() }))
}

export function getSettingsForBridge(settings: AppSettings): Record<string, string> {
  return {
    OPENROUTER_API_KEY: settings.openrouterApiKey,
    SOURCE_CONTEXT_WEB_RESEARCH: settings.sourceContextWebResearch !== 'off' ? 'true' : 'false',
    JEV_THRESHOLD: settings.jevThreshold,
    JEV_SELF_CONTAINED_THRESHOLD: settings.jevSelfContainedThreshold,
    JEV_FAITHFUL_TO_SOURCE_THRESHOLD: settings.jevFaithfulToSourceThreshold,
    JEV_TITLE_SUPPORTED_THRESHOLD: settings.jevTitleSupportedThreshold,
    JEV_SPONSOR_THRESHOLD: settings.jevSponsorThreshold,
    JEV_EVIDENCE_THRESHOLD: settings.jevEvidenceThreshold,
    JEV_CUT_THRESHOLD: settings.jevCutThreshold,
    JEV_ENABLED: settings.jevEnabled === 'on' ? 'true' : 'false',
    JEV_VISUAL_CONTEXT: settings.jevVisualContext === 'on' ? 'true' : 'false',
    LOCAL_MODE: 'true',
    LOCAL_OUTPUT_DIR: settings.outputDirectory
  }
}
