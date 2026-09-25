import { create } from 'zustand'
import type { UpdateState } from '../../shared/updates'

interface UpdateStore {
  /** Null until the main process has reported the state once. */
  update: UpdateState | null
  set: (update: UpdateState) => void
}

/** The main process owns update state; App subscribes and mirrors it here. */
export const useUpdateStore = create<UpdateStore>((set) => ({
  update: null,
  set: (update) => set({ update })
}))
