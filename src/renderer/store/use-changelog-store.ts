import { create } from 'zustand'

interface ChangelogStore {
  open: boolean
  setOpen: (open: boolean) => void
}

/** One changelog dialog per window: Settings → About and Help → Changelog both open it. */
export const useChangelogStore = create<ChangelogStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open })
}))
