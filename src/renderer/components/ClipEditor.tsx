import { SavedStageTimings } from './StageBreakdown'
import { registerNavigationCommit } from '../lib/navigation'
import { nextCaptionRange } from '../lib/caption-ranges'
import { cloneElement, isValidElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Archive, Check, ChevronLeft, ChevronRight, ChevronDown, Download, Film, Loader2, Pause, Pencil, Play, Redo2, RotateCcw, Scissors, SkipBack, Undo2, X } from 'lucide-react'
import { getApi } from '../lib/ipc'
import { cn, errorMessage, formatTimecode, localFileUrl, parseTimecode } from '../lib/utils'
import { EDITOR_REVISION_CONFLICT, cameraMarkers, snapFrame, stepFrame, candidateEdit, canAnimateScene, defaultCrop, editDuration, editSignature, editorProgress, framingAt, normalizeSceneTransitions, refineEdit, renderEditKey, resizeCrop, retimeScene, sceneAt, trimRange, type CandidateEdit, type Crop, type CropCorner, type EditorCandidate, type EditorQuestion, type EditorRange, type EditorScene, type EditorSession } from '../../shared/clip-editor'
import { CameraChanges, CameraScanButton } from './CameraChanges'
import { ActionMenu } from './ui/ActionMenu'
import { Button } from './ui/Button'
import { ConfirmDialog } from './ui/ConfirmDialog'
import { CaptionPresetPicker } from './CaptionPresetPicker'
import { EditorCaptionPreview } from './EditorCaptionPreview'
import { captionAnchor } from '../lib/caption-preview'
import { Switch } from './ui/Switch'
import { Select } from './ui/Select'
import { EditInspector } from './EditInspector'

