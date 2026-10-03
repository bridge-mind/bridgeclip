import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from './Button'
import { cn } from '../../lib/utils'
import { Select } from './Select'
import { TABLE_PAGE_SIZES } from '../../store/use-table-preferences-store'

export function paginationItems(page: number, pages: number): (number | string)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1)
  const visible = new Set([1, pages, page - 1, page, page + 1])
  if (page <= 3) [2, 3, 4].forEach(n => visible.add(n))
  if (page >= pages - 2) [pages - 3, pages - 2, pages - 1].forEach(n => visible.add(n))
  const ordered = [...visible].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b)
  return ordered.flatMap((n, i) => {
    const gap = i > 0 ? n - ordered[i - 1] : 0
    return gap === 2 ? [n - 1, n] : gap > 2 ? [`gap-${n}`, n] : [n]
  })
}

export function Pagination({ page, pages, total, pageSize, onChange, onPageSizeChange, label = 'Previous jobs pages' }: { label?: string; page: number; pages: number; total: number; pageSize: number; onChange: (page: number) => void; onPageSizeChange: (size: number) => void }): React.JSX.Element {
  return <nav aria-label={label} className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] px-3 py-2.5">
    <div className="flex flex-wrap items-center gap-3">
      <Select aria-label="Rows per page" size="sm" className="w-28" value={String(pageSize)} options={TABLE_PAGE_SIZES.map(size => ({ value: String(size), label: `${size} / page` }))} onChange={value => onPageSizeChange(Number(value))} />
      <span role="status" aria-live="polite" className="font-mono text-2xs tabular text-ink-subtle">{total ? (page - 1) * pageSize + 1 : 0}–{Math.min(total, page * pageSize)} <span className="font-sans">of</span> {total}</span>
    </div>
    <div className="flex items-center gap-1"><Button variant="ghost" size="sm" iconOnly aria-label="Previous page" disabled={page <= 1} icon={<ChevronLeft size={14} />} onClick={() => onChange(page - 1)} />
      {paginationItems(page, pages).map(item => typeof item === 'string' ? <span key={item} className="px-1 text-xs text-ink-faint" aria-hidden>…</span> :
        <button key={item} type="button" aria-label={`Page ${item}`} aria-current={item === page ? 'page' : undefined} onClick={() => onChange(item)} className={cn('history-page-number h-7 min-w-7 rounded-full px-1.5 font-mono text-xs tabular', item === page ? 'bg-accent text-accent-ink shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14)]' : 'text-ink-subtle hover:bg-white/[0.05] hover:text-ink')}>{item}</button>)}
      <Button variant="ghost" size="sm" iconOnly aria-label="Next page" disabled={page >= pages} icon={<ChevronRight size={14} />} onClick={() => onChange(page + 1)} />
    </div>
  </nav>
}
