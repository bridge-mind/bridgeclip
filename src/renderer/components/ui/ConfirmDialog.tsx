import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Button } from './Button'
import { Dialog, DialogFooter } from './Dialog'

export interface ConfirmRequest {
  title: string
  body: ReactNode
  confirmLabel: string
  /** Accessible name for the confirm button when its label alone is ambiguous. */
  confirmAriaLabel?: string
  /** `danger` (default) for destructive actions; `primary` to go ahead after a warning. */
  tone?: 'danger' | 'primary'
  onConfirm: () => void
}

/** Asks before an action. Cancel has focus; Escape and the backdrop cancel. Pass a stable `onClose`. */
export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }): React.JSX.Element {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab') return
      const controls = panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]')
      if (!controls?.length) return
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (!panelRef.current?.contains(document.activeElement) ||
          (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown); previousFocus?.focus() }
  }, [onClose])
  return (
    <Dialog ref={panelRef} role="alertdialog" aria-labelledby={titleId} onBackdropMouseDown={onClose} panelClassName="max-w-[420px]">
      <div className="px-5 pb-5 pt-5">
        <h2 id={titleId} className="text-base font-semibold text-ink">{request.title}</h2>
        <p className="mt-1.5 text-sm text-ink-muted" data-selectable>{request.body}</p>
      </div>
      <DialogFooter>
        <Button ref={cancelRef} onClick={onClose}>Cancel</Button>
        <Button
          variant={request.tone ?? 'danger'}
          aria-label={request.confirmAriaLabel}
          onClick={() => { onClose(); request.onConfirm() }}
        >
          {request.confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
