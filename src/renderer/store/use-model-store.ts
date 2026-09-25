import { create } from 'zustand'
import type { OpenRouterCatalog } from '../../shared/openrouter-models'
import { getApi } from '../lib/ipc'

interface ModelState {
  catalog: OpenRouterCatalog | null
  loading: boolean
  error: string | null
  load: (refresh?: boolean) => Promise<void>
}

export const useModelStore = create<ModelState>((set, get) => ({
  catalog: null,
  loading: false,
  error: null,
  load: async (refresh = false) => {
    if (get().loading) return
    if (!refresh && get().catalog && Date.now() - Date.parse(get().catalog!.fetchedAt) < 10 * 60 * 1000) return
    set({ loading: true, error: null })
    try {
      const catalog = await getApi().models.list(refresh)
      set({ catalog, loading: false })
    } catch {
      set({ loading: false, error: 'Could not load OpenRouter models. Check your connection, then refresh.' })
    }
  }
}))
