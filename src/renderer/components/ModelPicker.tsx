import { useId, useMemo, useState } from 'react'
import { Check, Search } from 'lucide-react'
import { searchModels, type ModelTask, type OpenRouterModel } from '../../shared/openrouter-models'
import { cn } from '../lib/utils'
import { Field, TextInput } from './ui/Field'
import { MENU_SURFACE, menuOptionClass } from './ui/Select'

export function ModelPicker({ task, models, value, onChange, loading }: {
  task: ModelTask
  models: OpenRouterModel[]
  value: string
  onChange: (id: string) => void
  loading: boolean
}): React.JSX.Element {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(-1)
  const selected = models.find((model) => model.id === value)
  const matches = useMemo(() => searchModels(models, query), [models, query])
  const label = task === 'planning' ? 'Clip planning model' : 'Transcription model'
  const choose = (model: OpenRouterModel): void => {
    if (model.unavailableReason) return
    onChange(model.id)
    setOpen(false)
    setQuery('')
    setActive(-1)
  }
  const price = selected && task === 'planning' && selected.inputPrice !== null && selected.outputPrice !== null
    ? `$${(selected.inputPrice * 1e6).toLocaleString(undefined, { maximumFractionDigits: 3 })} input / $${(selected.outputPrice * 1e6).toLocaleString(undefined, { maximumFractionDigits: 3 })} output per 1M tokens` : null

  return <div onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setOpen(false); setActive(-1) }
  }}>
    <Field label={label} htmlFor={id}>
      <div className="relative">
        <TextInput id={id} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-options`}
          aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
          aria-describedby={`${id}-help`} leading={<Search className="h-3.5 w-3.5" />}
          placeholder={loading ? 'Loading OpenRouter models…' : 'Search by model name or provider…'}
          value={open ? query : (selected?.name ?? value)}
          onFocus={() => { setOpen(true); setQuery(''); setActive(-1) }}
          onClick={() => { if (!open) { setOpen(true); setQuery(''); setActive(-1) } }}
          onChange={(event) => { setQuery(event.target.value); setActive(-1); setOpen(true) }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); return }
            if (event.key === 'Enter' && open) {
              event.preventDefault(); event.stopPropagation()
              if (active >= 0 && matches[active]) choose(matches[active])
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault(); setOpen(true)
              const direction = event.key === 'ArrowDown' ? 1 : -1
              let next = active < 0 ? (direction > 0 ? 0 : matches.length - 1) : active + direction
              while (next >= 0 && next < matches.length && matches[next].unavailableReason) next += direction
              if (next >= 0 && next < matches.length) {
                setActive(next)
                document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: 'nearest' })
              }
            }
          }} />
        {open && <div className={cn(MENU_SURFACE, 'absolute z-30 mt-1 w-full overflow-hidden animate-menu-in [transform-origin:top]')}>
          <div role="status" className="px-2.5 pb-1.5 pt-1 text-2xs text-ink-subtle">
            {loading ? 'Loading models…' : `${matches.length} models · search to narrow the list`}
          </div>
          <ul id={`${id}-options`} role="listbox" aria-label={label} className="max-h-60 overflow-y-auto">
            {matches.map((model, index) => <li id={`${id}-${index}`} key={model.id} role="option"
              aria-selected={model.id === value} aria-disabled={Boolean(model.unavailableReason)}
              onMouseDown={(event) => event.preventDefault()} onClick={() => choose(model)}
              onMouseMove={() => { if (!model.unavailableReason) setActive(index) }}
              className={cn(menuOptionClass(active === index, Boolean(model.unavailableReason)), 'block py-2')}>
              <div className="flex items-center gap-2 text-xs text-ink"><span className="min-w-0 flex-1 truncate">{model.name}</span>{model.id === value && <Check className="h-3.5 w-3.5 shrink-0 text-accent-hover" strokeWidth={2.5} />}</div>
              <p className="break-all font-mono text-2xs text-ink-subtle">{model.id}</p>
              {model.unavailableReason && <p className="mt-1 text-2xs text-ink-muted">{model.unavailableReason}</p>}
            </li>)}
            {!loading && matches.length === 0 && <li className="px-2 py-3 text-xs text-ink-muted">No matching models. Try a different name or provider.</li>}
          </ul>
        </div>}
      </div>
      <div id={`${id}-help`} className="space-y-1 text-2xs text-ink-subtle">
        {value && <p className="break-all font-mono">{value}</p>}
        {selected?.unavailableReason && <p role="alert" className="text-danger">{selected.unavailableReason}</p>}
        {price && <p>{price}. Provider prices may vary.</p>}
        {selected && task === 'planning' && <p>{selected.contextLength ? `${selected.contextLength.toLocaleString()} token context · ` : ''}{selected.supportsImages ? 'Supports silent-video planning' : 'Requires a video with speech'}</p>}
        {task === 'transcription' && <p>Word timestamps are required for captions and clip timing. Support varies by model and provider; an unsupported response stops the run.</p>}
      </div>
    </Field>
  </div>
}
