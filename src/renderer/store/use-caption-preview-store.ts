import { create } from 'zustand'

/** Preview sound is opt-in and remembered only for this app session. */
export const useCaptionPreviewStore = create<{
  audioEnabled: boolean
  setAudioEnabled: (enabled: boolean) => void
  sample: 'short' | 'long'
  setSample: (sample: 'short' | 'long') => void
}>((set) => ({
  audioEnabled: false,
  setAudioEnabled: (audioEnabled) => set({ audioEnabled }),
  sample: 'short',
  setSample: sample => set({ sample })
}))
