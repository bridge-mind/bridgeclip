import { useEffect, useId, useRef } from 'react'
import { ArrowUpRight, History, X } from 'lucide-react'
import changelogMarkdown from '../../../CHANGELOG.md?raw'
import { UNRELEASED, hasChanges, parseChangelog, parseChangelogText, type ChangelogRelease } from '../../shared/changelog'
import { APP_NAME, APP_VERSION, RELEASES_URL } from '../config/brand'
import { getApi } from '../lib/ipc'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { Dialog, DialogFooter } from './ui/Dialog'
import { IconTile } from './ui/IconTile'

/** Bundled at build time, so the list always matches the running version. */
const RELEASES = parseChangelog(changelogMarkdown).filter(hasChanges)

function formatReleaseDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function RichText({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {parseChangelogText(text).map((part, index) =>
        part.kind === 'strong' ? <strong key={index} className="font-medium text-ink">{part.text}</strong>
          : part.kind === 'code' ? <code key={index} className="rounded bg-white/[0.06] px-1 font-mono text-[0.85em] text-ink">{part.text}</code>
            : part.text
      )}
    </>
  )
}

function ReleaseNotes({ release }: { release: ChangelogRelease }): React.JSX.Element {
  const headingId = useId()
  const unreleased = release.version === UNRELEASED
  return (
    <section aria-labelledby={headingId} className="py-5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="text-sm font-semibold text-ink">{unreleased ? 'Unreleased' : `Version ${release.version}`}</h3>
        {release.version === APP_VERSION && <Badge tone="accent">This version</Badge>}
        {unreleased && <Badge>Not in a release yet</Badge>}
        {release.date && <span className="ml-auto font-mono text-2xs tabular text-ink-subtle">{formatReleaseDate(release.date)}</span>}
      </div>
      {release.notes.map((note, index) => (
        <p key={index} className="mt-1.5 text-sm leading-relaxed text-ink-muted"><RichText text={note} /></p>
      ))}
      {release.sections.filter((section) => section.items.length > 0).map((section) => (
        <div key={section.heading} className="mt-3">
          <p className="eyebrow">{section.heading}</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-sm leading-relaxed text-ink-muted marker:text-ink-faint">
            {section.items.map((item, index) => <li key={index}><RichText text={item} /></li>)}
          </ul>
        </div>
      ))}
    </section>
  )
}

/** What changed in each version, read from CHANGELOG.md. Escape and the backdrop close it. */
export function ChangelogDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // The scrolling list takes focus so arrow keys and Page Down read it right away.
    bodyRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab') return
      const controls = panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')
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
    <Dialog ref={panelRef} aria-labelledby={titleId} onBackdropMouseDown={onClose} panelClassName="h-[min(680px,85dvh)] max-w-[640px]">
      <header className="flex shrink-0 items-center gap-3 border-b border-white/[0.07] px-5 py-4">
        <IconTile><History /></IconTile>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-base font-semibold text-ink">Changelog</h2>
          <p className="mt-0.5 text-xs text-ink-muted">What’s new in each version of {APP_NAME}.</p>
        </div>
        <Button iconOnly variant="ghost" aria-label="Close changelog" icon={<X className="h-4 w-4" />} onClick={onClose} />
      </header>
      <div
        ref={bodyRef}
        tabIndex={0}
        aria-label="Changes by version"
        className="min-h-0 flex-1 divide-y divide-white/[0.06] overflow-y-auto px-5 py-5 outline-none"
        data-selectable
      >
        {RELEASES.length > 0
          ? RELEASES.map((release) => <ReleaseNotes key={release.version} release={release} />)
          : <p className="text-sm text-ink-muted">No changes are listed for this version. See all releases on GitHub.</p>}
      </div>
      <DialogFooter className="justify-between">
        <Button
          size="sm"
          variant="ghost"
          trailingIcon={<ArrowUpRight className="h-3.5 w-3.5" />}
          onClick={() => void getApi().shell.openPath(RELEASES_URL).catch(() => {})}
        >
          All releases on GitHub
        </Button>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </Dialog>
  )
}
