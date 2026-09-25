import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { cn } from '../../lib/utils'
import { WELL } from './Field'

export interface SelectOption {
  value: string
  label: string
  /** Muted text after the label, e.g. why the option can't be chosen. */
  detail?: string
  disabled?: boolean
}

/** Floating menu surface shared by dropdowns: thick glass over whatever it covers. */
export const MENU_SURFACE = 'glass-thick rounded-xl p-1 text-sm text-ink'

/** One row of a dropdown menu. `active` is the keyboard or pointer highlight. */
export function menuOptionClass(active: boolean, disabled = false): string {
  return cn(
    'flex w-full cursor-default select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors duration-100',
    disabled ? 'text-ink-muted opacity-50' : active ? 'bg-white/[0.08] text-ink' : 'text-ink-muted'
  )
}

interface SelectProps {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  /** Shown on the trigger while no option is chosen. */
  placeholder?: string
  /** Shown in the menu when there are no options. */
  emptyText?: string
  /** Adds a filter field to the menu, for long lists. */
  searchable?: boolean
  searchPlaceholder?: string
  size?: 'sm' | 'md'
  disabled?: boolean
  id?: string
  title?: string
  className?: string
  'aria-label'?: string
  'aria-describedby'?: string
}

const GAP = 4
const EDGE = 8
const MAX_HEIGHT = 300
const TYPEAHEAD_MS = 600

/** Next enabled index from `from` in `step` direction, or `from` when there is none. */
function step(options: SelectOption[], from: number, by: number): number {
  const direction = by > 0 ? 1 : -1
  let found = from
  for (let i = from + direction, moved = 0; i >= 0 && i < options.length; i += direction) {
    if (options[i].disabled) continue
    found = i
    if (++moved >= Math.abs(by)) break
  }
  return found
}

const firstEnabled = (options: SelectOption[]): number => step(options, -1, 1)
const lastEnabled = (options: SelectOption[]): number => step(options, options.length, -1)

function isPrintable(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey
}

/**
 * Dropdown in the app's glass style, replacing the native <select> menu.
 * The trigger is a combobox button (focus stays on it while the menu is
 * open, except in the filter field of a `searchable` menu). The menu is a
 * top-layer popover, so dialogs and panels with hidden overflow never clip
 * it, and it stays inside its dialog in the accessibility tree.
 */
