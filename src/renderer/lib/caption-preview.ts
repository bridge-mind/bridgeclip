import { sceneAt, type CandidateEdit, type EditorProject } from '../../shared/clip-editor'

/** Manual exports use these same layout anchors (layout_renderer.caption_anchor). */
export function captionAnchor(project: EditorProject, candidate: CandidateEdit, time: number): { y: number; bottom: boolean } {
  if (candidate.caption_y != null) return { y: candidate.caption_y, bottom: false }
  if (project.aspect_ratio === '16:9') return { y: 1 - 100 / 1080, bottom: true }
  const scene = sceneAt(candidate, time)
  if (scene.layout === 'split') return { y: .5, bottom: false }
  if (scene.layout === 'fit') {
    const height = Math.min(1920, 1080 * project.height / project.width)
    const bar = (1920 - height) / 2
    if (bar >= 200) return { y: (1920 - Math.floor(bar * .55)) / 1920, bottom: true }
  }
  return { y: 1340 / 1920, bottom: false }
}


/** Match caption_generator._face_tags: short highlight events switch immediately. */
export function captionColorProgress(elapsed: number, activeDuration: number, fade: boolean): number {
  if (!fade || activeDuration < 150) return 1
  return Math.max(0, Math.min(1, elapsed / Math.max(1, Math.floor(activeDuration * .3))))
}
