import { create } from 'zustand'
import type { CustomCaptionPreset } from '../../shared/custom-captions'
import { DEFAULT_CAPTION_PRESET, isCaptionPresetId, type CaptionPresetId } from '../../shared/caption-presets'
import { getApi } from '../lib/ipc'
import { errorMessage } from '../lib/utils'
import { readCaptionLabDraft, writeCaptionLabDraft } from '../lib/caption-lab-draft'
import { useCaptionFavoritesStore } from './use-caption-favorites-store'

const recoveredDraft = readCaptionLabDraft()

interface CaptionState {
  styles: CustomCaptionPreset[]
  loaded: boolean
  loading: boolean
  error: string | null
  /** Keep an unfinished lab edit when navigating around the app. */
  editing: CustomCaptionPreset | null
  view: 'home' | 'base' | 'edit'
  selectedBaseId: CaptionPresetId
  fromWizard: boolean
  load: () => Promise<void>
  save: (style: CustomCaptionPreset) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const useCaptionStore = create<CaptionState>((set, get) => ({
  styles: [], loaded: false, loading: false, error: null,
  editing: recoveredDraft, view: recoveredDraft ? 'edit' : 'home',
  selectedBaseId: isCaptionPresetId(recoveredDraft?.baseId) ? recoveredDraft.baseId : DEFAULT_CAPTION_PRESET, fromWizard: false,
  load: async () => {
    if (get().loading || get().loaded) return
    set({ loading: true, error: null })
    try { set({ styles: await getApi().captions.list(), loaded: true }) }
    catch (error) { set({ error: errorMessage(error, 'Could not load caption styles.') }) }
    finally { set({ loading: false }) }
  },
  save: async (style) => { set({ styles: await getApi().captions.save(style), loaded: true, error: null }) },
  remove: async (id) => {
    set({ styles: await getApi().captions.delete(id), error: null })
    useCaptionFavoritesStore.getState().remove(id)
  }
}))

useCaptionStore.subscribe(({ editing, styles }) => {
  const saved = styles.find(style => style.id === editing?.id)
  writeCaptionLabDraft(editing && JSON.stringify(editing) !== JSON.stringify(saved) ? editing : null)
})
