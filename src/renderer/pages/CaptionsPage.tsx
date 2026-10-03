import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check, Copy, Pencil, Plus, Save, Trash2 } from 'lucide-react'
import { CAPTION_FONTS, defaultCaptionStyle, parseCustomCaption, type CaptionStyleSettings, type CustomCaptionPreset } from '../../shared/custom-captions'
import { DEFAULT_CAPTION_PRESET, isCaptionPresetId, type CaptionPresetId } from '../../shared/caption-presets'
import { PRESETS, CaptionMotionPreview, CaptionSample, CaptionStyleTile, captionPreviewPreset } from '../components/CaptionPresetPicker'
import type { Page as PageId } from '../components/Sidebar'
import { Button } from '../components/ui/Button'
import { Callout } from '../components/ui/Callout'
import { Dialog, DialogFooter } from '../components/ui/Dialog'
import { TextInput } from '../components/ui/Field'
import { Page } from '../components/ui/Page'
import { PageHeader } from '../components/ui/PageHeader'
import { Panel } from '../components/ui/Panel'
import { Select } from '../components/ui/Select'
import { Switch } from '../components/ui/Switch'
import { useCaptionStore } from '../store/use-caption-store'
import { useDraftStore } from '../store/use-draft-store'
import { errorMessage } from '../lib/utils'
import { getApi } from '../lib/ipc'
import { registerNavigationCommit } from '../lib/navigation'
import './captions.css'