const labels: Record<string, string> = { not_sponsored: 'Not sponsored', opening_context: 'Opening context', self_contained: 'Self contained', complete_ending: 'Complete ending', logical_flow: 'Logical flow', faithful_to_source: 'Faithful to source', title_supported: 'Title supported', evidence: 'Enough evidence', removal_safe: 'Safe to remove', join_logical: 'Natural join' }
const clock = (n: number): string => `${formatTimecode(n)}.${String(Math.floor(n % 1000)).padStart(3, '0')}`
const cropCorners: CropCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
const statusLabels = { refining: 'Refining', ready: 'Ready', baked: 'Baked', discarded: 'Discarded' }
const formatBytes = (n: number): string => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`
const reviewCurrent = (c: EditorCandidate): boolean => {
  try { return JSON.stringify(JSON.parse(c.review?.signature ?? 'null')) === editSignature(c) } catch { return false }
}
function Question({ q }: { q: EditorQuestion }): React.JSX.Element {
  const passed = q.probability !== null && q.probability >= q.threshold
  const words = (text: string): string => text.replaceAll('`retained_dialogue`', 'this clip').replaceAll('`before`', 'the preceding context').replaceAll('`after`', 'the following context').replaceAll('`title`', 'the title').replaceAll('`visual_observations`', 'visual evidence')
  return <details className="editor-question">
    <summary><span className={cn('editor-dot', passed ? 'bg-success' : 'bg-warning')} /><span>{labels[q.id] ?? q.id}</span><span className={cn('ml-auto font-mono', passed ? 'text-success' : 'text-warning')}>{q.probability === null ? 'Not rated' : `${Math.round(q.probability * 100)}%`}</span><ChevronDown size={12} /></summary>
    <p>{words(q.prompt)}</p><p className="text-ink-subtle">{q.probability === null ? `Review ${q.status.replaceAll('_', ' ')}. ` : ''}Target: {Math.round(q.threshold * 100)}%</p>
    <p><span className="text-success">Pass: </span>{q.yes}</p><p><span className="text-warning">Consider: </span>{q.no}</p>
  </details>
}

export function ClipEditor({ outputDir, leading, onExports }: { outputDir: string; leading?: ReactNode; onExports: () => Promise<void> }): React.JSX.Element {
  const [session, setSession] = useState<EditorSession | null>(null)
  const [edits, setEdits] = useState<EditorCandidate[]>([])
  const editsRef = useRef(edits); editsRef.current = edits
  const sessionRef = useRef(session); sessionRef.current = session
  const savedKey = useRef('')
  const savePromise = useRef<Promise<void> | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A stale-revision save can never succeed; offer a reload instead of a retry loop.
  const [conflict, setConflict] = useState(false)
  const [confirmFree, setConfirmFree] = useState(false)
  const closeFree = useCallback(() => setConfirmFree(false), [])
  /** Render identity of each clip when it left Baked, so undo can restore Baked. */
  const bakedKeys = useRef(new Map<string, string>())
  const [busy, setBusy] = useState<EditorSession['operation']>(null)
  const [batch, setBatch] = useState<EditorSession['batch']>()
  const [progress, setProgress] = useState<EditorSession['progress']>()
  const [notice, setNotice] = useState<string | null>(null)
  const [replacement, setReplacement] = useState<string | null>(null)
  const closeReplacement = useCallback(() => setReplacement(null), [])
  const [selected, setSelected] = useState(0)
  const [tab, setTab] = useState<'review' | 'framing' | 'captions' | 'transcript'>('review')
  const [time, setTime] = useState(0)
  const timeRef = useRef(time); timeRef.current = time
  const [playing, setPlaying] = useState(false)
  const [reviewSpeed, setReviewSpeed] = useState(1)
  const [previewCut, setPreviewCut] = useState(true)
  const [showSubtitlePreview, setShowSubtitlePreview] = useState(true)
  const [cameraThreshold, setCameraThreshold] = useState(.08)
  const [selectedCamera, setSelectedCamera] = useState<number | null>(null)
  const deselectCamera = useCallback(() => setSelectedCamera(null), [])
  const [timelineZoom, setTimelineZoom] = useState<'clip' | 'source' | [number, number]>('clip')
  const zoomWindow = Array.isArray(timelineZoom) ? timelineZoom : null
  const presentedTime = useRef<number | null>(null)
  const [cropDragging, setCropDragging] = useState(false)
  const dragging = useRef(false)
  const editorRoot = useRef<HTMLElement>(null)
  const [dragWindow, setDragWindow] = useState<[number, number] | null>(null)
  const previewCutRef = useRef(previewCut); previewCutRef.current = previewCut
  const [panel, setPanel] = useState(0)
  const [showAudit, setShowAudit] = useState(false)
  const [undo, setUndo] = useState<EditorCandidate[][]>([])
  const [redo, setRedo] = useState<EditorCandidate[][]>([])
  const [editingCaption, setEditingCaption] = useState<number | null>(null)
  const firstCaptionChange = useRef(true)
  const captionInput = useRef<HTMLTextAreaElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const transcriptPanel = useRef<HTMLDivElement>(null)
  const activeCaption = useRef<HTMLDivElement>(null)
  const activeTranscript = session?.project.transcript.find((r) => time >= r.start_ms && time < r.end_ms)
  const candidate = edits[selected]
  const candidateRef = useRef(candidate); candidateRef.current = candidate
  const frames = candidate?.camera_scan?.frames ?? []
  const currentScene = candidate ? sceneAt(candidate, time) : null
  const key = JSON.stringify(edits.map(candidateEdit))
  const keyRef = useRef(key); keyRef.current = key
  const load = useCallback(async () => {
    try {
      const s = await getApi().editor.open(outputDir)
      if (!sessionRef.current) setSelected(editorProgress(s.project.candidates).initialCandidate)
      setSession(s); sessionRef.current = s; setEdits(s.project.candidates); editsRef.current = s.project.candidates
      savedKey.current = JSON.stringify(s.project.candidates.map(candidateEdit))
      keyRef.current = savedKey.current
      setBusy(s.operation ?? null); setBatch(s.batch); setProgress(s.progress); setError(null); setConflict(false)
    } catch (e) { setError(errorMessage(e)) }
  }, [outputDir])
  useEffect(() => { void load() }, [load])
  // A reopened window can reconnect to an export/review still owned by main.
  // Poll only progress; reload the project once that operation ends.
  useEffect(() => {
    if (!session?.operation) return
    let pending = false
    const timer = window.setInterval(() => {
      if (pending) return
      pending = true
      void getApi().editor.progress(outputDir).then((p) => {
        if (!p.operation) return load()
        setBatch(p.batch); setProgress(p.progress)
      }).catch(() => {}).finally(() => { pending = false })
    }, 1500)
    return () => window.clearInterval(timer)
  }, [session?.operation, load, outputDir])

  const save = useCallback(async (): Promise<void> => {
    if (savePromise.current) await savePromise.current
    if (!sessionRef.current || keyRef.current === savedKey.current) return
    const task = async (): Promise<void> => {
      setSaving(true)
      try {
        while (keyRef.current !== savedKey.current) {
          const sentKey = keyRef.current
          const s = await getApi().editor.save(outputDir, sessionRef.current!.project.revision, editsRef.current)
          savedKey.current = sentKey; sessionRef.current = s; setSession(s)
        }
      } catch (e) {
        if (errorMessage(e).includes(EDITOR_REVISION_CONFLICT)) setConflict(true)
        throw e
      } finally { setSaving(false); savePromise.current = null }
    }
    savePromise.current = task()
    await savePromise.current
  }, [outputDir])
  useEffect(() => {
    if (!session || busy || dragWindow || cropDragging || key === savedKey.current) return
    const timer = window.setTimeout(() => { void save().catch((e) => setError(errorMessage(e))) }, 700)
    return () => window.clearTimeout(timer)
  }, [key, session, busy, dragWindow, cropDragging, save])
  useEffect(() => registerNavigationCommit(async () => {
    try { await save() } catch (e) { setError(errorMessage(e)); throw e }
  }), [save])
  // Flush in-memory edits on page navigation; main owns the durable write.
  useEffect(() => () => { void save().catch(() => {}) }, [save])
  // Unsaved edits block unload; main then asks Save / Discard / Cancel and,
  // for Save, asks this editor to save before it continues the close.
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent): void => { if (keyRef.current !== savedKey.current) event.preventDefault() }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [])
  useEffect(() => getApi().editor.onSaveBeforeClose?.(() => {
    void save().then(() => getApi().editor.closeReady(true), (e) => {
      setError(errorMessage(e))
      return getApi().editor.closeReady(false)
    }).catch(() => {})
  }), [save])

  const change = (patch: Partial<CandidateEdit>, remember = true): void => {
    if (busy || !candidate || (candidate.status === 'discarded' && patch.status === undefined)) return
    if (patch.scenes) patch = { ...patch, scenes: normalizeSceneTransitions(patch.scenes) }
    if (candidate.status === 'baked') bakedKeys.current.set(candidate.id, renderEditKey(candidate))
    if (remember) { setUndo((u) => [...u.slice(-49), edits]); setRedo([]) }
    setEdits((items) => items.map((c, i) => i === selected ? refineEdit(c, patch) : c))
  }
  const history = (direction: 'undo' | 'redo'): void => {
    const from = direction === 'undo' ? undo : redo
    if (busy || !from.length) return
    // Undo can restore an old edit, but only a completed render creates Baked:
    // the exact render a clip left (main checks the same identity on save).
    const next = from[from.length - 1].map((c, i) => c.status === 'baked' && edits[i].status !== 'baked' &&
      bakedKeys.current.get(c.id) !== renderEditKey(c) ? { ...c, status: 'refining' as const } : c)
    setEditingCaption(null)
    if (direction === 'undo') { setUndo(from.slice(0, -1)); setRedo((r) => [...r, edits]) }
    else { setRedo(from.slice(0, -1)); setUndo((u) => [...u, edits]) }
    setEdits(next)
  }
  const seek = (t: number): void => {
    if (!video.current || !session) return
    const value = Math.max(0, Math.min(session.project.duration_ms - 1, t))
    presentedTime.current = null
    timeRef.current = value
    video.current.currentTime = value / 1000 + (frames.length ? .000001 : 0); setTime(value)
  }
  const frameStep = (direction: -1 | 1, count = 1): void => {
    video.current?.pause()
    let next = timeRef.current
    for (let i = 0; i < count; i++) next = stepFrame(frames, next, direction)
    seek(next)
  }
  const scrub = (direction: -1 | 1, coarse: boolean): void => {
    video.current?.pause()
    if (coarse) seek(timeRef.current + direction * 1000)
    else frameStep(direction, Math.round(reviewSpeed))
  }
  const toggle = (): void => {
    const v = video.current
    if (!v || !candidate) return
    if (!v.paused) {
      v.pause(); setPlaying(false)
      const panel = transcriptPanel.current
      if (panel) panel.scrollTo({ top: panel.scrollTop, behavior: 'instant' })
      return
    }
    if (previewCut && !candidate.ranges.some(([a, b]) => a <= v.currentTime * 1000 && b > v.currentTime * 1000)) seek(candidate.ranges[0][0])
    void v.play().catch(() => setError('The source preview could not play. Try seeking or reopening the editor.'))
  }
  const trim = (edge: 'in' | 'out', t: number): void => {
    if (!candidate) return
    change({ ranges: trimRange(candidate.ranges, edge === 'in' ? 0 : candidate.ranges.length - 1, edge === 'in' ? 0 : 1, t, session!.project.duration_ms) })
  }
  const split = (): void => {
    if (!candidate) return
    const t = Math.round(time)
    const ranges = candidate.ranges.flatMap(([a, b]): [number, number][] => t > a + 100 && t < b - 100 ? [[a, t], [t, b]] : [[a, b]])
    if (ranges.length <= 24) change({ ranges })
  }
  useEffect(() => {
    const playbackKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      const speedKey = !e.shiftKey && /^[123]$/.test(e.key)
      const timelineArrow = (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && target.matches('.editor-source-scrub,.editor-fine-scrub')
      // Range inputs otherwise use a browser-defined percentage of their span,
      // making arrow jumps depend on focus and timeline zoom.
      if (timelineArrow) e.preventDefault()
      if ((e.code !== 'Space' && !speedKey && !timelineArrow) || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || showAudit || replacement || busy) return
      if ((!editorRoot.current?.contains(target) && target !== document.body) ||
          target.closest('[role="dialog"],[role="combobox"],[role="listbox"],[role="menu"],[aria-haspopup="menu"],[aria-haspopup="dialog"],input:not([type="range"]),textarea,select,[contenteditable]:not([contenteditable="false"])')) return
      // Own Space before focused buttons/markers can activate or seek on it.
      // A held key must not repeatedly pause and restart playback.
      e.preventDefault(); e.stopPropagation()
      if (dragging.current) return
      if (timelineArrow) scrub(e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey)
      else if (!e.repeat) {
        if (speedKey) setReviewSpeed(Number(e.key))
        else toggle()
      }
    }
    const handler = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement).closest('[role="dialog"],[role="combobox"],[role="listbox"],[role="menu"],[aria-haspopup="menu"],input,textarea,select,[contenteditable]') || showAudit || replacement || dragging.current) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); history(e.shiftKey ? 'redo' : 'undo'); return }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void save(); return }
      if (e.metaKey || e.ctrlKey || e.altKey || busy) return
      if (e.key.toLowerCase() === 'i') trim('in', time)
      if (e.key.toLowerCase() === 'o') trim('out', time)
      if (e.key.toLowerCase() === 's') split()
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); scrub(e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey) }
    }
    window.addEventListener('keydown', playbackKey, true)
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', playbackKey, true)
      window.removeEventListener('keydown', handler)
    }
  })
  useEffect(() => {
    if (candidate && video.current) { video.current.pause(); seek(candidate.ranges[0][0]); setPanel(0); setEditingCaption(null); setSelectedCamera(null); setTimelineZoom((zoom) => zoom === 'source' ? 'source' : 'clip') }
  // Only candidate selection resets the playhead, never an edit.
  }, [selected, session?.previewPath])
  useEffect(() => { if (video.current && candidate) video.current.playbackRate = candidate.video_speed * reviewSpeed }, [candidate?.video_speed, reviewSpeed])
  useEffect(() => {
    if (tab !== 'transcript' || !playing || video.current?.paused || showAudit || editingCaption !== null || !activeTranscript) return
    const panel = transcriptPanel.current, caption = activeCaption.current
    if (!panel || !caption) return
    const bounds = panel.getBoundingClientRect(), row = caption.getBoundingClientRect()
    if (row.top >= bounds.top + 12 && row.bottom <= bounds.bottom - 12) return
    // Scroll only the inspector, leaving the video and timeline in place.
    const inset = Math.max(12, (panel.clientHeight - row.height) / 2)
    panel.scrollTo({ top: panel.scrollTop + row.top - bounds.top - inset,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    return () => { panel.scrollTo({ top: panel.scrollTop, behavior: 'instant' }) }
  }, [activeTranscript, playing, tab, selected, showAudit, editingCaption])
  useEffect(() => {
    if (editingCaption === null || tab !== 'transcript' || !captionInput.current || !transcriptPanel.current) return
    const input = captionInput.current, panel = transcriptPanel.current
    input.focus({ preventScroll: true })
    panel.scrollTo({ top: panel.scrollTop + input.getBoundingClientRect().top - panel.getBoundingClientRect().top - 36, behavior: 'instant' })
  }, [editingCaption, tab])
  useEffect(() => {
    const v = video.current
    if (!v) return
    let callback = 0
    const presented: VideoFrameRequestCallback = (_, metadata) => {
      const sourceFrames = candidateRef.current?.camera_scan?.frames ?? []
      const t = snapFrame(sourceFrames, Math.round(metadata.mediaTime * 1000000) / 1000)
      presentedTime.current = t
      if (!v.seeking && !v.paused) setTime(t)
      callback = v.requestVideoFrameCallback(presented)
    }
    callback = v.requestVideoFrameCallback(presented)
    return () => v.cancelVideoFrameCallback(callback)
  }, [session?.previewPath])
  useEffect(() => {
    let frame = 0
    const draw = (): void => {
      const v = video.current, out = canvas.current, c = candidateRef.current
      if (v && out && c && v.readyState >= 2 && !v.seeking) {
        // A paused seek can decode the frame just before a layout boundary.
        // Keep the preview on the same selected time as the crop controls;
        // during playback, follow the actual presented frame for cut accuracy.
        let t = v.paused ? timeRef.current : presentedTime.current ?? v.currentTime * 1000
        if (!v.paused && previewCutRef.current) {
          const clockTime = v.currentTime * 1000
          const range = c.ranges.find(([, end]) => end > clockTime)
          if (!range) { v.pause(); t = c.ranges.at(-1)![1]; v.currentTime = t / 1000; presentedTime.current = null; setTime(t) }
          else if (clockTime < range[0]) { t = range[0]; v.currentTime = t / 1000; presentedTime.current = null }
        }
        const scene = framingAt(c, t), ctx = out.getContext('2d')!
        ctx.clearRect(0, 0, out.width, out.height)
        if (scene.layout === 'fit') {
          ctx.filter = 'blur(16px) brightness(.75)'; ctx.drawImage(v, 0, 0, out.width, out.height); ctx.filter = 'none'
          const scale = Math.min(out.width / v.videoWidth, out.height / v.videoHeight)
          const w = v.videoWidth * scale, h = v.videoHeight * scale
          ctx.drawImage(v, (out.width - w) / 2, (out.height - h) / 2, w, h)
        } else scene.crops.forEach(([x, y, w, h], i) => ctx.drawImage(v, x * v.videoWidth, y * v.videoHeight, w * v.videoWidth, h * v.videoHeight, 0, i * out.height / scene.crops.length, out.width, out.height / scene.crops.length))
      }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [])

  const run = async (action: 'review' | 'export' | 'export-all' | 'scan-cameras'): Promise<void> => {
    if (!candidate || busy) return
    video.current?.pause(); setError(null); setNotice(null); setBatch(undefined); setBusy(action)
    setProgress(action === 'scan-cameras' ? { phase: 'scan', percent: 0 } : undefined)
    let saved = false, active = true, pollPending = false, polling: number | undefined
    const count = edits.filter((c) => c.status === 'ready').length
    try {
      await save()
      saved = true
      if (action === 'export-all') setBatch({ completed: 0, total: count })
      if (action === 'export-all' || action === 'scan-cameras') {
        polling = window.setInterval(() => {
          if (pollPending) return
          pollPending = true
          void getApi().editor.progress(outputDir).then((s) => {
            if (!active) return
            if (s.batch) setBatch(s.batch)
            if (s.progress) setProgress(s.progress)
          }).catch(() => {}).finally(() => { pollPending = false })
        }, 1000)
      }
      const s = await getApi().editor.run(outputDir, sessionRef.current!.project.revision, candidate.id, action)
      setSession(s); sessionRef.current = s; setEdits(s.project.candidates); setUndo([]); setRedo([])
      editsRef.current = s.project.candidates
      savedKey.current = JSON.stringify(s.project.candidates.map(candidateEdit))
      keyRef.current = savedKey.current
      if (action === 'scan-cameras') { setSelectedCamera(null); setTab('framing'); setNotice('Scan complete. Select a camera marker to inspect the cut, insert a layout, or dismiss it. Arrow keys step through source frames.') }
      if (action === 'export-all') setNotice(`Baked ${count} ready clip${count === 1 ? '' : 's'}. Your exports are ready.`)
    } catch (e) {
      // Earlier exports in a batch are durable even if a later one fails.
      if (saved) { await load(); setUndo([]); setRedo([]) }
      const message = errorMessage(e)
      setError(action === 'scan-cameras' && message.includes('Invalid editor operation')
        ? 'Restart BridgeClip to load camera scanning. Your edits are saved.'
        : message)
      if (message.includes(EDITOR_REVISION_CONFLICT)) setConflict(true)
    } finally { active = false; window.clearInterval(polling); setBusy(null); setBatch(undefined); setProgress(undefined) }
  }
  const chooseReplacement = async (): Promise<void> => {
    video.current?.pause(); setEditingCaption(null)
    try {
      if (typeof getApi().editor.replaceSource !== 'function') throw new Error('Restart BridgeClip to enable source replacement. Your edits will be saved when you leave the editor.')
      setReplacement(await getApi().dialog.selectVideo())
    } catch (e) { setError(errorMessage(e)) }
  }
  const replaceSource = async (path: string): Promise<void> => {
    setBusy('replace-source'); setError(null); setNotice(null)
    let saved = false
    try {
      await save(); saved = true
      await getApi().editor.replaceSource(outputDir, sessionRef.current!.project.revision, path)
      await load(); setUndo([]); setRedo([])
      setNotice('Source replaced. Your edits are preserved. Previously baked clips are ready to bake again; existing exports are unchanged.')
    } catch (e) {
      if (saved) await load()
      setError(errorMessage(e))
    } finally { setBusy(null) }
  }
  const freeMedia = async (): Promise<void> => {
    setBusy('save'); setError(null); setNotice(null)
    try {
      await save()
      const s = await getApi().editor.freeMedia(outputDir, sessionRef.current!.project.revision)
      setSession(s); sessionRef.current = s; setUndo([]); setRedo([])
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(null) }
  }
  if (session?.project.media_freed) return <div className="p-8 space-y-4">{leading}
    <p role="status" className="text-sm">Editor media for this project was freed to save disk space. Your exported clips are unchanged; the project is now read-only.</p>
    <Button onClick={() => { void onExports().catch((e) => setError(errorMessage(e))) }}>View exports</Button>{error && <p role="alert" className="text-danger">{error}</p>}</div>
  if (!session || !candidate || !currentScene) return <div className="p-8 space-y-4">{leading}<p role={error ? 'alert' : 'status'}>{error ?? 'Opening editor…'}</p><Button onClick={() => { void load() }}>Retry</Button></div>
  const safeLeading = isValidElement<{ onClick?: () => void }>(leading) && leading.props.onClick
    ? cloneElement(leading, { onClick: () => { void save().then(() => leading.props.onClick?.()).catch((e) => setError(errorMessage(e))) } }) : leading
  const project = session.project, aspect = project.aspect_ratio === '9:16' ? 9 / 16 : 16 / 9
  // Renderer hot reload can precede a main-process restart in development.
  // Older editor sessions omit this field; treat them like legacy projects.
  const suppressedCaptions = candidate.caption_suppression_ranges ?? []
  const captionPosition = candidate.caption_y ?? captionAnchor(project, candidate, time).y
  const moveCaption = (y: number, remember = true): void => { video.current?.pause(); change({ caption_y: Math.round(y * 1000) / 1000 }, remember) }
  const status = candidate.status ?? 'refining'
  const readyCount = edits.filter((c) => c.status === 'ready').length
  const finished = editorProgress(edits).remaining === 0
  const editingDisabled = !!busy || status === 'discarded'
  const captionText = (index: number): string => candidate.caption_edits?.find((e) => e.segment === index)?.text ?? project.transcript[index].text
  const canEditCaption = (index: number): boolean => !editingDisabled && (candidate.caption_edits.length < 2000 || candidate.caption_edits.some((e) => e.segment === index))
  const editCaption = (index: number): void => {
    if (!canEditCaption(index)) return
    video.current?.pause(); firstCaptionChange.current = true; setTab('transcript'); setEditingCaption(index)
  }
  const updateCaption = (index: number, text: string, remember = true): void => {
    const caption_edits = (candidate.caption_edits ?? []).filter((e) => e.segment !== index)
    if (text !== project.transcript[index].text) caption_edits.push({ segment: index, text })
    change({ caption_edits: caption_edits.sort((a, b) => a.segment - b.segment) }, remember)
  }
  const current = reviewCurrent(candidate)
  const start = candidate.ranges[0][0], end = candidate.ranges[candidate.ranges.length - 1][1]
  const [viewStart, viewEnd] = dragWindow ?? zoomWindow ?? (timelineZoom === 'source' ? [0, project.duration_ms] : [Math.max(0, start - 10000), Math.min(project.duration_ms, end + 10000)])
  const sceneIndex = candidate.scenes.indexOf(currentScene)
  const canAnimate = canAnimateScene(candidate.scenes, sceneIndex)
  const crop = currentScene.crops[Math.min(panel, currentScene.crops.length - 1)]
  const sceneChange = (patch: Partial<EditorScene>, remember = true): void => change({ scenes: candidate.scenes.map((s, i) => i === sceneIndex ? { ...s, ...patch } : s) }, remember)
  const cropChange = (c: Crop, remember = true): void => sceneChange({ crops: currentScene.crops.map((r, i) => i === Math.min(panel, currentScene.crops.length - 1) ? c : r) }, remember)
  const setLayout = (layout: EditorScene['layout']): void => {
    setPanel(0)
    sceneChange({ layout, crops: layout === 'split' ? [defaultCrop(project.width, project.height, aspect * 2, .25), defaultCrop(project.width, project.height, aspect * 2, .75)] : [defaultCrop(project.width, project.height, aspect)] })
  }
  const newLayout = (position?: number): void => {
    const v = video.current
    if (!v || editingDisabled) return
    v.pause()
    const at = snapFrame(frames, position ?? presentedTime.current ?? v.currentTime * 1000)
    if (candidate.scenes.length >= 60 || at <= start || at >= end || candidate.scenes.some((s) => Math.abs(s.at_ms - at) < .01)) return
    change({ scenes: [...candidate.scenes, { ...structuredClone(framingAt(candidate, at)), at_ms: at, transition_ms: undefined }].sort((a, b) => a.at_ms - b.at_ms) })
    // Keep the exact frame boundary selected while adjusting its crops.
    seek(at); setTab('framing')
  }
  const moveScene = (index: number, at: number): void => {
    if (editingDisabled) return
    const scenes = retimeScene(candidate.scenes, index, at, project.duration_ms, frames)
    if (scenes === candidate.scenes) return
    video.current?.pause(); change({ scenes }); seek(scenes[index].at_ms); setTab('framing')
    if (scenes[index].at_ms < viewStart || scenes[index].at_ms > viewEnd) setTimelineZoom('source')
  }
  const startSceneDrag = (e: React.PointerEvent<HTMLButtonElement>, index: number): void => {
    if (editingDisabled || e.button !== 0) return
    e.preventDefault(); e.stopPropagation(); video.current?.pause()
    const target = e.currentTarget, bounds = target.parentElement!.getBoundingClientRect(), x = e.clientX
    const original = candidate.scenes[index].at_ms
    let previous = original, changed = false
    seek(original); setTab('framing'); setDragWindow([viewStart, viewEnd])
    dragging.current = true; target.focus({ preventScroll: true }); target.setPointerCapture(e.pointerId)
    const move = (event: PointerEvent): void => {
      if (!changed && Math.abs(event.clientX - x) < 3) return
      const t = original + (event.clientX - x) / bounds.width * (viewEnd - viewStart)
      const marker = cameraMarkers(candidate, cameraThreshold).reduce<number | null>((best, m) => Math.abs(m.at_ms - t) <= (viewEnd - viewStart) * 8 / bounds.width && (best === null || Math.abs(m.at_ms - t) < Math.abs(best - t)) ? m.at_ms : best, null)
      const scenes = retimeScene(candidate.scenes, index, Math.max(viewStart, Math.min(viewEnd, marker ?? t)), project.duration_ms, frames)
      const next = scenes[index].at_ms
      if (next === previous) return
      if (!changed) { setUndo((u) => [...u.slice(-49), edits]); setRedo([]); changed = true }
      previous = next
      setEdits((items) => items.map((c, i) => i === selected ? refineEdit(c, { scenes }) : c))
      seek(next)
    }
    const done = (): void => {
      target.removeEventListener('pointermove', move); target.removeEventListener('lostpointercapture', done)
      dragging.current = false; setDragWindow(null)
    }
    target.addEventListener('pointermove', move); target.addEventListener('lostpointercapture', done)
  }
  const startCropDrag = (e: React.PointerEvent<HTMLButtonElement>, index: number, corner?: CropCorner): void => {
    if (editingDisabled || e.button !== 0) return
    e.preventDefault(); e.stopPropagation(); setPanel(index); video.current?.pause()
    const target = e.currentTarget, bounds = target.closest('.editor-source-frame')!.getBoundingClientRect()
    const x = e.clientX, y = e.clientY, original = [...currentScene.crops[index]] as Crop
    let previous = original, changed = false
    dragging.current = true; target.focus({ preventScroll: true }); target.setPointerCapture(e.pointerId); setCropDragging(true)
    const move = (event: PointerEvent): void => {
      const dx = event.clientX - x, dy = event.clientY - y
      const next: Crop = corner ? resizeCrop(original, corner, dx, dy, bounds.width, bounds.height)
        : [Math.max(0, Math.min(1 - original[2], original[0] + dx / bounds.width)), Math.max(0, Math.min(1 - original[3], original[1] + dy / bounds.height)), original[2], original[3]]
      if (next.every((n, i) => Math.abs(n - previous[i]) < 1e-10)) return
      if (!changed) { setUndo((u) => [...u.slice(-49), edits]); setRedo([]); changed = true }
      previous = next
      setEdits((items) => items.map((c, ci) => ci !== selected ? c : refineEdit(c, {
        scenes: c.scenes.map((s, si) => si !== sceneIndex ? s : { ...s, crops: s.crops.map((crop, i) => i === index ? next : crop) })
      })))
    }
    const done = (): void => {
      target.removeEventListener('pointermove', move); target.removeEventListener('lostpointercapture', done)
      dragging.current = false; setCropDragging(false)
    }
    target.addEventListener('pointermove', move); target.addEventListener('lostpointercapture', done)
  }
  return <section ref={editorRoot} className="clip-editor" aria-label="Clip editor">
    <header className="editor-header"><div className="min-w-0 flex-1"><div className="flex items-center gap-3">{safeLeading}<span className="truncate text-sm font-medium">{project.title}</span></div><span className="text-2xs text-ink-subtle">{saving ? 'Saving…' : key !== savedKey.current ? 'Unsaved changes' : 'All changes saved'}</span></div>
      <Button variant="ghost" size="sm" onClick={() => setShowAudit(true)}>Transcript & edits</Button>
      {finished && <Button variant="ghost" size="sm" disabled={!!busy} tooltip="Every clip is baked or discarded. Delete this project's source copy and preview; exports stay in the Library." onClick={() => setConfirmFree(true)}>Free editor media{session.mediaBytes ? ` (${formatBytes(session.mediaBytes)})` : ''}</Button>}
      <Button size="sm" disabled={!!busy} onClick={() => { void save().then(onExports).catch((e) => setError(errorMessage(e))) }}>Exports</Button>
      <div className="editor-bake-actions" role="group" aria-label="Bake clips">
      <Button variant="primary" size="sm" disabled={!!busy || status !== 'ready'} title={status !== 'ready' ? 'Mark this clip ready after refining it' : 'Render the final clip with your changes'} icon={<Download size={14} />} onClick={() => { void run('export') }}>{candidate.captions ? 'Bake captions' : 'Render clip'}</Button>
      <ActionMenu label="More bake options" disabled={!!busy || readyCount === 0} icon={<ChevronDown aria-hidden size={14} />} triggerClassName="btn-primary editor-bake-toggle disabled:opacity-100" actions={[{ label: `Bake all ready clips (${readyCount})`, disabled: readyCount === 0, icon: <Download size={14} />, onSelect: () => { void run('export-all') } }]} />
      </div>
    </header>
    <div className="px-[18px]"><SavedStageTimings outputDir={outputDir} /></div>
    <div className="editor-stagebar">
      <span className={cn('editor-status', status)}>{status === 'baked' || status === 'ready' ? <Check size={12} /> : status === 'discarded' ? <Archive size={12} /> : <Pencil size={12} />}{statusLabels[status]}</span>
      <span className="editor-stage-hint">{status === 'refining' ? 'Review the cut, framing and captions.' : status === 'ready' ? 'Ready for the final render.' : status === 'baked' ? 'Your finished clip is in Exports.' : 'Set aside. Restore it whenever you need.'}</span>
      <div className="ml-auto flex gap-2">
        {status !== 'discarded' && <Button variant="ghost" size="sm" disabled={!!busy} icon={<Archive size={13} />} onClick={() => { video.current?.pause(); setEditingCaption(null); change({ status: 'discarded' }) }}>Discard</Button>}
        {status === 'refining' ? <Button size="sm" variant="primary" disabled={!!busy} icon={<Check size={13} />} onClick={() => { setEditingCaption(null); change({ status: 'ready' }) }}>Mark ready</Button>
          : <Button size="sm" disabled={!!busy} icon={<RotateCcw size={13} />} onClick={() => change({ status: 'refining' })}>{status === 'discarded' ? 'Restore clip' : status === 'baked' ? 'Refine again' : 'Keep refining'}</Button>}
      </div>
    </div>
    {error && <div role="alert" className="editor-notice text-danger">{conflict ? 'This project changed since the editor opened it, so your latest edits cannot be saved. Reload the project to continue from its saved state.' : error}{conflict
      ? <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={() => { setUndo([]); setRedo([]); bakedKeys.current.clear(); void load() }}>Reload project</Button>
      : key !== savedKey.current && <Button size="sm" variant="ghost" onClick={() => { setError(null); void save().catch((e) => setError(errorMessage(e))) }}>Retry save</Button>}</div>}
    {notice && !busy && <div role="status" className="editor-notice"><Check size={14} />{notice}<Button size="sm" variant="ghost" tooltip="Hide this completion message." aria-label="Dismiss bake notice" iconOnly icon={<X size={14} />} onClick={() => setNotice(null)} /></div>}
    {confirmFree && <ConfirmDialog onClose={closeFree} request={{
      title: 'Free editor media?', confirmLabel: 'Free media',
      body: <>Delete this project's copy of the source video and its editor preview{session.mediaBytes ? ` (${formatBytes(session.mediaBytes)})` : ''}?<br /><br />Your exported clips stay in the Library. The project becomes read-only: you won't be able to refine, re-bake or restore its clips again.</>,
      onConfirm: () => { void freeMedia() }
    }} />}
    {replacement && <ConfirmDialog onClose={closeReplacement} request={{
      title: 'Replace source video?', confirmLabel: 'Replace source', tone: 'primary',
      body: <>Use <strong>{replacement.split(/[\\/]/).pop()}</strong> for every clip in this project?<br /><br />Only recommended for the exact same video at higher quality: identical content, timing, audio and framing. Matching duration alone does not guarantee a match.<br /><br />Your cuts, layouts and caption edits will be kept. Previously baked clips will be ready to bake again. Existing exports will stay in the library.</>,
      onConfirm: () => { void replaceSource(replacement) }
    }} />}
    {busy && <div role="status" className="editor-notice"><Loader2 size={14} className="animate-spin" />{busy === 'scan-cameras' ? <div className="editor-scan-progress"><span>{progress?.phase === 'preview' ? 'Preparing frame-accurate preview (one-time)' : 'Scanning frames for camera changes'}… {progress?.percent ?? 0}%</span><progress aria-label={progress?.phase === 'preview' ? 'Preview preparation progress' : 'Camera scan progress'} max={100} value={progress?.percent ?? 0} /></div> : busy === 'replace-source' ? 'Replacing source and preparing preview…' : busy === 'export-all' ? `Baking ready clips… ${batch?.completed ?? 0} of ${batch?.total ?? readyCount} complete${batch?.failed ? `, ${batch.failed} failed` : ''}` : busy === 'review' ? 'Jev is reviewing your edit…' : busy === 'export' ? 'Baking your final clip…' : 'Saving…'}<Button size="sm" variant="ghost" onClick={() => { void getApi().editor.cancel(outputDir) }}>Cancel</Button></div>}
    <div className="editor-workspace">
      <aside className="editor-candidates"><div className="editor-pane-heading">Refine clips <span>{edits.length}</span></div>
        {(['refining', 'ready', 'baked', 'discarded'] as const).map((group) => {
          const items = edits.map((c, i) => ({ c, i })).filter(({ c }) => (c.status ?? 'refining') === group)
          if (!items.length) return null
          const cards = items.map(({ c, i }) => <button key={c.id} className={cn('editor-candidate', group, i === selected && 'selected')} onClick={() => setSelected(i)}>
            <span className="flex items-center justify-between text-2xs text-ink-subtle"><span>{String(i + 1).padStart(2, '0')}</span>{c.exports.length > 0 && <span title={`${c.exports.length} saved exports`} className="flex items-center gap-1"><Download size={11} />{c.exports.length}</span>}</span>
            <span className="block text-xs leading-relaxed mt-1">{c.title}</span><span className="flex items-center justify-between mt-2 text-2xs text-ink-subtle"><span>{formatTimecode(c.ranges[0][0])} · {(editDuration(c) / 1000).toFixed(1)}s</span><span title={!reviewCurrent(c) ? 'Jev review out of date' : c.review?.decision === 'passes' ? 'Jev checks passed' : 'Jev: consider before baking'} className={cn('editor-dot', !reviewCurrent(c) ? 'bg-ink-subtle' : c.review?.decision === 'passes' ? 'bg-success' : 'bg-warning')} /></span>
          </button>)
          return group === 'discarded'
            ? <details key={group} className="editor-discarded" open={status === 'discarded' ? true : undefined}><summary>Discarded <span>{items.length}</span><ChevronDown size={12} /></summary>{cards}</details>
            : <div key={group} className="editor-candidate-group"><div className={cn('editor-group-heading', group)}>{statusLabels[group]} <span>{items.length}</span></div>{cards}</div>
        })}
      </aside>
      <div className="editor-center">
        <div className="editor-monitors">
          <div className="editor-source-monitor"><div className="editor-pane-heading">Source <span>{project.width} × {project.height}</span><Button size="sm" variant="ghost" disabled={!!busy || saving} onClick={() => { void chooseReplacement() }}>Replace source video</Button></div>
            <div className="editor-source-frame" style={{ aspectRatio: project.width / project.height }}>
              <video ref={video} src={localFileUrl(session.previewPath)} preload="auto" playsInline
                onLoadedMetadata={() => { seek(start); if (video.current) video.current.playbackRate = candidate.video_speed * reviewSpeed }}
                onPlay={() => setPlaying(true)} onPause={() => {
                  setPlaying(false)
                  const panel = transcriptPanel.current
                  if (panel) panel.scrollTo({ top: panel.scrollTop, behavior: 'instant' })
                }} onEnded={() => setPlaying(false)}
                onError={() => setError('Source preview is unavailable. Reopen the project or check that its files still exist.')}
                onTimeUpdate={() => {
                  const v = video.current!; let t = v.currentTime * 1000
                  if (previewCut && !v.paused) {
                    const range = candidateRef.current!.ranges.find(([, b]) => t < b)
                    if (!range) { v.pause(); t = candidateRef.current!.ranges.at(-1)![1]; v.currentTime = t / 1000 }
                    else if (t < range[0]) { t = range[0]; v.currentTime = t / 1000 }
                  }
                  if (v.paused && presentedTime.current === null) setTime(t)
                }} />
              {tab === 'framing' && currentScene.layout !== 'fit' && currentScene.crops.map((r, i) => {
                const name = currentScene.layout === 'split' ? (i === 0 ? 'top' : 'bottom') : 'output'
                return <div key={i} className={cn('editor-crop', i === panel && 'active')} style={{ left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${r[2] * 100}%`, height: `${r[3] * 100}%` }}>
                  <button className="editor-crop-move" aria-label={`Move ${name} crop`} disabled={editingDisabled} onPointerDown={(e) => startCropDrag(e, i)}>
                    <span>{currentScene.layout === 'split' ? i === 0 ? '1' : '2' : ''}</span>
                  </button>
                  {cropCorners.map((corner) => <button key={corner} className={cn('editor-crop-corner', corner)} aria-label={`Resize ${name} crop from ${corner}`} title="Drag to resize · Arrow keys adjust · Shift for larger steps" disabled={editingDisabled}
                    onPointerDown={(e) => startCropDrag(e, i, corner)} onKeyDown={(e) => {
                      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
                      e.preventDefault(); e.stopPropagation(); setPanel(i); video.current?.pause()
                      const bounds = e.currentTarget.closest('.editor-source-frame')!.getBoundingClientRect(), step = e.shiftKey ? 10 : 1
                      const next = resizeCrop(r, corner, e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0, bounds.width, bounds.height)
                      if (next.some((n, index) => Math.abs(n - r[index]) > 1e-10)) sceneChange({ crops: currentScene.crops.map((c, ci) => ci === i ? next : c) })
                    }} />)}
                </div>
              })}
            </div>
            <p className="editor-monitor-hint">{tab === 'framing' ? 'Drag inside to move · Drag a corner to resize' : 'Space to play · I / O to trim · S to split'} · 1 / 2 / 3 for speed</p>
          </div>
          <div className="editor-output-monitor">
            <div className="editor-pane-heading">Output <span>{candidate.captions && suppressedCaptions.some(([a, b]) => a <= time && time < b) ? 'Captions suppressed' : project.aspect_ratio}</span></div>
            <canvas ref={canvas} width={aspect < 1 ? 360 : 640} height={aspect < 1 ? 640 : 360} style={{ aspectRatio: aspect }} />
            {showSubtitlePreview && (tab === 'transcript' || tab === 'captions') && <EditorCaptionPreview canvas={canvas} project={project} candidate={candidate} time={time} disabled={editingDisabled} onMove={moveCaption} onDrag={active => { dragging.current = active; if (active) video.current?.pause() }} />}
          </div>
        </div>
        <div className="editor-transport">
          <Button size="sm" variant="ghost" iconOnly icon={<ChevronLeft size={14} />} aria-label="Previous frame" tooltip="Move back one source frame. Exact after scanning; approximate outside scanned footage." disabled={!!busy || time <= .01} onClick={() => frameStep(-1)} />
          <Button size="sm" variant="ghost" iconOnly icon={<ChevronRight size={14} />} aria-label="Next frame" tooltip="Move forward one source frame. Exact after scanning; approximate outside scanned footage." disabled={!!busy || time >= project.duration_ms - 1 - .01} onClick={() => frameStep(1)} /><Button tooltip="Move the playhead to the beginning of this clip." aria-label="Back to start" iconOnly variant="ghost" icon={<SkipBack size={15} />} onClick={() => seek(start)} /><Button tooltip="Play or pause the preview. Shortcut: Space." aria-label="Play / pause" iconOnly icon={playing ? <Pause size={16} /> : <Play size={16} />} onClick={toggle} /><span className="font-mono text-xs">{clock(time)}</span><span className="text-ink-subtle text-2xs">/ {(editDuration(candidate) / 1000).toFixed(1)}s selected</span><label className="editor-review-speed" title="Preview only. Press 1/2/3 for speed; arrow keys step 1/2/3 source frames (1.5× rounds to two). Shift+arrows jump one second. Multiplies the clip’s export speed without changing the export.">Review speed<select aria-label="Review speed" value={reviewSpeed} onChange={(e) => {
            setReviewSpeed(Number(e.target.value))
            // Return Space to playback after choosing a speed.
            e.currentTarget.blur()
          }}>{[1, 1.5, 2, 3].map((speed) => <option key={speed} value={speed}>{speed}×</option>)}</select></label><label className="ml-auto flex gap-2 items-center text-2xs text-ink-muted"><input type="checkbox" checked={previewCut} onChange={(e) => setPreviewCut(e.target.checked)} />Play cuts only</label></div>
        <div className="editor-timeline">
          <div className="editor-timeline-tools">
            <CameraScanButton key={candidate.id} candidate={candidate} threshold={cameraThreshold} setThreshold={setCameraThreshold}
              restore={() => change({ dismissed_camera_markers: [] })} disabled={editingDisabled} onOpen={() => video.current?.pause()} scan={() => { void run('scan-cameras') }} />
            <Button variant="ghost" size="sm" tooltip="Undo the last editor change (⌘/Ctrl+Z)." aria-label="Undo" iconOnly icon={<Undo2 size={14} />} disabled={!undo.length || !!busy} onClick={() => history('undo')} /><Button variant="ghost" size="sm" tooltip="Redo the change you just undid (⌘/Ctrl+Shift+Z)." aria-label="Redo" iconOnly icon={<Redo2 size={14} />} disabled={!redo.length || !!busy} onClick={() => history('redo')} /><Button variant="ghost" size="sm" icon={<Scissors size={14} />} tooltip="Split the cut at the playhead into two editable sections. No footage is removed. Shortcut: S." onClick={split} disabled={editingDisabled || candidate.ranges.length >= 24}>Split</Button><Button variant="ghost" size="sm" disabled={editingDisabled || (time >= start && time <= end)} tooltip="Extend the clip’s beginning or ending to the playhead. Turn off Play cuts only to move beyond the current cut." onClick={() => { const t = (video.current?.currentTime ?? time / 1000) * 1000; if (t < start) trim('in', t); else if (t > end) trim('out', t) }}>Extend to playhead</Button><span className="ml-auto text-2xs text-ink-subtle">{clock(viewStart)} — {clock(viewEnd)}</span></div>
          <input aria-label="Source timeline" className="editor-source-scrub" type="range" min={0} max={project.duration_ms} step="any" value={time} onChange={(e) => seek(snapFrame(frames, Number(e.target.value)))} />
          <CameraChanges candidate={candidate} threshold={cameraThreshold} selected={selectedCamera} deselect={deselectCamera}
            select={(t) => { video.current?.pause(); setSelectedCamera(t); seek(t); setTab('framing'); if (zoomWindow) setTimelineZoom([Math.max(0, t - 1000), Math.min(project.duration_ms, t + 1000)]) }}
            insert={newLayout} align={moveScene}
            remove={(t) => { change({ dismissed_camera_markers: [...(candidate.dismissed_camera_markers ?? []), t] }); setSelectedCamera(null) }}
            disabled={editingDisabled} viewStart={viewStart} viewEnd={viewEnd} clock={clock} />
          <div className="editor-overview" aria-label="All candidate moments">{edits.map((c, i) => <button key={c.id} title={c.title} aria-label={`Jump to candidate ${i + 1}: ${c.title}`} className={cn(i === selected && 'selected')} style={{ left: `${c.ranges[0][0] / project.duration_ms * 100}%`, width: `${(c.ranges.at(-1)![1] - c.ranges[0][0]) / project.duration_ms * 100}%`, top: (i % 3) * 4 }} onClick={() => { setSelected(i); seek(c.ranges[0][0]) }} />)}</div>
          <div className="editor-track" onPointerDown={(e) => { if (e.target === e.currentTarget) seek(viewStart + (e.clientX - e.currentTarget.getBoundingClientRect().left) / e.currentTarget.clientWidth * (viewEnd - viewStart)) }}>
            {candidate.ranges.map(([a, b], i) => <div key={i} className="editor-timeline-piece" style={{ left: `${(a - viewStart) / (viewEnd - viewStart) * 100}%`, width: `${(b - a) / (viewEnd - viewStart) * 100}%` }}><button className="editor-trim-handle" aria-label={`Trim start of cut ${i + 1}`} disabled={editingDisabled} title="Drag to trim or extend; arrow keys adjust by 0.1s (Shift: 1s)" onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); change({ ranges: trimRange(candidate.ranges, i, 0, a + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1000 : 100), project.duration_ms) }) } }} onPointerDown={(e) => { video.current?.pause(); dragging.current = true; setDragWindow([viewStart, viewEnd]); trimDrag(e, i, 0, viewStart, viewEnd, project.duration_ms, candidate, edits, selected, setEdits, setUndo, setRedo, () => { dragging.current = false; setDragWindow(null) }) }} /><button className="editor-piece-body" aria-label={`Seek within cut ${i + 1}`} onClick={(e) => {
              // Measure the whole cut, including its handles, so the click lines
              // up with the playhead even when the timeline is zoomed or clipped.
              const rect = e.currentTarget.parentElement!.getBoundingClientRect()
              const target = e.detail === 0 ? a : a + Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * (b - a)
              seek(Math.max(a, Math.min(b - .001, snapFrame(frames, target))))
            }}><Film size={12} /><span>{i + 1}</span></button><button className="editor-trim-handle" aria-label={`Trim end of cut ${i + 1}`} disabled={editingDisabled} title="Drag to trim or extend; arrow keys adjust by 0.1s (Shift: 1s)" onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); change({ ranges: trimRange(candidate.ranges, i, 1, b + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1000 : 100), project.duration_ms) }) } }} onPointerDown={(e) => { video.current?.pause(); dragging.current = true; setDragWindow([viewStart, viewEnd]); trimDrag(e, i, 1, viewStart, viewEnd, project.duration_ms, candidate, edits, selected, setEdits, setUndo, setRedo, () => { dragging.current = false; setDragWindow(null) }) }} /></div>)}
            {candidate.scenes.map((s, i) => i > 0 && s.at_ms >= viewStart && s.at_ms <= viewEnd && <button key={i}
              title={`Layout change at ${clock(s.at_ms)}${editingDisabled ? '' : ` · Drag to move · Arrow keys: ${frames.length ? 'one frame' : '0.1s (scan for frame stepping)'} · Shift: 1s`}`}
              aria-label={`Layout change at ${clock(s.at_ms)}`} className={cn('editor-scene-marker', i === sceneIndex && 'selected', editingDisabled && 'read-only')}
              style={{ left: `${(s.at_ms - viewStart) / (viewEnd - viewStart) * 100}%` }}
              onPointerDown={(e) => startSceneDrag(e, i)} onClick={() => { video.current?.pause(); seek(s.at_ms); setTab('framing') }}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') e.stopPropagation()
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
                e.preventDefault(); e.stopPropagation()
                moveScene(i, e.shiftKey ? s.at_ms + (e.key === 'ArrowLeft' ? -1000 : 1000) : frames.length ? stepFrame(frames, s.at_ms, e.key === 'ArrowLeft' ? -1 : 1) : s.at_ms + (e.key === 'ArrowLeft' ? -100 : 100))
              }} />)}
            {time >= viewStart && time <= viewEnd && <div className="editor-playhead" style={{ left: `${(time - viewStart) / (viewEnd - viewStart) * 100}%` }} />}
          </div>
          {suppressedCaptions.length > 0 && <div className={cn('editor-caption-track', !candidate.captions && 'opacity-40')} aria-label="Caption-free sections">
            {suppressedCaptions.map(([a, b], i) => b > viewStart && a < viewEnd && <button key={i}
              aria-label={`Caption-free section ${i + 1}: ${clock(a)} to ${clock(b)}`} title={`Captions suppressed ${clock(a)} – ${clock(b)}`}
              style={{ left: `${(Math.max(a, viewStart) - viewStart) / (viewEnd - viewStart) * 100}%`, width: `${(Math.min(b, viewEnd) - Math.max(a, viewStart)) / (viewEnd - viewStart) * 100}%` }}
              onClick={() => { seek(a); setTab('captions') }} />)}
          </div>}
          <input aria-label="Fine timeline position" type="range" min={viewStart} max={viewEnd} step="any" value={Math.max(viewStart, Math.min(viewEnd, time))} onChange={(e) => seek(snapFrame(frames, Number(e.target.value)))} className="editor-fine-scrub" />
          <div className="editor-timeline-footer">
            <div className="editor-cut-list">{candidate.ranges.map(([a, b], i) => <div key={i} className="flex items-center gap-2"><span className="text-2xs text-ink-subtle">{i + 1}</span><TimeInput label={`Cut ${i + 1} start`} value={a} disabled={editingDisabled} onChange={(t) => { const ranges = candidate.ranges.map((r) => [...r] as [number, number]); ranges[i][0] = Math.max(i ? ranges[i - 1][1] : 0, Math.min(b - 100, t)); change({ ranges }) }} /><span className="text-ink-subtle">–</span><TimeInput label={`Cut ${i + 1} end`} value={b} disabled={editingDisabled} onChange={(t) => { const ranges = candidate.ranges.map((r) => [...r] as [number, number]); ranges[i][1] = Math.min(i + 1 < ranges.length ? ranges[i + 1][0] : project.duration_ms, Math.max(a + 100, t)); change({ ranges }) }} /><Button variant="ghost" size="sm" aria-label={`Remove cut ${i + 1}`} tooltip="Remove this cut from the clip. The source video is kept; Undo restores the cut." iconOnly icon={<X size={12} />} disabled={candidate.ranges.length === 1 || editingDisabled} onClick={() => change({ ranges: candidate.ranges.filter((_, j) => j !== i) })} /></div>)}</div>
            <div className="editor-timeline-zoom">
              <span className="text-2xs text-ink-subtle">Timeline zoom</span>
              <Select aria-label="Timeline zoom" size="sm" className="w-32" value={Array.isArray(timelineZoom) ? 'playhead' : timelineZoom}
                options={[{ value: 'source', label: 'Full source' }, { value: 'clip', label: 'Clip' }, { value: 'playhead', label: 'Playhead', detail: '±1 second' }]}
                onChange={(value) => setTimelineZoom(value === 'playhead'
                  ? [Math.max(0, time - 1000), Math.min(project.duration_ms, time + 1000)]
                  : value === 'source' ? 'source' : 'clip')} />
            </div>
          </div>
        </div>
      </div>
      <aside className="editor-inspector"><div className="editor-tabs">{(['review', 'framing', 'captions', 'transcript'] as const).map((t) => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)} className={cn(tab === t && 'selected')}>{t === 'review' ? 'Jev' : t[0].toUpperCase() + t.slice(1)}</button>)}</div>
        <div ref={transcriptPanel} className="editor-inspector-body"><label className="editor-label" htmlFor="editor-title">Title</label><textarea id="editor-title" value={candidate.title} maxLength={200} disabled={editingDisabled} rows={2} onChange={(e) => { if (e.target.value.trim()) change({ title: e.target.value }) }} />
          {tab === 'review' && <div className="space-y-3 mt-4"><div className="flex items-center justify-between"><span className={cn('text-xs', current ? candidate.review?.decision === 'passes' ? 'text-success' : 'text-warning' : 'text-ink-muted')}>{!current ? 'Review out of date' : candidate.review?.decision === 'passes' ? 'Checks passed' : 'Consider before baking'}</span><Button size="sm" disabled={editingDisabled} onClick={() => { void run('review') }}>Review again</Button></div><p className="text-2xs text-ink-subtle">{current ? 'Review the questions, then adjust the cut and framing. You decide when the clip is ready.' : 'These results describe an earlier edit. Run Jev again to check your changes.'}</p>{candidate.review?.questions.map((q) => <Question key={q.id} q={q} />)}{!candidate.review && <p>No review is available yet. Run Jev to evaluate this candidate.</p>}{candidate.review?.cuts.map((cut, i) => <div key={i}><p className="editor-label">Removed {clock(cut.interval[0])} – {clock(cut.interval[1])}</p>{cut.questions.map((q) => <Question key={q.id} q={q} />)}</div>)}</div>}
          {tab === 'framing' && <fieldset disabled={editingDisabled} className="space-y-4 mt-4"><div className="editor-layouts">{(['fill', 'split', 'fit'] as const).map((l) => <button key={l} className={cn(currentScene.layout === l && 'selected')} onClick={() => setLayout(l)}>{l === 'fill' ? 'Full frame' : l === 'split' ? 'Split' : 'Fit'}</button>)}</div>{currentScene.layout === 'split' && <div className="flex gap-2">{['Top', 'Bottom'].map((name, i) => <Button key={i} size="sm" variant={panel === i ? 'primary' : 'secondary'} onClick={() => setPanel(i)}>{name}</Button>)}</div>}{currentScene.layout !== 'fit' && <><label className="editor-label">Zoom<input aria-label="Crop zoom" type="range" min={1} max={4} step={.02} value={Math.min(4, defaultCrop(project.width, project.height, aspect * currentScene.crops.length)[2] / crop[2])} onChange={(e) => cropChange(defaultCrop(project.width, project.height, aspect * currentScene.crops.length, crop[0] + crop[2] / 2, crop[1] + crop[3] / 2, Number(e.target.value)))} /></label>{([0, 1] as const).map((axis) => <label key={axis} className="editor-label">{axis === 0 ? 'Horizontal' : 'Vertical'}<input type="range" aria-label={axis === 0 ? 'Horizontal crop position' : 'Vertical crop position'} min={0} max={Math.max(0, 1 - crop[axis + 2])} step={.001} value={crop[axis]} onChange={(e) => { const c = [...crop] as Crop; c[axis] = Number(e.target.value); cropChange(c) }} /></label>)}</>}{sceneIndex > 0 && <div className="editor-motion"><label className="flex items-center justify-between gap-2 text-xs"><span>Smooth movement</span><input type="checkbox" aria-label="Smooth movement" checked={!!currentScene.transition_ms} disabled={!canAnimate || editingDisabled} onChange={(e) => sceneChange({ transition_ms: e.target.checked ? 600 : undefined })} /></label>{canAnimate && currentScene.transition_ms ? <label className="editor-label mt-3">Duration <span className="float-right">{(currentScene.transition_ms / 1000).toFixed(1)}s</span><input aria-label="Movement duration" type="range" min={100} max={5000} step={100} value={currentScene.transition_ms} onChange={(e) => sceneChange({ transition_ms: Number(e.target.value) })} /></label> : !canAnimate ? <p className="text-2xs text-ink-subtle mt-2">Use the same layout as the previous section to animate its crops.</p> : null}{!!currentScene.transition_ms && <Button size="sm" variant="ghost" onClick={() => { seek(Math.max(start, currentScene.at_ms)); void video.current?.play() }}>Preview movement</Button>}</div>}<div className="space-y-2 border-t border-white/10 pt-3"><div className="editor-layout-time">
            {sceneIndex > 0 ? <label className="flex items-center justify-between gap-3 text-xs"><span>Layout starts</span><TimeInput key={sceneIndex} label="Layout start" value={currentScene.at_ms} disabled={editingDisabled} onChange={(t) => moveScene(sceneIndex, t)} /></label>
              : <p className="text-2xs text-ink-muted">Initial layout</p>}
            {sceneIndex > 0 && frames.length > 0 && <div className="flex gap-2 mt-2"><Button size="sm" variant="ghost" disabled={editingDisabled} onClick={() => moveScene(sceneIndex, stepFrame(frames, currentScene.at_ms, -1))}>One frame earlier</Button><Button size="sm" variant="ghost" disabled={editingDisabled} onClick={() => moveScene(sceneIndex, stepFrame(frames, currentScene.at_ms, 1))}>One frame later</Button></div>}
            {sceneIndex + 1 < candidate.scenes.length && <p className="text-2xs text-ink-subtle mt-2">Until {clock(candidate.scenes[sceneIndex + 1].at_ms)}</p>}
          </div><Button size="sm" icon={<Scissors size={13} />} disabled={candidate.scenes.length >= 60 || time <= start || time >= end || candidate.scenes.some((s) => Math.abs(s.at_ms - time) < .01)} onClick={() => newLayout()}>New layout here</Button>{sceneIndex > 0 && <Button size="sm" variant="ghost" onClick={() => change({ scenes: candidate.scenes.filter((_, i) => i !== sceneIndex) })}>Remove layout change</Button>}<Button size="sm" variant="ghost" onClick={() => change({ scenes: [{ ...currentScene, at_ms: 0 }] })}>Use layout for whole clip</Button></div></fieldset>}
          {tab === 'captions' && <fieldset disabled={editingDisabled} className="space-y-4 mt-4"><div className="flex items-center justify-between text-xs"><span>Burn in captions</span><Switch label="Burn in captions" checked={candidate.captions} onChange={(captions) => change({ captions })} /></div><p className="text-2xs text-ink-subtle">Captions follow your final cuts. Use the placement guide in Transcript to position them before baking.</p><CaptionSuppression key={candidate.id} ranges={suppressedCaptions} cuts={candidate.ranges} time={time} duration={project.duration_ms} disabled={editingDisabled || !candidate.captions} onChange={(caption_suppression_ranges) => { video.current?.pause(); change({ caption_suppression_ranges }) }} seek={seek} />{candidate.captions && <CaptionPresetPicker value={candidate.caption_preset} customCaption={candidate.custom_caption} onChange={(caption_preset, custom_caption) => change({ caption_preset, custom_caption })} />}<label className="editor-label">Export speed<select value={candidate.video_speed} onChange={(e) => change({ video_speed: Number(e.target.value) })}>{[1, 1.1, 1.25, 1.5, 1.75, 2].map((n) => <option key={n} value={n}>{n}×</option>)}</select></label></fieldset>}
          {tab === 'transcript' && <section className="editor-subtitle-controls" aria-label="Subtitle placement">
            <div className="flex items-center justify-between gap-2 text-xs"><span>Subtitle placement guide</span><Switch label="Show subtitle guide" checked={showSubtitlePreview} onChange={setShowSubtitlePreview} /></div>
            {!candidate.captions ? <p className="text-2xs text-ink-muted">Subtitles are off for this clip. <button className="underline" disabled={editingDisabled} onClick={() => change({ captions: true })}>Enable subtitles</button></p>
              : <p className="text-2xs text-ink-subtle">Drag “Captions go here” up or down to choose where your subtitles sit. This position applies throughout the clip.</p>}
            <fieldset disabled={editingDisabled || !candidate.captions}>
              <label className="editor-label">Vertical position <span className="float-right">{candidate.caption_y == null ? 'Automatic' : `${Math.round(captionPosition * 100)}% from top`}</span>
                <input aria-label="Subtitle vertical position" type="range" min={10} max={90} step={1} value={Math.max(10, Math.min(90, captionPosition * 100))} onChange={e => moveCaption(Number(e.target.value) / 100)} />
              </label>
              <div className="flex gap-1 flex-wrap">{([['Top', .2], ['Middle', .5], ['Bottom', .8]] as const).map(([label, y]) => <Button key={label} variant="ghost" size="sm" onClick={() => moveCaption(y)}>{label}</Button>)}
                <Button variant="ghost" size="sm" disabled={candidate.caption_y == null} onClick={() => change({ caption_y: null })}>Automatic</Button></div>
            </fieldset>
          </section>}
          {tab === 'transcript' && <div className="editor-transcript"><p className="text-2xs text-ink-subtle">Caption edits apply to this clip.</p>{project.transcript.map((r, i) => {
            const nearClip = r.end_ms >= start - 15000 && r.start_ms <= end + 15000
            const nearPlayhead = r.end_ms >= time - 15000 && r.start_ms <= time + 15000
            if (!nearClip && !nearPlayhead && editingCaption !== i) return null
            const edited = candidate.caption_edits?.some((e) => e.segment === i)
            return <div key={i} ref={r === activeTranscript ? activeCaption : undefined} aria-current={r === activeTranscript ? 'true' : undefined}
              className={cn('editor-transcript-row', r === activeTranscript && 'selected')}>
              <div className="editor-transcript-time"><button onClick={() => seek(r.start_ms)} title="Playhead to this line">{formatTimecode(r.start_ms)}</button>{edited && <span>Edited</span>}
                <Button variant="ghost" size="sm" iconOnly icon={<Pencil size={12} />} aria-label={`Edit caption at ${clock(r.start_ms)}`} tooltip="Correct this caption’s text for the selected clip." disabled={!canEditCaption(i)} onClick={() => editCaption(i)} />
              </div>
              {editingCaption === i ? <><textarea ref={captionInput} aria-label={`Caption at ${clock(r.start_ms)}`} maxLength={2000} rows={3} value={captionText(i)} disabled={editingDisabled}
                onChange={(e) => { updateCaption(i, e.target.value, firstCaptionChange.current); firstCaptionChange.current = false }}
                onKeyDown={(e) => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); setEditingCaption(null) } }} />
                <div className="flex items-center justify-between mt-2"><Button size="sm" variant="ghost" disabled={editingDisabled || !edited} onClick={() => updateCaption(i, r.text)}>Reset text</Button><Button size="sm" onClick={() => setEditingCaption(null)}>Done</Button></div></>
                : <button className="editor-transcript-text" onClick={() => seek(r.start_ms)}>{captionText(i).trim() || <em>Caption hidden</em>}</button>}
            </div>
          })}{!project.transcript.length && <p>No spoken transcript is available for this source.</p>}</div>}

        </div>
      </aside>
    </div>
    {showAudit && <EditInspector outputDir={outputDir} onClose={() => setShowAudit(false)} />}
  </section>
}
function CaptionSuppression({ ranges, cuts, time, duration, disabled, onChange, seek }: {
  ranges: EditorRange[]; cuts: EditorRange[]; time: number; duration: number; disabled: boolean
  onChange: (ranges: EditorRange[]) => void; seek: (t: number) => void
}): React.JSX.Element {
  const at = Math.round(time)
  const nextRange = nextCaptionRange(ranges, cuts, at)
  const canAdd = !disabled && nextRange !== null
  const update = (i: number, edge: 0 | 1, value: number): void => onChange(trimRange(ranges, i, edge, value, duration))
  return <section className="space-y-3 border-t border-white/10 pt-3" aria-label="Caption suppression">
    <h3 className="text-xs font-medium">Caption-free sections{ranges.length > 0 && <span className="ml-2 text-ink-subtle">{ranges.length}</span>}</h3>
    <p className="text-2xs text-ink-subtle">Already captioned in the source? Suppress our captions during those sections. Video, audio and source captions stay intact. Times refer to the source video.</p>
    <Button size="sm" disabled={!canAdd} onClick={() => {
      if (!nextRange) return
      onChange([...ranges, nextRange].sort((a, b) => a[0] - b[0])); seek(nextRange[0])
    }}>{ranges.length ? 'Add another section' : 'Suppress captions here'}</Button>
    {ranges.length > 0 && <p className="text-2xs text-ink-subtle">{!nextRange ? ranges.length >= 200 ? 'Section limit reached. Remove a section to add another.' : 'Captions are suppressed throughout the selected footage. Shorten or remove a section to make room.' : 'Add as many sections as you need. Each has its own start and end. New sections start at the playhead or the next available spot in this clip.'}</p>}
    {!ranges.length && <p className="text-2xs text-ink-subtle">Seek to a section, add a range, then adjust its start and end.</p>}
    {ranges.map(([a, b], i) => <div key={i} className="editor-caption-range">
      <div className="flex items-center justify-between gap-2"><button className="text-2xs text-ink-muted" onClick={() => seek(a)}>Section {i + 1}</button><Button size="sm" variant="ghost" iconOnly icon={<X size={12} />} tooltip="Restore captions in this section by removing its suppression range." aria-label={`Remove caption-free section ${i + 1}`} disabled={disabled} onClick={() => onChange(ranges.filter((_, j) => j !== i))} /></div>
      <div className="flex flex-wrap items-end gap-2">{([0, 1] as const).map((edge) => <label key={edge} className="text-2xs text-ink-subtle">{edge === 0 ? 'Start' : 'End'}<TimeInput label={`Caption-free section ${i + 1} ${edge === 0 ? 'start' : 'end'}`} value={edge === 0 ? a : b} disabled={disabled} onChange={(t) => update(i, edge, t)} /></label>)}</div>
      <div className="flex flex-wrap gap-2 mt-2"><Button size="sm" variant="ghost" disabled={disabled || at < (ranges[i - 1]?.[1] ?? 0) || at > b - 100} onClick={() => update(i, 0, at)}>Start at playhead</Button><Button size="sm" variant="ghost" disabled={disabled || at < a + 100 || at > (ranges[i + 1]?.[0] ?? duration)} onClick={() => update(i, 1, at)}>End at playhead</Button></div>
    </div>)}
  </section>
}
function TimeInput({ label, value, disabled, onChange }: { label: string; value: number; disabled: boolean; onChange: (v: number) => void }): React.JSX.Element {
  const [text, setText] = useState(clock(value))
  useEffect(() => setText(clock(value)), [value])
  const commit = (): void => {
    if (text === clock(value)) return
    const n = parseTimecode(text)
    setText(clock(value))
    if (n !== null && Number.isFinite(n)) onChange(n * 1000)
  }
  return <input className="editor-time-input" aria-label={label} value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
}
function trimDrag(e: React.PointerEvent<HTMLButtonElement>, index: number, edge: 0 | 1, viewStart: number, viewEnd: number, duration: number, c: EditorCandidate, edits: EditorCandidate[], selected: number, setEdits: React.Dispatch<React.SetStateAction<EditorCandidate[]>>, setUndo: React.Dispatch<React.SetStateAction<EditorCandidate[][]>>, setRedo: React.Dispatch<React.SetStateAction<EditorCandidate[][]>>, onDone: () => void): void {
  e.preventDefault(); e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId)
  const target = e.currentTarget, bounds = target.parentElement!.parentElement!.getBoundingClientRect(), pointerStart = e.clientX
  setUndo((u) => [...u.slice(-49), edits]); setRedo([])
  const move = (event: PointerEvent): void => {
    const t = c.ranges[index][edge] + (event.clientX - pointerStart) / bounds.width * (viewEnd - viewStart)
    const ranges = trimRange(c.ranges, index, edge, t, duration)
    setEdits((items) => items.map((item, i) => i === selected ? refineEdit(item, { ranges }) : item))
  }
  const done = (): void => { target.removeEventListener('pointermove', move); target.removeEventListener('lostpointercapture', done); onDone() }
  target.addEventListener('pointermove', move); target.addEventListener('lostpointercapture', done)
}
