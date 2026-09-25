import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '../../lib/utils'

const GAP = 8
const EDGE = 8

interface HoverCardProps {
  /** The card's content. Read-only: it is a tooltip, so nothing in it can be clicked. */
  content: ReactNode
  children: ReactNode
  /** Accessible name for the trigger when its own text doesn't say what the card explains. */
  label?: string
  className?: string
  cardClassName?: string
  openDelay?: number
}

/**
 * A rich tooltip: hovering or focusing the trigger shows a thick-glass card
 * under it (above it when there's no room). The card is a top-layer popover,
 * so panels with hidden overflow never clip it. Escape closes it.
 */
export function HoverCard({ content, children, label, className, cardClassName, openDelay = 120 }: HoverCardProps): React.JSX.Element {
  const id = useId()
  const triggerRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const timer = useRef(0)
  const [open, setOpen] = useState(false)

  const show = useCallback((delay: number) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOpen(true), delay)
  }, [])
  const hide = useCallback(() => {
    window.clearTimeout(timer.current)
    setOpen(false)
  }, [])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  useLayoutEffect(() => {
    if (!open) return
    const card = cardRef.current
    if (!card) return
    try {
      if (typeof card.showPopover === 'function' && !card.matches(':popover-open')) card.showPopover()
    } catch {
      // Without the popover API the card is still a fixed layer above the page.
    }
    const place = (): void => {
      const trigger = triggerRef.current?.getBoundingClientRect()
      if (!trigger) return
      const below = window.innerHeight - trigger.bottom - GAP - EDGE
      const downward = below >= card.offsetHeight || below >= trigger.top - GAP - EDGE
      const center = trigger.left + trigger.width / 2 - card.offsetWidth / 2
      card.style.left = `${Math.max(EDGE, Math.min(center, window.innerWidth - EDGE - card.offsetWidth))}px`
      card.style.top = `${downward ? trigger.bottom + GAP : trigger.top - GAP - card.offsetHeight}px`
      card.style.transformOrigin = downward ? 'top' : 'bottom'
    }
    place()
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') hide() }
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, hide])

  return (
    <div
      ref={triggerRef}
      tabIndex={0}
      aria-label={label}
      aria-describedby={open ? id : undefined}
      onPointerEnter={() => show(openDelay)}
      onPointerLeave={hide}
      onFocus={() => show(0)}
      onBlur={hide}
      className={cn('cursor-default', className)}
    >
      {children}
      {open && (
        <div
          ref={cardRef}
          id={id}
          role="tooltip"
          popover="manual"
          className={cn('glass-thick pointer-events-none fixed inset-auto z-[120] m-0 overflow-hidden rounded-2xl border-0 p-0 text-ink animate-menu-in', cardClassName)}
          style={{ top: -9999, left: -9999 }}
        >
          {content}
        </div>
      )}
    </div>
  )
}