export function Select({
  value,
  options,
  onChange,
  placeholder = 'Choose…',
  emptyText = 'Nothing to choose from',
  searchable = false,
  searchPlaceholder = 'Search',
  size = 'md',
  disabled = false,
  id,
  title,
  className,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy
}: SelectProps): React.JSX.Element {
  const autoId = useId()
  const triggerId = id ?? `${autoId}-trigger`
  const listId = `${autoId}-list`
  const optionId = (index: number): string => `${autoId}-option-${index}`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const typed = useRef({ text: '', at: 0 })
  const placeRef = useRef<(() => void) | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(-1)

  const selected = options.find((option) => option.value === value)
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return options
    return options.filter((option) => option.label.toLowerCase().includes(needle) || option.value.toLowerCase().includes(needle))
  }, [options, query])

  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    setQuery('')
    setActive(-1)
    if (refocus) triggerRef.current?.focus({ preventScroll: true })
  }, [])

  const openMenu = (start: 'selected' | 'first' | 'last'): void => {
    if (disabled) return
    const current = options.findIndex((option) => option.value === value && !option.disabled)
    setQuery('')
    setActive(start === 'first' ? firstEnabled(options) : start === 'last' ? lastEnabled(options) : current >= 0 ? current : firstEnabled(options))
    setOpen(true)
  }

  const commit = (index: number): void => {
    const option = visible[index]
    if (!option || option.disabled) return
    if (option.value !== value) onChange(option.value)
    close(true)
  }

  /** Jumps to the next option whose label starts with what was just typed. */
  const typeAhead = (character: string, from: number): void => {
    const now = Date.now()
    const memory = typed.current
    memory.text = now - memory.at > TYPEAHEAD_MS ? character : memory.text + character
    memory.at = now
    const text = memory.text.toLowerCase()
    // Repeating one letter cycles through the options that start with it.
    const needle = [...text].every((c) => c === text[0]) ? text[0] : text
    const offset = needle.length === 1 ? 1 : 0
    for (let n = 0; n < options.length; n++) {
      const index = (Math.max(from, -1) + offset + n + options.length) % options.length
      const option = options[index]
      if (!option.disabled && option.label.toLowerCase().startsWith(needle)) {
        setActive(index)
        return
      }
    }
  }

  const onListKeyDown = (event: KeyboardEvent): void => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault()
        setActive((index) => index < 0 ? (event.key === 'ArrowDown' ? firstEnabled(visible) : lastEnabled(visible)) : step(visible, index, event.key === 'ArrowDown' ? 1 : -1))
        return
      case 'PageDown':
      case 'PageUp':
        event.preventDefault()
        setActive((index) => step(visible, index, event.key === 'PageDown' ? 10 : -10))
        return
      case 'Home':
      case 'End':
        // In the filter field these move the caret.
        if (searchable) return
        event.preventDefault()
        setActive(event.key === 'Home' ? firstEnabled(visible) : lastEnabled(visible))
        return
      case 'Enter':
        event.preventDefault()
        event.stopPropagation()
        commit(active)
        return
      case ' ':
        if (searchable) return
        event.preventDefault()
        commit(active)
        return
      case 'Escape':
        // Only the menu closes, not a dialog around it.
        event.preventDefault()
        event.stopPropagation()
        close(true)
        return
      case 'Tab':
        // The filter field goes away with the menu, so focus returns to the trigger first.
        if (searchable) {
          event.preventDefault()
          close(true)
        } else close(false)
        return
      default:
        if (!searchable && isPrintable(event)) {
          event.preventDefault()
          typeAhead(event.key, active)
        }
    }
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return
    if (open) {
      if (!searchable) onListKeyDown(event)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openMenu('selected')
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      openMenu(event.key === 'Home' ? 'first' : 'last')
    } else if (!searchable && isPrintable(event)) {
      event.preventDefault()
      openMenu('selected')
      typeAhead(event.key, options.findIndex((option) => option.value === value))
    }
  }

  // Show the popover, place it under (or above) the trigger, and bring the
  // chosen option into view. Runs before paint, so the menu never flashes.
  useLayoutEffect(() => {
    if (!open) return
    const menu = menuRef.current
    if (!menu) return
    try {
      if (typeof menu.showPopover === 'function' && !menu.matches(':popover-open')) menu.showPopover()
    } catch {
      // Without the popover API the menu is still a fixed layer above the page.
    }
    const place = (): void => {
      const trigger = triggerRef.current?.getBoundingClientRect()
      if (!trigger) return
      menu.style.minWidth = `${trigger.width}px`
      menu.style.maxHeight = `${MAX_HEIGHT}px`
      const natural = menu.offsetHeight
      const below = window.innerHeight - trigger.bottom - GAP - EDGE
      const above = trigger.top - GAP - EDGE
      const downward = below >= natural || below >= above
      menu.style.maxHeight = `${Math.max(96, Math.min(MAX_HEIGHT, downward ? below : above))}px`
      const height = menu.offsetHeight
      menu.style.top = `${downward ? trigger.bottom + GAP : trigger.top - GAP - height}px`
      menu.style.left = `${Math.max(EDGE, Math.min(trigger.left, window.innerWidth - EDGE - menu.offsetWidth))}px`
      menu.style.transformOrigin = downward ? 'top' : 'bottom'
    }
    place()
    placeRef.current = place
    const list = listRef.current
    const chosen = list?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (list && chosen) list.scrollTop = chosen.offsetTop - list.clientHeight / 2 + chosen.offsetHeight / 2
    if (searchable) searchRef.current?.focus({ preventScroll: true })
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => {
      placeRef.current = null
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [open, searchable])

  useLayoutEffect(() => {
    placeRef.current?.()
  }, [visible.length])

  // Keep the highlighted option inside the list's scroll view.
  useEffect(() => {
    const list = listRef.current
    const option = active >= 0 ? list?.children[active] as HTMLElement | undefined : undefined
    if (!list || !option) return
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop - 4
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight + 4
  }, [active, open])

  // A press anywhere else, or leaving the window, closes the menu.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) close(false)
    }
    const onBlur = (): void => close(false)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [open, close])

  // A disabled trigger can't hold a menu open.
  useEffect(() => {
    if (disabled && open) close(false)
  }, [disabled, open, close])

  return (
    <>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && !searchable && active >= 0 ? optionId(active) : undefined}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        title={title}
        disabled={disabled}
        onClick={() => (open ? close(true) : openMenu('selected'))}
        onKeyDown={onTriggerKeyDown}
        data-open={open || undefined}
        className={cn(
          'relative flex w-full min-w-0 items-center rounded-lg pl-2.5 pr-8 text-left',
          size === 'sm' ? 'h-7 text-xs' : 'h-8 text-sm',
          WELL,
          'data-[open]:border-accent/70 data-[open]:bg-black/30',
          disabled && 'cursor-not-allowed opacity-60',
          className
        )}
      >
        <span className={cn('min-w-0 truncate', selected ? 'text-ink' : 'text-ink-faint')}>{selected?.label ?? placeholder}</span>
        <ChevronDown aria-hidden className={cn('pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-ink-subtle transition-transform duration-150', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          ref={menuRef}
          popover="manual"
          className={cn(MENU_SURFACE, 'fixed inset-auto z-[120] m-0 flex max-w-[min(420px,calc(100vw-16px))] flex-col overflow-hidden border-0 animate-menu-in')}
          style={{ top: -9999, left: -9999 }}
        >
          {searchable && (
            <div className="mb-1 flex shrink-0 items-center gap-2 border-b border-white/[0.07] px-2.5 pb-1">
              <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => {
                  const next = event.target.value
                  setQuery(next)
                  const needle = next.trim().toLowerCase()
                  const matches = needle ? options.filter((option) => option.label.toLowerCase().includes(needle) || option.value.toLowerCase().includes(needle)) : options
                  setActive(firstEnabled(matches))
                }}
                onKeyDown={onListKeyDown}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                aria-controls={listId}
                aria-activedescendant={active >= 0 ? optionId(active) : undefined}
                spellCheck={false}
                autoComplete="off"
                className="h-7 w-full min-w-0 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
              />
            </div>
          )}
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            aria-labelledby={ariaLabel ? undefined : triggerId}
            className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            {visible.map((option, index) => (
              <li
                key={option.value}
                id={optionId(index)}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                title={option.detail ? `${option.label} · ${option.detail}` : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => { if (!option.disabled && index !== active) setActive(index) }}
                onClick={() => commit(index)}
                className={menuOptionClass(index === active, option.disabled)}
              >
                <span className="min-w-0 flex-1 truncate">
                  {option.label}
                  {option.detail && <span className="text-ink-subtle"> · {option.detail}</span>}
                </span>
                {option.value === value && <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-accent-hover" strokeWidth={2.5} />}
              </li>
            ))}
          </ul>
          {visible.length === 0 && (
            <p className="px-2.5 py-2 text-xs text-ink-subtle">{query ? 'No matches' : emptyText}</p>
          )}
        </div>
      )}
    </>
  )
}