export function CaptionsPage({ onNavigate }: { onNavigate: (page: PageId) => void }): React.JSX.Element {
  const { styles, editing, selectedBaseId: baseId, view, fromWizard, loaded, loading, error: loadError, load, save, remove } = useCaptionStore()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<CustomCaptionPreset | null>(null)
  const [pendingSwitch, setPendingSwitch] = useState<{ proceed: () => void; cancel?: () => void } | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const previousStage = useRef<string | null>(null)
  const existing = styles.find(style => style.id === editing?.id)
  const dirty = editing !== null && JSON.stringify(existing) !== JSON.stringify(editing)
  const stage = view === 'home' ? styles.length ? 'home' : 'base' : view === 'edit' && editing ? 'edit' : 'base'
  const creating = stage === 'base' || stage === 'edit' && !existing
  const preview = captionPreviewPreset(baseId, stage === 'edit' ? editing ?? undefined : undefined)

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!loaded) return
    if (previousStage.current !== null && previousStage.current !== stage) heading.current?.focus()
    previousStage.current = stage
  }, [stage, loaded])
  useEffect(() => () => {
    const lab = useCaptionStore.getState()
    const original = lab.styles.find(style => style.id === lab.editing?.id)
    if (lab.view === 'edit' && lab.editing && JSON.stringify(lab.editing) === JSON.stringify(original)) {
      useCaptionStore.setState({ view: 'home', editing: null })
    }
  }, [])

  const setEditing = (value: CustomCaptionPreset | null): void => {
    useCaptionStore.setState({ editing: value }); setSaved(false); setError(null); setDeleteTarget(null)
  }
  const switchStyle = (next: () => void): void => {
    if (dirty) { setError(null); setPendingSwitch({ proceed: next }) }
    else next()
  }
  const showHome = (): void => {
    setEditing(null)
    useCaptionStore.setState({ view: 'home' })
  }
  const makeDraft = (id: string, source?: CustomCaptionPreset): CustomCaptionPreset => {
    const baseName = source ? `${source.name} copy` : `${PRESETS.find(preset => preset.id === id)?.name ?? 'Pop'} remix`
    let name = baseName.slice(0, 44), n = 2
    while (styles.some(style => style.name.toLowerCase() === name.toLowerCase())) name = `${baseName.slice(0, 40)} ${n++}`
    return { id: `custom-${crypto.randomUUID()}`, name, baseId: id, style: source ? { ...source.style } : defaultCaptionStyle(isCaptionPresetId(id) ? id : DEFAULT_CAPTION_PRESET) }
  }
  const beginEdit = (style: CustomCaptionPreset): void => {
    setEditing(structuredClone(style))
    useCaptionStore.setState({ selectedBaseId: isCaptionPresetId(style.baseId) ? style.baseId : DEFAULT_CAPTION_PRESET, view: 'edit' })
  }
  const chooseBase = (id: CaptionPresetId): void => {
    if (id === baseId) return
    switchStyle(() => {
      setEditing(null)
      useCaptionStore.setState({ selectedBaseId: id, view: 'base' })
    })
  }
  const customize = (): void => {
    if (editing?.baseId === baseId && !existing) useCaptionStore.setState({ view: 'edit' })
    else beginEdit(makeDraft(baseId))
  }
  const update = (patch: Partial<CaptionStyleSettings>): void => {
    if (editing) setEditing({ ...editing, style: { ...editing.style, ...patch } })
  }
  const apply = (style: CustomCaptionPreset): void => {
    useDraftStore.getState().update({ captionPreset: style.baseId, customCaption: structuredClone(style), includeCaptions: true })
    useDraftStore.getState().setStep('captions')
    useCaptionStore.setState({ fromWizard: false, view: 'home', editing: null })
    onNavigate('clip')
  }
  const persist = async (useInWizard: boolean): Promise<boolean> => {
    if (!editing || busy) return false
    setBusy(true); setError(null)
    try {
      const style = parseCustomCaption(editing)
      await save(style)
      if (useInWizard) apply(style)
      else { setEditing(style); setSaved(true) }
      return true
    } catch (err) { setError(errorMessage(err, 'Could not save this preset.')); return false }
    finally { setBusy(false) }
  }
  const deleteStyle = async (): Promise<void> => {
    if (!deleteTarget || busy) return
    setBusy(true); setError(null)
    try {
      await remove(deleteTarget.id)
      useCaptionStore.setState({ selectedBaseId: isCaptionPresetId(deleteTarget.baseId) ? deleteTarget.baseId : DEFAULT_CAPTION_PRESET })
      showHome()
      requestAnimationFrame(() => heading.current?.focus())
    } catch (err) { setError(errorMessage(err, 'Could not delete this preset.')) }
    finally { setBusy(false) }
  }
  useEffect(() => registerNavigationCommit(() => {
    const lab = useCaptionStore.getState()
    if (!lab.editing || JSON.stringify(lab.editing) === JSON.stringify(lab.styles.find(style => style.id === lab.editing?.id))) return Promise.resolve(true)
    return new Promise<boolean>(resolve => {
      setError(null)
      setPendingSwitch({ proceed: () => { showHome(); resolve(true) }, cancel: () => resolve(false) })
    })
  }), [])
  const persistRef = useRef(persist)
  persistRef.current = persist
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent): void => {
      const lab = useCaptionStore.getState()
      if (lab.editing && JSON.stringify(lab.editing) !== JSON.stringify(lab.styles.find(style => style.id === lab.editing?.id))) event.preventDefault()
    }
    window.addEventListener('beforeunload', prevent)
    const saveBeforeClose = getApi().editor.onSaveBeforeClose(() => {
      void persistRef.current(false).then(saved => getApi().editor.closeReady(saved)).catch(() => {})
    })
    const discardBeforeClose = getApi().editor.onDiscardBeforeClose(() => {
      useCaptionStore.setState({ editing: null, view: 'home' })
      void getApi().editor.closeReady(true)
    })
    return () => { window.removeEventListener('beforeunload', prevent); saveBeforeClose(); discardBeforeClose() }
  }, [])
  const finishSwitch = (): void => { pendingSwitch?.proceed(); setPendingSwitch(null) }
  const cancelSwitch = (): void => { if (!busy) { pendingSwitch?.cancel?.(); setPendingSwitch(null); setError(null) } }
  const backToBase = (): void => useCaptionStore.setState({ view: 'base' })
  const backToPresets = (): void => switchStyle(showHome)

  return <Page width="default" className="caption-lab">
    <PageHeader eyebrow="Studio" title="Captions" description="Create a signature look."
      actions={<>
        {fromWizard && <Button icon={<ArrowLeft size={14} />} onClick={() => switchStyle(() => { showHome(); useCaptionStore.setState({ fromWizard: false }); onNavigate('clip') })}>Back to Create</Button>}
        {loaded && stage === 'home' && <Button variant="primary" icon={<Plus size={14} />} disabled={busy} onClick={() => switchStyle(() => { setEditing(null); useCaptionStore.setState({ view: 'base' }) })}>New preset</Button>}
      </>} />
    {(error || loadError) && <Callout tone="danger" className="mt-3" action={loadError ? <Button size="sm" onClick={() => void load()}>Retry</Button> : undefined}>{error ?? loadError}</Callout>}
    {!loaded && <Panel className="mt-4"><p role="status" className="text-xs text-ink-muted">{loading ? 'Loading presets…' : 'Your presets are unavailable.'}</p></Panel>}
    {loaded && <>
      <div className="caption-stage-header mt-4">
        <div className="flex min-w-0 items-center gap-3">
          {stage !== 'home' && (styles.length > 0 || stage === 'edit') && <Button variant="ghost" icon={<ArrowLeft size={14} />} disabled={busy} onClick={stage === 'edit' && !existing ? backToBase : backToPresets}>{stage === 'edit' && !existing ? 'Back to base' : 'Back to presets'}</Button>}
          <h2 ref={heading} tabIndex={-1} className="caption-stage-heading text-base font-semibold">{stage === 'home' ? 'Your presets' : stage === 'base' ? 'Choose a base' : existing ? 'Edit preset' : 'Customize preset'}</h2>
          {stage === 'home' && <span className="font-mono text-2xs text-ink-subtle">{styles.length}</span>}
        </div>
        {creating && <nav aria-label="Caption preset steps" className="caption-creation-steps">
          <button type="button" aria-current={stage === 'base' ? 'step' : undefined} disabled={busy} onClick={backToBase} className={stage === 'base' ? 'is-current' : ''}><span>{stage === 'edit' ? <Check size={12} /> : '1'}</span>Choose base</button>
          <span aria-hidden="true" className="caption-step-line" />
          <button type="button" aria-current={stage === 'edit' ? 'step' : undefined} disabled={busy || !editing} onClick={customize} className={stage === 'edit' ? 'is-current' : ''}><span>2</span>Customize</button>
        </nav>}
        {stage === 'home' && saved && <span role="status" className="flex items-center gap-1 text-xs text-success"><Check size={13} />Saved</span>}
      </div>
      {stage === 'home' && <Panel padded={false} className="caption-preset-library mt-3 overflow-hidden">
        <table aria-label="Your caption presets" className="caption-preset-table">
          <thead><tr><th scope="col">Preset</th><th scope="col" className="caption-preset-font">Typeface</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{styles.map(style => <tr key={style.id} aria-label={style.name}>
            <td><button type="button" className="caption-preset-name" onClick={() => beginEdit(style)} disabled={busy} aria-label={`Open ${style.name}`}>
              <span className="caption-preset-sample" aria-hidden="true"><CaptionSample preset={captionPreviewPreset(style.baseId, style)} /></span>
              <span className="min-w-0 truncate font-medium text-ink">{style.name}</span>
            </button></td>
            <td className="caption-preset-font text-ink-muted">{style.style.font_name}</td>
            <td><div className="caption-preset-actions">
              {fromWizard && <Button size="sm" variant="primary" aria-label={`Use ${style.name}`} disabled={busy} onClick={() => apply(style)}>Use preset</Button>}
              <Button size="sm" variant="ghost" iconOnly aria-label={`Edit ${style.name}`} tooltip="Edit preset" icon={<Pencil size={14} />} disabled={busy} onClick={() => beginEdit(style)} />
              <Button size="sm" variant="ghost" iconOnly aria-label={`Duplicate ${style.name}`} tooltip="Duplicate preset" icon={<Copy size={14} />} disabled={busy} onClick={() => beginEdit(makeDraft(style.baseId, style))} />
              <Button size="sm" variant="ghost" iconOnly aria-label={`Delete ${style.name}`} tooltip="Delete preset" icon={<Trash2 size={14} />} disabled={busy} onClick={() => { setError(null); setDeleteTarget(style) }} />
            </div></td>
          </tr>)}</tbody>
        </table>
      </Panel>}
      {stage === 'base' && <div className="caption-base-layout mt-3 animate-fade-in">
        <Panel>
          <div className="mb-3 flex items-center justify-between"><h3 className="eyebrow">Default presets</h3><span className="text-2xs text-ink-subtle">{PRESETS.length} looks</span></div>
          <div className="caption-base-grid" role="radiogroup" aria-label="Default styles">{PRESETS.map(preset => <CaptionStyleTile key={preset.id} preset={preset} selected={baseId === preset.id} disabled={busy} tabIndex={baseId === preset.id ? 0 : -1} onClick={() => chooseBase(preset.id as CaptionPresetId)} />)}</div>
        </Panel>
        <Panel className="caption-lab-preview caption-base-preview">
          <div className="mb-3 flex items-center justify-between gap-3"><div className="min-w-0"><p className="eyebrow">Your starting point</p><h3 className="mt-1 truncate text-lg font-semibold">{preview.name}</h3></div></div>
          <CaptionMotionPreview key={baseId} preset={preview} labControls />
          <div className="mt-3 flex items-center justify-between gap-3"><p className="text-xs text-ink-muted">{preview.description}</p><Button variant="primary" icon={<ArrowRight size={14} />} disabled={busy} onClick={customize}>Customize</Button></div>
        </Panel>
      </div>}
      {stage === 'edit' && editing && <div className="caption-editor-layout mt-3 animate-fade-in">
        <Panel className="caption-lab-preview caption-editor-preview">
          <div className="caption-editor-preview-heading mb-3 flex items-center justify-between gap-3"><h3 className="min-w-0 truncate text-lg font-semibold">{preview.name || 'Untitled preset'}</h3></div>
          <CaptionMotionPreview key={editing.id} preset={preview} labControls />
        </Panel>
        <Panel className="caption-lab-controls">
          <fieldset disabled={busy} className="space-y-4">
            <div className="flex items-end gap-2"><LabField label="Style name" className="min-w-0 flex-1"><TextInput aria-label="Style name" value={editing.name} maxLength={48} onChange={e => setEditing({ ...editing, name: e.target.value })} /></LabField>
              <Button iconOnly aria-label="Duplicate style" tooltip="Save a separate copy" icon={<Copy size={14} />} onClick={() => beginEdit(makeDraft(editing.baseId, editing))} /></div>
            <div className="grid grid-cols-2 gap-3">
              <LabField label="Typeface"><Select aria-label="Typeface" value={editing.style.font_name} options={CAPTION_FONTS.map(font => ({ value: font, label: font }))} onChange={font_name => update({ font_name, italic: font_name === 'Instrument Serif Italic' })} /></LabField>
              <LabField label="Animation"><Select aria-label="Animation" value={editing.style.karaoke_fill ? 'karaoke' : editing.style.entrance_pop && editing.style.color_transition ? 'pop-fade' : editing.style.entrance_pop ? 'pop' : editing.style.color_transition ? 'fade' : 'none'} options={[{ value: 'pop', label: 'Pop in' }, { value: 'pop-fade', label: 'Pop & fade' }, { value: 'karaoke', label: 'Karaoke sweep' }, { value: 'fade', label: 'Color fade' }, { value: 'none', label: 'Clean switch' }]} onChange={animation => update({ entrance_pop: animation === 'pop' || animation === 'pop-fade', karaoke_fill: animation === 'karaoke', color_transition: animation === 'fade' || animation === 'pop-fade' })} /></LabField>
            </div>
            <div className="grid grid-cols-3 gap-3"><LabRange label="Font size" value={editing.style.font_size} min={40} max={160} onChange={font_size => update({ font_size })} /><LabRange label="Words at once" value={editing.style.max_words_per_line} min={1} max={6} onChange={max_words_per_line => update({ max_words_per_line })} /><LabField label="Lines"><Select aria-label="Lines" value={editing.style.max_lines == null ? 'auto' : String(editing.style.max_lines)} options={[{ value: 'auto', label: 'Auto' }, { value: '1', label: '1 line' }, { value: '2', label: '2 lines' }, { value: '3', label: '3 lines' }]} onChange={value => update({ max_lines: value === 'auto' ? null : Number(value) })} /></LabField></div>
            <div className="grid grid-cols-2 gap-3"><ColorField label="Text color" value={editing.style.primary_color} onChange={primary_color => update({ primary_color })} /><ColorField label="Highlight color" value={editing.style.highlight_color} onChange={highlight_color => update({ highlight_color })} /></div>
            <div className="grid grid-cols-2 items-center gap-3"><LabField label="Upcoming words"><Select aria-label="Upcoming words" value={editing.style.future_words} options={[{ value: 'show', label: 'Show' }, { value: 'dim', label: 'Dim' }, { value: 'hide', label: 'Reveal as spoken' }]} onChange={future_words => update({ future_words: future_words as CaptionStyleSettings['future_words'] })} /></LabField><div className="flex items-center justify-between pt-5 text-xs"><span>All caps</span><Switch label="All caps" checked={editing.style.uppercase} onChange={uppercase => update({ uppercase })} /></div></div>
            {editing.style.future_words === 'dim' && <LabRange label="Upcoming opacity" min={0} max={100} value={Math.round(editing.style.dim_opacity * 100)} suffix="%" onChange={value => update({ dim_opacity: value / 100 })} />}
            <div className="border-t border-white/[0.06] pt-4"><p className="eyebrow mb-3">Finish</p><div className="grid grid-cols-2 gap-3"><ColorField label="Outline color" value={editing.style.outline_color} onChange={outline_color => update({ outline_color })} /><LabRange label="Outline width" min={0} max={12} value={editing.style.outline_width} onChange={outline_width => update({ outline_width })} /></div>
              <div className="caption-lab-effects mt-3"><EffectColor label="Word pill" value={editing.style.highlight_box_color} disabled={editing.style.karaoke_fill} fallback="#7C5CFF" onChange={highlight_box_color => update({ highlight_box_color })} /><EffectColor label="Glow" value={editing.style.glow_color} fallback="#38CCFF" onChange={glow_color => update({ glow_color })} /><EffectColor label="Background" value={editing.style.line_box_color} fallback="#000000" onChange={line_box_color => update({ line_box_color })} /></div>
              {editing.style.line_box_color && <div className="mt-3 grid grid-cols-2 gap-3"><LabRange label="Background padding" min={0} max={40} value={editing.style.line_box_padding} onChange={line_box_padding => update({ line_box_padding })} /><LabRange label="Background opacity" min={0} max={100} value={Math.round(editing.style.line_box_opacity * 100)} suffix="%" onChange={value => update({ line_box_opacity: value / 100 })} /></div>}
            </div>
          </fieldset>
          <div className="caption-lab-save mt-4 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3">
            <span role="status" className="mr-auto text-2xs text-ink-subtle">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
            <Button variant={fromWizard ? 'secondary' : 'primary'} icon={<Save size={14} />} disabled={busy || !editing.name.trim() || !dirty} loading={busy} onClick={() => void persist(false)}>Save preset</Button>
            {fromWizard && <Button variant="primary" disabled={busy || !editing.name.trim()} onClick={() => { if (dirty) void persist(true); else apply(editing) }}>{dirty ? 'Save & use' : 'Use preset'}</Button>}
          </div>
        </Panel>
      </div>}
    </>}
    {pendingSwitch && <DiscardChangesDialog busy={busy} error={error} canSave={Boolean(editing?.name.trim())} onCancel={cancelSwitch} onDiscard={finishSwitch} onSave={() => { void persist(false).then(ok => { if (ok) finishSwitch() }) }} />}
    {deleteTarget && <DeletePresetDialog preset={deleteTarget} busy={busy} error={error} onCancel={() => { if (!busy) { setDeleteTarget(null); setError(null) } }} onDelete={() => void deleteStyle()} />}
  </Page>
}

