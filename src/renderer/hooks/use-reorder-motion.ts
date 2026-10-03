import { useCallback, useLayoutEffect, useRef } from 'react'

interface Position { left: number; top: number }
interface Snapshot { positions: Map<string, Position>; focus: HTMLElement | null; featured: string }

/** Move the existing card nodes between grid positions without fading their media. */
export function useReorderMotion(attribute = 'data-reorder-key'): {
  gridRef: React.RefObject<HTMLDivElement | null>
  capture: (featured: string) => void
} {
  const gridRef = useRef<HTMLDivElement>(null)
  const snapshot = useRef<Snapshot | null>(null)
  const animations = useRef(new Map<HTMLElement, Animation>())
  const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const position = (node: HTMLElement): Position => {
    const rect = node.getBoundingClientRect()
    const scroll = document.getElementById('page-scroll')
    return { left: rect.left + (scroll?.scrollLeft ?? 0), top: rect.top + (scroll?.scrollTop ?? 0) }
  }
  const capture = useCallback((featured: string) => {
    const grid = gridRef.current
    if (!grid) return
    // Read every current visual position before cancelling an interrupted move.
    const positions = new Map<string, Position>()
    grid.querySelectorAll<HTMLElement>(`[${attribute}]`).forEach(node => {
      positions.set(node.getAttribute(attribute)!, position(node))
    })
    for (const [node, animation] of animations.current) { animation.cancel(); node.style.zIndex = '' }
    animations.current.clear()
    const focus = document.activeElement instanceof HTMLElement && grid.contains(document.activeElement) ? document.activeElement : null
    snapshot.current = { positions, focus, featured }
  }, [attribute])

  useLayoutEffect(() => {
    const before = snapshot.current
    snapshot.current = null
    if (!before || !gridRef.current) return
    if (before.focus?.isConnected && document.activeElement !== before.focus) before.focus.focus({ preventScroll: true })
    if (reducedMotion()) return
    const moves = Array.from(gridRef.current.querySelectorAll<HTMLElement>(`[${attribute}]`)).map(node => ({ node, next: position(node) }))
    for (const { node, next } of moves) {
      const key = node.getAttribute(attribute)!
      const previous = before.positions.get(key)
      let frames: Keyframe[]
      if (previous) {
        const x = previous.left - next.left, y = previous.top - next.top
        if (Math.abs(x) < .5 && Math.abs(y) < .5) continue
        frames = [{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }]
      } else {
        frames = [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'translateY(0)' }]
      }
      node.style.zIndex = key === before.featured ? '2' : '1'
      const animation = node.animate(frames, { duration: previous ? 460 : 240, easing: 'cubic-bezier(.22, 1, .36, 1)' })
      animations.current.set(node, animation)
      void animation.finished.then(() => {
        if (animations.current.get(node) !== animation) return
        animations.current.delete(node)
        node.style.zIndex = ''
      }).catch(() => {})
    }
  })

  useLayoutEffect(() => {
    const active = animations.current
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const cancel = (): void => {
      for (const [node, animation] of active) { animation.cancel(); node.style.zIndex = '' }
      active.clear()
    }
    const changed = (): void => { if (preference.matches) cancel() }
    preference.addEventListener('change', changed)
    return () => { preference.removeEventListener('change', changed); cancel() }
  }, [])
  return { gridRef, capture }
}
