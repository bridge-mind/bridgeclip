import { create } from 'zustand'

export const TABLE_PAGE_SIZES = [10, 25, 50, 100] as const
const STORAGE_KEY = 'bridgeclip.tables.pageSize'

function readPageSize(): number {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY))
    if (TABLE_PAGE_SIZES.some(size => size === value)) return value
  } catch { /* Storage may be unavailable; keep the default. */ }
  return 10
}

/** One app-wide table preference, retained across navigation and launches. */
export const useTablePreferencesStore = create<{
  pageSize: number
  setPageSize: (size: number) => void
}>(set => ({
  pageSize: readPageSize(),
  setPageSize: pageSize => {
    if (!TABLE_PAGE_SIZES.some(size => size === pageSize)) return
    try { localStorage.setItem(STORAGE_KEY, String(pageSize)) } catch { /* Keep the session preference. */ }
    set({ pageSize })
  }
}))
