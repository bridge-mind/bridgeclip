import { useEffect, useRef, useState, type RefObject } from 'react'
import type { CandidateEdit, EditorProject } from '../../shared/clip-editor'
import { captionAnchor } from '../lib/caption-preview'
import { captionPreviewPreset, textShadow } from './CaptionPresetPicker'

// Preset sizes in the export's 1080×1920 coordinate system. Browser font metrics
// differ from libass; this is a placement guide, not a pixel-exact render.
const SIZES: Record<string, number> = { pop: 84, spotlight: 80, impact: 124, glow: 80, boxed: 70, sweep: 76, editorial: 112, hype: 88, punch: 150, neon: 78, headline: 72, paper: 68, subtle: 70 }

export function EditorCaptionPreview({ canvas, project, candidate, time, disabled, onMove, onDrag }: {
  canvas: RefObject<HTMLCanvasElement | null>; project: EditorProject; candidate: CandidateEdit; time: number
  disabled: boolean; onMove: (y: number, remember: boolean) => void; onDrag: (active: boolean) => void
}): React.JSX.Element | null {
  const [bounds, setBounds] = useState({ width: 0, height: 0, left: 0, top: 0 })
  const drag = useRef<{ pointer: number; start: number; y: number; changed: boolean } | null>(null)
  useEffect(() => {
    const element = canvas.current, parent = element?.parentElement
    if (!element || !parent) return
    const measure = (): void => {
      const box = element.getBoundingClientRect(), outer = parent.getBoundingClientRect()
      const aspect = element.width / element.height
      const width = Math.min(box.width, box.height * aspect), height = width / aspect
      setBounds({ width, height, left: box.left - outer.left + (box.width - width) / 2, top: box.top - outer.top + (box.height - height) / 2 })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element); observer.observe(parent); measure()
    return () => observer.disconnect()
  }, [canvas, project.aspect_ratio])
  const preset = captionPreviewPreset(candidate.caption_preset, candidate.custom_caption), landscape = project.aspect_ratio === '16:9'
  const anchor = captionAnchor(project, candidate, time)
  const scale = bounds.width / (landscape ? 1920 : 1080)
  const size = (candidate.custom_caption?.style.font_size ?? SIZES[preset.id] ?? 84) * (landscape ? .65 : 1) * scale * .8
  const shadow = textShadow(preset, scale * 3)
  if (!candidate.captions || !bounds.width) return null
  return <div className="editor-caption-overlay" style={bounds}>
    <button type="button" aria-label="Subtitle position" title="Drag up or down to position subtitles. Arrow keys move them; Shift moves farther."
      className="editor-caption-preview" disabled={disabled}
      style={{ top: `${anchor.y * 100}%`, transform: `translate(-50%, ${anchor.bottom ? '-100%' : '-50%'})`, fontSize: size,
        fontFamily: preset.font, fontWeight: preset.weight, fontStyle: preset.italic ? 'italic' : 'normal',
        textTransform: preset.uppercase ? 'uppercase' : 'none', color: preset.primary, textShadow: shadow }}
      onPointerDown={e => {
        if (e.button !== 0) return
        e.preventDefault(); e.stopPropagation()
        const box = e.currentTarget.getBoundingClientRect()
        drag.current = { pointer: e.pointerId, start: e.clientY, y: anchor.y - (anchor.bottom ? box.height / bounds.height / 2 : 0), changed: false }
        e.currentTarget.focus({ preventScroll: true }); e.currentTarget.setPointerCapture(e.pointerId); onDrag(true)
      }}
      onPointerMove={e => {
        const state = drag.current
        if (!state || e.pointerId !== state.pointer || Math.abs(e.clientY - state.start) < 2 && !state.changed) return
        onMove(Math.max(.1, Math.min(.9, state.y + (e.clientY - state.start) / bounds.height)), !state.changed)
        state.changed = true
      }}
      onLostPointerCapture={() => { drag.current = null; onDrag(false) }}
      onKeyDown={e => {
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
        e.preventDefault(); e.stopPropagation()
        const direction = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1
        const center = anchor.y - (anchor.bottom ? e.currentTarget.getBoundingClientRect().height / bounds.height / 2 : 0)
        onMove(Math.max(.1, Math.min(.9, center + direction * (e.shiftKey ? .05 : .01))), true)
      }}>
      <span className="editor-caption-words" style={{ background: preset.plate }}>
        {['Captions', 'go', 'here'].map((word, i) => <span key={i} style={{ color: i === 1 ? preset.highlight : preset.primary,
          background: i === 1 ? preset.pill : undefined,
          padding: preset.pill ? '0 .15em' : undefined, borderRadius: '.15em',
          textShadow: i === 1 && preset.glow ? [shadow === 'none' ? '' : shadow, `0 0 ${size / 3}px ${preset.glow}`].filter(Boolean).join(', ') : undefined }}>{word}</span>)}
      </span>
    </button>
  </div>
}
