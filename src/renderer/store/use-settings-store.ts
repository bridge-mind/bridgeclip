import { JEV_DEFAULTS, JEV_FEATURE_DEFAULTS } from '../../shared/jev-settings'
import { create } from 'zustand'
import { errorMessage } from '../lib/utils'
import { getApi } from '../lib/ipc'
import type { ClipSettings, ToolStatus } from '../../preload/index'

interface SettingsState extends ClipSettings {
  loaded: boolean
  saving: boolean
  toolStatus: ToolStatus | null
  checkingTools: boolean
  toolError: string | null
  load: () => Promise<void>
  save: (settings: Partial<ClipSettings>) => Promise<void>
  replaceApiKey: (key: 'openrouterApiKey' | 'zernioApiKey', value: string) => Promise<void>
  checkTools: () => Promise<void>
}

// Queue writes so each partial update merges with the last successful save.
let saveQueue: Promise<void> = Promise.resolve()
let pendingSaves = 0
let latestToolCheck = 0

export const useSettingsStore = create<SettingsState>((set, get) => ({
  openrouterConfigured: false,
  zernioConfigured: false,
  unreadableKeys: [],
  ...JEV_DEFAULTS,
  ...JEV_FEATURE_DEFAULTS,
  outputDirectory: '',
  pythonPath: 'python3',
  customVocabulary: '',
  loaded: false,
  saving: false,
  toolStatus: null,
  checkingTools: false,
  toolError: null,

  load: async () => {
    const settings = await getApi().settings.load()
    set({ ...pickSettings(settings), loaded: true })
  },

  save: (updates) => {
    const patch = { ...updates }
    pendingSaves += 1
    set({ saving: true })
    const task = saveQueue.then(async () => {
      const merged: ClipSettings = { ...pickSettings(get()), ...patch }
      const saved = await getApi().settings.save(merged)
      set({ ...pickSettings(saved), loaded: true })
    })
    saveQueue = task.catch(() => {})
    return task.finally(() => {
      pendingSaves -= 1
      set({ saving: pendingSaves > 0 })
    })
  },

  replaceApiKey: (key, value) => {
    pendingSaves += 1
    set({ saving: true })
    const task = saveQueue.then(async () => {
      const saved = await getApi().settings.replaceApiKey(key, value)
      set({ ...pickSettings(saved), loaded: true })
    })
    saveQueue = task.catch(() => {})
    return task.finally(() => {
      pendingSaves -= 1
      set({ saving: pendingSaves > 0 })
    })
  },

  checkTools: async () => {
    const request = ++latestToolCheck
    set({ checkingTools: true, toolError: null })
    try {
      const status = await getApi().system.checkTools()
      if (request === latestToolCheck) set({ toolStatus: status })
    } catch (err) {
      if (request === latestToolCheck) {
        set({ toolStatus: null, toolError: errorMessage(err, 'Could not check required tools. Try again in Settings.') })
      }
    } finally {
      if (request === latestToolCheck) set({ checkingTools: false })
    }
  }
}))

function pickSettings(s: ClipSettings): ClipSettings {
  return {
    jevThreshold: s.jevThreshold ?? JEV_DEFAULTS.jevThreshold,
    jevSelfContainedThreshold: s.jevSelfContainedThreshold ?? JEV_DEFAULTS.jevSelfContainedThreshold,
    jevFaithfulToSourceThreshold: s.jevFaithfulToSourceThreshold ?? JEV_DEFAULTS.jevFaithfulToSourceThreshold,
    jevTitleSupportedThreshold: s.jevTitleSupportedThreshold ?? JEV_DEFAULTS.jevTitleSupportedThreshold,
    jevSponsorThreshold: s.jevSponsorThreshold ?? JEV_DEFAULTS.jevSponsorThreshold,
    jevEvidenceThreshold: s.jevEvidenceThreshold ?? JEV_DEFAULTS.jevEvidenceThreshold,
    jevCutThreshold: s.jevCutThreshold ?? JEV_DEFAULTS.jevCutThreshold,
    openrouterConfigured: s.openrouterConfigured,
    jevEnabled: s.jevEnabled ?? JEV_FEATURE_DEFAULTS.jevEnabled,
    jevVisualContext: s.jevVisualContext ?? JEV_FEATURE_DEFAULTS.jevVisualContext,
    sourceContextWebResearch: s.sourceContextWebResearch ?? JEV_FEATURE_DEFAULTS.sourceContextWebResearch,
    zernioConfigured: s.zernioConfigured,
    unreadableKeys: s.unreadableKeys ?? [],
    outputDirectory: s.outputDirectory,
    pythonPath: s.pythonPath,
    customVocabulary: s.customVocabulary
  }
}

export type SetupState = { ready: boolean; missingKeys: string[]; toolsOk: boolean | null }

/** Whether a clip job can start: the OpenRouter key is present and, once the
 *  system check has run, every required tool found. */
export function useSetupState(): SetupState {
  const openrouter = useSettingsStore((s) => s.openrouterConfigured)
  const tools = useSettingsStore((s) => s.toolStatus)
  const toolError = useSettingsStore((s) => s.toolError)
  const checkingTools = useSettingsStore((s) => s.checkingTools)
  const missingKeys = [!openrouter && 'OpenRouter'].filter(Boolean) as string[]
  const toolsOk = toolError ? false : tools
    ? tools.python && tools.pythonDeps && tools.ffmpeg && tools.ffprobe && tools.ytdlp && tools.engine && tools.bridgeRunner
    : null
  return { ready: missingKeys.length === 0 && toolsOk === true && !checkingTools, missingKeys, toolsOk }
}
