import { createContext, useContext, useLayoutEffect, type RefObject } from 'react'

/** Pages with nested views report whether clicking their sidebar item would navigate. */
export const PageRootContext = createContext<RefObject<boolean> | null>(null)

export function usePageRoot(atRoot: boolean): void {
  const root = useContext(PageRootContext)
  useLayoutEffect(() => {
    if (!root) return
    root.current = atRoot
    // Pages without nested views are roots by default.
    return () => { root.current = true }
  }, [root, atRoot])
}
