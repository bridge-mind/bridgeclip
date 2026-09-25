import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

interface FieldProps {
  label: ReactNode
  hint?: ReactNode
  /** Right-aligned next to the label, e.g. a "Get a key" link. */
  aside?: ReactNode
  htmlFor?: string
  children: ReactNode
  className?: string
}

export function Field({ label, hint, aside, htmlFor, children, className }: FieldProps): React.JSX.Element {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={htmlFor} className="flex items-center gap-2 text-sm font-medium text-ink">
          {label}
        </label>
        {aside}
      </div>
      {children}
      {hint && <p className="text-xs text-ink-subtle">{hint}</p>}
    </div>
  )
}

/** Recessed glass well shared by text inputs, selects and text areas. */
export const WELL =
  'glass-well transition-[border-color,box-shadow,background-color] duration-200 ease-out hover:border-white/[0.14] ' +
  'focus-within:border-accent/70 focus-within:bg-black/30 focus-within:shadow-[inset_0_1px_2px_rgb(0_0_0/0.35),0_0_0_4px_rgb(var(--accent)/0.16)]'

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  leading?: ReactNode
  trailing?: ReactNode
  inputSize?: 'sm' | 'md' | 'lg'
  mono?: boolean
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { leading, trailing, inputSize = 'md', mono = false, className, ...props },
  ref
) {
  return (
    <div
      className={cn(
        'group/input relative flex items-center',
        inputSize === 'lg' ? 'rounded-xl' : 'rounded-lg',
        WELL,
        props.disabled && 'opacity-50',
        className
      )}
    >
      {leading && <span className={cn('pointer-events-none text-ink-subtle', inputSize === 'lg' ? 'pl-3' : 'pl-2.5')}>{leading}</span>}
      <input
        ref={ref}
        spellCheck={false}
        autoComplete="off"
        className={cn(
          'w-full min-w-0 bg-transparent text-ink placeholder:text-ink-faint focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed',
          // Wrapper border adds 2px: sm totals 28px, md 32px, lg 40px, matching Button sizes.
          inputSize === 'lg' ? 'h-[38px] px-3 text-sm' : inputSize === 'sm' ? 'h-[26px] px-2 text-xs' : 'h-[30px] px-2.5 text-sm',
          leading && (inputSize === 'lg' ? 'pl-2.5' : 'pl-2'),
          mono && 'font-mono text-xs',
          trailing && 'pr-1'
        )}
        {...props}
      />
      {trailing && <span className="flex shrink-0 items-center pr-1.5">{trailing}</span>}
    </div>
  )
})

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea(
  { className, ...props },
  ref
) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'block w-full resize-y rounded-lg px-3 py-2 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none',
        'glass-well transition-[border-color,box-shadow] duration-200 ease-out hover:border-white/[0.14]',
        'focus:border-accent/70 focus:shadow-[inset_0_1px_2px_rgb(0_0_0/0.35),0_0_0_4px_rgb(var(--accent)/0.16)]',
        className
      )}
      {...props}
    />
  )
})
