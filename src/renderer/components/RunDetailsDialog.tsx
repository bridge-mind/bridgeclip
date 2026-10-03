import { useEffect, useRef } from 'react'
import { Timer, X } from 'lucide-react'
import { parseStages } from '../../shared/job-progress'
import { parseRunDiagnostics } from '../../shared/run-diagnostics'
import type { JobOutput } from '../store/use-job-store'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import { StageBreakdown } from './StageBreakdown'
import { JobDiagnostics } from './JobDiagnostics'

export function RunDetailsDialog({ output, onClose }: {
  output: JobOutput
  onClose: () => void
}): React.JSX.Element {
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const stages = parseStages(output.metrics?.pipeline_stages) ?? []
  const diagnostics = parseRunDiagnostics(output.metrics?.diagnostics)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    close.current?.focus()
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab') return
      const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], summary, [tabindex="0"]') ?? [])].filter(item => item.getClientRects().length > 0)
      if (!items.length) return
      if (!panel.current?.contains(document.activeElement) || (event.shiftKey ? document.activeElement === items[0] : document.activeElement === items.at(-1))) {
        event.preventDefault()
        ;(event.shiftKey ? items.at(-1) : items[0])?.focus()
      }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); previous?.focus() }
  }, [onClose])

  return <Dialog ref={panel} aria-label="Processing details" panelClassName="max-w-[760px]" onBackdropMouseDown={onClose}>
    <header className="flex shrink-0 items-center gap-3 border-b border-white/[0.07] px-5 py-4">
      <Timer aria-hidden className="h-5 w-5 shrink-0 text-ink-muted" />
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold">Processing details</h2>
        <p className="mt-0.5 truncate text-xs text-ink-muted">{output.source_video_title}</p>
      </div>
      <Button ref={close} variant="ghost" iconOnly aria-label="Close processing details" icon={<X className="h-4 w-4" />} onClick={onClose} />
    </header>
    <div className="min-h-0 overflow-y-auto overscroll-contain p-5">
      <section>
        <h3 className="mb-4 text-sm font-medium">Stage timings</h3>
        {stages.length ? <StageBreakdown stages={stages} /> : <p className="text-xs text-ink-muted">Stage timings weren’t recorded for this run.</p>}
      </section>
      {diagnostics && <JobDiagnostics diagnostics={diagnostics} saved />}
    </div>
  </Dialog>
}
