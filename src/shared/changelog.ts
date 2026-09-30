// Reads CHANGELOG.md (Keep a Changelog layout) for the in-app changelog and
// the release check that keeps it in step with package.json.

/** Keep a Changelog's change types, in the order a release lists them. */
export const CHANGELOG_CATEGORIES = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'] as const

export const UNRELEASED = 'Unreleased'

export interface ChangelogSection {
  heading: string
  items: string[]
}

export interface ChangelogRelease {
  /** `Unreleased` or a version such as `0.1.19`. */
  version: string
  /** `YYYY-MM-DD` for released versions. */
  date: string | null
  /** Paragraphs between the version heading and its first change type. */
  notes: string[]
  sections: ChangelogSection[]
}

export interface ChangelogText {
  kind: 'text' | 'strong' | 'code'
  text: string
}

const RELEASE_HEADING = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?$/
const SECTION_HEADING = /^### (.+)$/
const ITEM = /^[-*] +(.*)$/
const LINK_DEFINITION = /^\[[^\]]+\]: +\S+$/

/**
 * Releases in file order. Text before the first release, link definitions and
 * HTML comments are skipped; wrapped lines join the item or paragraph above.
 */
export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = []
  let release: ChangelogRelease | null = null
  let section: ChangelogSection | null = null
  /** The list whose last entry a wrapped line continues. */
  let open: string[] | null = null

  for (const raw of markdown.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) { open = null; continue }
    const heading = RELEASE_HEADING.exec(line)
    if (heading) {
      release = { version: heading[1].trim(), date: heading[2] ?? null, notes: [], sections: [] }
      releases.push(release)
      section = null
      open = null
      continue
    }
    if (/^#{1,2} /.test(line)) { release = null; continue }
    if (!release || LINK_DEFINITION.test(line)) continue
    const sectionHeading = SECTION_HEADING.exec(line)
    if (sectionHeading) {
      section = { heading: sectionHeading[1].trim(), items: [] }
      release.sections.push(section)
      open = null
      continue
    }
    const item = section && /^[-*] /.test(raw) ? ITEM.exec(line) : null
    if (item && section) {
      section.items.push(item[1])
      open = section.items
    } else if (open) {
      open[open.length - 1] += ` ${line}`
    } else {
      open = section ? section.items : release.notes
      open.push(line)
    }
  }
  return releases
}

export function hasChanges(release: ChangelogRelease): boolean {
  return release.notes.length > 0 || release.sections.some((section) => section.items.length > 0)
}

/** Bold and inline code. Links keep only their text: the app opens a fixed set of URLs. */
export function parseChangelogText(text: string): ChangelogText[] {
  const plain = text.replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
  const parts: ChangelogText[] = []
  let at = 0
  for (const match of plain.matchAll(/\*\*(.+?)\*\*|`([^`]+)`/g)) {
    const index = match.index ?? 0
    if (index > at) parts.push({ kind: 'text', text: plain.slice(at, index) })
    parts.push(match[1] != null ? { kind: 'strong', text: match[1] } : { kind: 'code', text: match[2] })
    at = index + match[0].length
  }
  if (at < plain.length) parts.push({ kind: 'text', text: plain.slice(at) })
  return parts
}
