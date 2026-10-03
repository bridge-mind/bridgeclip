import { useEffect, useRef, useState } from 'react'
import { Bug, Check, Copy } from 'lucide-react'
import type { CrashReport } from '../../shared/crash-report'
import { getApi } from '../lib/ipc'
import { ISSUES_URL } from '../config/brand'
import { Button } from './ui/Button'
import { Dialog, DialogFooter } from './ui/Dialog'

export function CrashReportPanel(): React.JSX.Element {
  const [report, setReport] = useState<CrashReport | null>(null)
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let live = true
    void (async () => {
      try { const value = await getApi().diagnostics.crashReport(); if (live) setReport(value) }
      catch { if (live) setError(true) }
    })()
    return () => { live = false }
  }, [])
  return <section aria-label="Crash reports" className="mt-4 border-t border-white/[0.06] pt-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="flex items-center gap-2 text-sm font-medium"><Bug size={16} className="text-ink-muted" />Crash reports</h3><p className="mt-1 text-xs text-ink-muted">{error ? 'Couldn’t load the last report.' : report ? `${report.label} · ${new Date(report.recordedAt).toLocaleString()}` : 'No crashes recorded.'}</p></div>
      {report && <Button size="sm" onClick={() => setOpen(true)}>View report</Button>}
    </div>
    {open && report && <CrashReportDialog report={report} onClose={() => setOpen(false)} />}
  </section>
}
function CrashReportDialog({ report, onClose }: { report: CrashReport; onClose: () => void }): React.JSX.Element {
  const panel = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false), [error, setError] = useState(false)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
    return () => previous?.focus()
  }, [])
  const copy = async (): Promise<void> => {
    try { const ok = await getApi().diagnostics.copyCrashReport(report.recordedAt); setCopied(ok); setError(!ok) } catch { setError(true) }
  }
  return <Dialog ref={panel} aria-labelledby="crash-report-title" panelClassName="max-w-2xl" onBackdropMouseDown={onClose} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); onClose() }
    if (event.key !== 'Tab') return
    const controls = panel.current?.querySelectorAll<HTMLElement>('textarea, button')
    const first = controls?.[0], last = controls?.[controls.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }}>
    <div className="min-h-0 overflow-y-auto p-4"><h2 id="crash-report-title" className="text-base font-semibold">Crash report</h2><p className="mt-1 text-xs text-ink-muted">Copy this into a GitHub issue and add what you were doing. Nothing is sent automatically.</p>
      <textarea aria-label="Crash report text" readOnly value={report.markdown} className="mt-4 h-72 w-full resize-y rounded-xl border border-white/10 bg-black/20 p-3 font-mono text-xs leading-relaxed text-ink-muted outline-none focus:ring-2 focus:ring-accent" />
      <p role="status" className="mt-2 text-xs text-ink-muted">{error ? 'Couldn’t copy. Select and copy the text above.' : copied ? 'Copied. Paste it into your issue.' : 'Includes app details and event names. Keys, paths and raw messages are excluded.'}</p>
    </div>
    <DialogFooter className="flex-wrap"><Button onClick={onClose}>Close</Button><Button onClick={() => void getApi().shell.openPath(ISSUES_URL)}>Open GitHub</Button><Button variant="primary" icon={copied ? <Check size={14} /> : <Copy size={14} />} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy issue report'}</Button></DialogFooter>
  </Dialog>
}
