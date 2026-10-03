import { create } from 'zustand'
import { isCaptionPresetId } from '../../shared/caption-presets'

const STORAGE_KEY = 'bridgeclip.captions.favorites'
const validId = (id: unknown): id is string => isCaptionPresetId(id) || typeof id === 'string' && /^custom-[a-zA-Z0-9-]{1,56}$/.test(id)

function readFavorites(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(value) ? [...new Set(value.filter(validId))].slice(0, 256) : []
  } catch { return [] }
}

/** A browsing preference, independent of saved styles and job snapshots. */
export const useCaptionFavoritesStore = create<{
  favorites: string[]
  toggle: (id: string) => void
  remove: (id: string) => void
}>(set => {
  const update = (change: (favorites: string[]) => string[]): void => set(state => {
    const favorites = change(state.favorites)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites)) } catch { /* Keep the session preference. */ }
    return { favorites }
  })
  return {
    favorites: readFavorites(),
    toggle: id => { if (validId(id)) update(ids => ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id].slice(0, 256)) },
    remove: id => update(ids => ids.filter(value => value !== id))
  }
})