function LabField({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }): React.JSX.Element {
  return <div className={className}><p className="mb-1.5 text-xs text-ink-muted">{label}</p>{children}</div>
}
function LabRange({ label, value, min, max, suffix = '', onChange }: { label: string; value: number; min: number; max: number; suffix?: string; onChange: (value: number) => void }): React.JSX.Element {
  return <label className="block"><span className="mb-2 flex items-center justify-between text-xs text-ink-muted">{label}<span className="font-mono text-ink">{value}{suffix}</span></span><input className="w-full accent-accent" type="range" aria-label={label} min={min} max={max} step={1} value={value} onChange={e => onChange(Number(e.target.value))} /></label>
}
function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }): React.JSX.Element {
  return <label className="block"><span className="mb-1.5 block text-xs text-ink-muted">{label}</span><span className="glass-well flex h-8 items-center gap-2 rounded-lg px-2"><input type="color" aria-label={label} value={value} onChange={e => onChange(e.target.value.toUpperCase())} className="caption-color" /><span className="font-mono text-2xs text-ink-muted">{value.toUpperCase()}</span></span></label>
}
function EffectColor({ label, value, fallback, onChange, disabled }: { label: string; value: string | null; fallback: string; onChange: (value: string | null) => void; disabled?: boolean }): React.JSX.Element {
  return <div className={`glass-tile rounded-xl p-2.5${disabled ? ' opacity-40' : ''}`} title={disabled ? 'Word pills are unavailable with karaoke sweep' : undefined}><div className="flex items-center justify-between gap-2"><span className="text-xs text-ink-muted">{label}</span><Switch label={label} disabled={disabled} checked={value !== null && !disabled} onChange={on => onChange(on ? fallback : null)} /></div>{value && !disabled && <label className="mt-2 flex items-center gap-2"><input type="color" aria-label={`${label} color`} className="caption-color" value={value} onChange={e => onChange(e.target.value.toUpperCase())} /><span className="font-mono text-2xs text-ink-subtle">{value.toUpperCase()}</span></label>}</div>
}

