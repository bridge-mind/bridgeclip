import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, Check, Clapperboard, Folder, HardDrive, RefreshCw } from 'lucide-react'
import type { StorageCleanupKind, StorageCleanupPreview, StorageCleanupResult } from '../../shared/output-storage'
import { getApi } from '../lib/ipc'
import { cn, errorMessage, formatBytes } from '../lib/utils'
import { Button } from './ui/Button'
import { Dialog, DialogFooter } from './ui/Dialog'

export function StorageCleanupDialog({ kind, onClose, onCleaned }: { kind: StorageCleanupKind; onClose: () => void; onCleaned: (result: StorageCleanupResult) => void }): React.JSX.Element {
  const titleId = useId(), panel = useRef<HTMLDivElement>(null), cancel = useRef<HTMLButtonElement>(null)
  const [preview, setPreview] = useState<StorageCleanupPreview | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const close = useCallback(() => { if (!busy) onClose() }, [busy, onClose])
  const sources = kind === 'sources'

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancel.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key !== 'Tab') return
      const controls = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')
      if (!controls?.length) { event.preventDefault(); return }
      const first = controls[0], last = controls[controls.length - 1]
      if (!panel.current?.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); previous?.focus() }
  }, [close])

  useEffect(() => {
    let cancelled = false
    setPreview(null); setSelected([]); setError(null)
    void (async () => {
      try {
        const result = await getApi().settings.previewCleanup(kind)
        if (cancelled) return
        setPreview(result)
        setSelected(result.items.filter(item => !item.keepReason).map(item => item.id))
      } catch (error) { if (!cancelled) setError(errorMessage(error)) }
    })()
    return () => { cancelled = true }
  }, [kind, attempt])

  const clean = async (): Promise<void> => {
    if (!preview || !selected.length || busy) return
    setBusy(true); setError(null)
    try { onCleaned(await getApi().settings.cleanContent(preview.token, selected)) }
    catch (error) { setError(errorMessage(error)); setBusy(false) }
  }
  const items = preview?.items.filter(item => selected.includes(item.id)) ?? []
  const bytes = items.reduce((sum, item) => sum + item.bytes, 0)
  const clips = items.reduce((sum, item) => sum + item.clipCount, 0)
  const folders = items.filter(item => item.kind === 'run').length
  const eligible = preview?.items.filter(item => !item.keepReason) ?? []
  const partial = items.some(item => item.partial)

  return <Dialog ref={panel} role="alertdialog" aria-labelledby={titleId} onBackdropMouseDown={close} panelClassName="max-w-[540px]">
    <div className="min-h-0 overflow-y-auto p-5">
      <h2 id={titleId} className="text-base font-semibold text-ink">{sources ? 'Free source media?' : 'Clean published content?'}</h2>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">{sources ? 'Keep your exports. Finished projects become read-only.' : 'Remove local copies of clips already posted. Online posts stay.'}</p>
      {!preview && !error && <p role="status" className="py-10 text-center text-sm text-ink-muted">Checking your Library…</p>}
      {error && <div role="alert" className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-danger/10 p-3 text-xs text-danger"><span>{error}</span><Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={() => setAttempt(value => value + 1)}>Refresh</Button></div>}
      {preview && <div className="mt-4 space-y-4">
        <div className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.04] p-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><HardDrive size={20} /></span>
          <div role="status" aria-label="Cleanup space estimate"><p className="text-xs text-ink-muted">Estimated space freed</p><p className="mt-0.5 text-2xl font-semibold tabular-nums text-ink">{partial && 'At least '}{formatBytes(bytes)}</p></div>
        </div>
        {eligible.length > 0 && <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-ink-muted">
          <span className="flex items-center gap-1.5">{sources ? <Folder size={14} /> : <Clapperboard size={14} />}{sources ? `${items.length} finished ${items.length === 1 ? 'project' : 'projects'}` : `${clips} published ${clips === 1 ? 'clip' : 'clips'}`}</span>
          {!sources && folders > 0 && <span className="flex items-center gap-1.5"><Folder size={14} />{folders} full {folders === 1 ? 'project' : 'projects'}</span>}
        </div>}
        {preview.items.length > 0 ? <div>
          <div className="mb-2 flex items-center justify-between text-xs"><span className="font-medium text-ink">{sources ? 'Source files & editor previews' : 'Library projects'}</span>{eligible.length > 1 && <button type="button" disabled={busy} className="rounded text-accent hover:underline" onClick={() => setSelected(selected.length === eligible.length ? [] : eligible.map(item => item.id))}>{selected.length === eligible.length ? 'Deselect all' : 'Select all'}</button>}</div>
          <div className="max-h-60 divide-y divide-white/[0.06] overflow-y-auto rounded-xl border border-white/[0.07]">
            {preview.items.map(item => <label key={item.id} className={cn('flex items-center gap-3 px-3 py-3', item.keepReason ? 'opacity-60' : 'cursor-pointer hover:bg-white/[0.03]')}>
              <input type="checkbox" aria-label={item.title} checked={selected.includes(item.id)} disabled={busy || Boolean(item.keepReason)} onChange={event => setSelected(previous => event.target.checked ? [...previous, item.id] : previous.filter(id => id !== item.id))} className="h-3.5 w-3.5 shrink-0 accent-accent" />
              <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-ink" title={item.title}>{item.title}</span><span className="mt-1 block text-2xs text-ink-muted">{item.keepReason ?? (sources ? 'Ready to free' : `${item.clipCount} posted · ${item.kind === 'run' ? 'All project files' : 'Exports only'}`)}</span></span>
              <span className="shrink-0 text-xs tabular-nums text-ink-muted">{item.partial && '≥ '}{formatBytes(item.bytes)}</span>
            </label>)}
          </div>
        </div> : <div className="flex items-center gap-2 rounded-xl bg-success/5 p-3 text-xs text-ink-muted"><Check size={16} className="text-success" />{sources ? 'No retained source media to clean.' : 'No published content ready to clean.'}</div>}
        <div className="space-y-2 text-xs leading-relaxed text-ink-muted">
          {!sources && <p><Check size={14} className="mr-1.5 inline text-success" />Unposted clips, queued posts & unfinished edits are kept.</p>}
          {!sources && folders > 0 && <p>Full projects include their sources, edits, transcripts and other local files.</p>}
          {!sources && <p className="text-2xs text-ink-subtle">Uses the Library’s posted status, including clips you marked as posted.</p>}
          {sources && <p>Freed projects can no longer be refined or baked again.</p>}
          {preview.unavailableProjects > 0 && <p className="text-warning">{preview.unavailableProjects} {preview.unavailableProjects === 1 ? 'project was' : 'projects were'} in use or couldn’t be checked. Kept for now.</p>}
        </div>
      </div>}
    </div>
    <DialogFooter className="flex-wrap">
      {eligible.length > 0 && <span className="mr-auto flex items-center gap-1.5 text-2xs text-ink-subtle"><AlertCircle size={13} />Can’t be undone</span>}
      <Button ref={cancel} disabled={busy} onClick={close}>{preview && !eligible.length ? 'Done' : 'Cancel'}</Button>
      {(!preview || eligible.length > 0) && <Button variant="danger" disabled={!preview || !selected.length || Boolean(error)} loading={busy} onClick={() => void clean()}>{sources ? 'Free source media' : 'Delete local files'}</Button>}
    </DialogFooter>
  </Dialog>
}
