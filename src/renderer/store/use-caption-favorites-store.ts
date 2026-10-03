import { create } from 'zustand'
import { isCaptionStyleId, type CaptionPreferences } from '../../shared/caption-preferences'
import { getApi } from '../lib/ipc'
import { errorMessage } from '../lib/utils'

const STORAGE_KEY = 'bridgeclip.captions.favorites'

function readFavorites(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(value) ? [...new Set(value.filter(isCaptionStyleId))].slice(0, 256) : []
  } catch { return [] }
}

function cacheFavorites(favorites: string[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites)) } catch { /* Main owns the saved preference. */ }
}

/** Shared by Create and Chat; the local bookmark cache also migrates older installs. */
export const useCaptionFavoritesStore = create<CaptionPreferences & {
  loaded: boolean
  loading: boolean
  saving: boolean
  error: string | null
  load: () => Promise<void>
  setDefault: (id: string | null) => Promise<void>
  toggle: (id: string) => void
  remove: (id: string) => Promise<void>
}>((set, get) => {
  let loading: Promise<void> | null = null
  let queue = Promise.resolve()
  let pending = 0
  let committed: CaptionPreferences = { defaultId: null, favorites: readFavorites() }
  const persist = (patch: Partial<CaptionPreferences>): Promise<void> => {
    pending++
    set({ ...patch, saving: true, error: null })
    cacheFavorites(get().favorites)
    const result = queue.then(async () => {
      committed = await getApi().captions.savePreferences(patch)
      set({ error: null })
    }).catch(error => {
      set({ error: errorMessage(error, 'Could not save caption preferences.') })
      throw error
    }).finally(() => {
      pending--
      if (!pending) {
        set({ ...committed, saving: false })
        cacheFavorites(committed.favorites)
      }
    })
    queue = result.catch(() => {})
    return result
  }
  return {
    ...committed, loaded: false, loading: false, saving: false, error: null,
    load: () => {
      if (loading) return loading
      if (get().loaded) return Promise.resolve()
      set({ loading: true, error: null })
      loading = getApi().captions.preferences(readFavorites()).then(preferences => {
        committed = preferences
        cacheFavorites(preferences.favorites)
        set({ ...preferences, loaded: true })
      }).catch(error => {
        set({ error: errorMessage(error, 'Could not load caption preferences.') })
      }).finally(() => { loading = null; set({ loading: false }) })
      return loading
    },
    setDefault: async id => {
      await get().load()
      if (!get().loaded) return
      await persist({ defaultId: id })
    },
    toggle: id => {
      if (!isCaptionStyleId(id) || !get().loaded) return
      const ids = get().favorites
      void persist({ favorites: ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id].slice(0, 256) }).catch(() => {})
    },
    remove: async id => {
      await get().load()
      if (!get().loaded) return
      await persist({ favorites: get().favorites.filter(value => value !== id), ...(get().defaultId === id ? { defaultId: null } : {}) }).catch(() => {})
    }
  }
})
