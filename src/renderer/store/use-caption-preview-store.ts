import { create } from 'zustand'

/** Preview sound is opt-in and remembered only for this app session. */
export const useCaptionPreviewStore = create<{
  audioEnabled: boolean
  setAudioEnabled: (enabled: boolean) => void
}>((set) => ({
  audioEnabled: false,
  setAudioEnabled: (audioEnabled) => set({ audioEnabled })
}))
