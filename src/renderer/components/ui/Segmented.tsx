import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { cn } from '../../lib/utils'

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  /** Why the option is unavailable; disables it and becomes its tooltip. */
  disabled?: string
}

interface SegmentedProps<T extends string> {
  label: string
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
  size?: 'sm' | 'md'
  className?: string
}

/** Arrow keys, Home and End move between the radios of a group (roving tab stop). */
export function onRadioKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
  const radios = Array.from(
    (event.currentTarget.closest('[role="radiogroup"]') ?? event.currentTarget.parentElement)?.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)') ?? []
  )
  const current = radios.indexOf(event.currentTarget)
  if (current < 0) return
  let next = current
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % radios.length
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current - 1 + radios.length) % radios.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = radios.length - 1
  else return
  event.preventDefault()
  radios[next].focus()
  radios[next].click()
}

/** Single choice in a glass track; the chosen segment is a raised glass pill. */
export function Segmented<T extends string>({ label, value, options, onChange, size = 'md', className }: SegmentedProps<T>): React.JSX.Element {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full bg-black/25 p-[3px] shadow-[inset_0_1px_2px_rgb(0_0_0/0.35),inset_0_0_0_1px_rgb(255_255_255/0.07)]',
        className
      )}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((option) => {
        const selected = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={Boolean(option.disabled)}
            title={option.disabled}
            onKeyDown={onRadioKeyDown}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-full font-medium transition-[background,color,box-shadow] duration-200 ease-out',
              size === 'sm' ? 'h-6 px-2.5 text-xs' : 'h-7 px-3 text-xs',
              selected
                ? 'bg-white/[0.12] text-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.2),inset_0_0_0_1px_rgb(255_255_255/0.1),0_2px_8px_-2px_rgb(0_0_0/0.5)]'
                : 'text-ink-muted hover:text-ink',
              option.disabled && 'cursor-not-allowed text-ink-faint hover:text-ink-faint'
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