function DeletePresetDialog({ preset, busy, error, onCancel, onDelete }: { preset: CustomCaptionPreset; busy: boolean; error: string | null; onCancel: () => void; onDelete: () => void }): React.JSX.Element {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => previous?.focus({ preventScroll: true })
  }, [])
  return <Dialog ref={panel} aria-labelledby="caption-delete-title" aria-describedby="caption-delete-description" panelClassName="max-w-md" onBackdropMouseDown={onCancel}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
      if (event.key !== 'Tab') return
      const buttons = panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
      const first = buttons?.[0], last = buttons?.[buttons.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }}>
    <div className="p-4"><h2 id="caption-delete-title" className="text-base font-semibold">Delete preset?</h2><p id="caption-delete-description" className="mt-1 text-xs text-ink-muted">Remove “{preset.name}”? Existing clips keep their look.</p>{error && <Callout tone="danger" className="mt-3">{error}</Callout>}</div>
    <DialogFooter><Button disabled={busy} onClick={onCancel}>Keep preset</Button><Button variant="danger" loading={busy} disabled={busy} onClick={onDelete}>Delete preset</Button></DialogFooter>
  </Dialog>
}

function DiscardChangesDialog({ onCancel, onDiscard, onSave, busy, canSave, error }: { onCancel: () => void; onDiscard: () => void; onSave: () => void; busy: boolean; canSave: boolean; error: string | null }): React.JSX.Element {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => previous?.focus({ preventScroll: true })
  }, [])
  return <Dialog ref={panel} aria-labelledby="caption-discard-title" aria-describedby="caption-discard-description" panelClassName="max-w-md" onBackdropMouseDown={onCancel}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
      if (event.key !== 'Tab') return
      const buttons = panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
      const first = buttons?.[0], last = buttons?.[buttons.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }}>
    <div className="p-4"><h2 id="caption-discard-title" className="text-base font-semibold">Save changes before leaving?</h2><p id="caption-discard-description" className="mt-1 text-xs text-ink-muted">Your preset has unsaved changes.</p>{error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}</div>
    <DialogFooter className="flex-wrap"><Button disabled={busy} onClick={onCancel}>Keep editing</Button><Button disabled={busy} variant="ghost" onClick={onDiscard}>Discard</Button><Button disabled={busy || !canSave} loading={busy} variant="primary" onClick={onSave}>Save & leave</Button></DialogFooter>
  </Dialog>
}
