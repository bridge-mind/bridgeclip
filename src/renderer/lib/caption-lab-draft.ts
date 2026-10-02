import { parseCustomCaption, type CustomCaptionPreset } from '../../shared/custom-captions'

const DRAFT_KEY = 'bridgeclip.caption-lab-draft'

/** Keep unfinished caption edits through a reload or development restart. */
export function readCaptionLabDraft(): CustomCaptionPreset | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const draft = JSON.parse(raw)
    // A temporarily blank name is valid while editing, but not when saving.
    const parsed = parseCustomCaption({ ...draft, name: typeof draft.name === 'string' && !draft.name.trim() ? 'Untitled preset' : draft.name })
    return { ...parsed, name: draft.name }
  } catch { return null }
}

export function writeCaptionLabDraft(draft: CustomCaptionPreset | null): void {
  try {
    if (draft) localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
    else localStorage.removeItem(DRAFT_KEY)
  } catch { /* Storage may be unavailable; the in-memory edit remains usable. */ }
}
