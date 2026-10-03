import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { basename, dirname, extname, join } from 'path'
import { isZernioId } from '../../shared/zernio'
import type { PostRecord, PostRecordTarget, PostStatus, PostTargetStatus } from '../../shared/zernio-posts'
import { quarantineUnbound, readableCache } from './workspace-cache'

// Bounded activity for Posts, plus durable records for Library posting status.
// Holds ids, paths, titles and statuses: nothing secret.

const VERSION = 1
/** Oldest finished activity is archived past this. Active posts are never discarded. */
const MAX_RECORDS = 300
const MAX_CACHE_BYTES = 2 * 1024 * 1024
const MAX_LEGACY_BYTES = 16 * 1024 * 1024

const STATUSES: PostStatus[] = ['draft', 'scheduled', 'publishing', 'published', 'partial', 'failed', 'cancelled', 'missing']
const TARGET_STATUSES: PostTargetStatus[] = ['pending', 'processing', 'uploading', 'published', 'failed', 'cancelled']

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null
}

function iso(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function parseTarget(value: unknown): PostRecordTarget | null {
  if (!value || typeof value !== 'object') return null
  const t = value as Record<string, unknown>
  if (typeof t.platform !== 'string' || !isZernioId(t.accountId) || !TARGET_STATUSES.includes(t.status as PostTargetStatus)) return null
  return {
    platform: t.platform.slice(0, 40),
    accountId: t.accountId,
    handle: text(t.handle, 200),
    status: t.status as PostTargetStatus,
    error: text(t.error, 1000),
    url: text(t.url, 2048),
    inbox: t.inbox === true
  }
}

export function parsePostRecord(value: unknown): PostRecord | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  const createdAt = iso(r.createdAt)
  const uploadedAt = iso(r.uploadedAt)
  if (r.automationRequeued !== undefined && typeof r.automationRequeued !== 'boolean') return null
  if (!isZernioId(r.id) || typeof r.clipPath !== 'string' || !STATUSES.includes(r.status as PostStatus) || !createdAt || !uploadedAt) return null
  const targets = Array.isArray(r.targets) ? r.targets.map(parseTarget) : []
  if (targets.length === 0 || targets.some((t) => !t)) return null
  return {
    id: r.id,
    ...(r.automationRequeued === true ? { automationRequeued: true } : {}),
    clipPath: r.clipPath.slice(0, 4096),
    clipTitle: text(r.clipTitle, 500) ?? '',
    targets: targets as PostRecordTarget[],
    scheduledFor: iso(r.scheduledFor),
    timezone: text(r.timezone, 64),
    status: r.status as PostStatus,
    error: text(r.error, 1000),
    createdAt,
    uploadedAt,
    refreshedAt: iso(r.refreshedAt)
  }
}

export class PostsStore {
  private readonly path: string
  private readonly reservations: PostRecord[] = []

  constructor(private readonly filePath: string, private readonly workspace: string | null = null) {
    if (workspace && !/^[A-Za-z0-9_-]+$/.test(workspace)) throw new Error('Invalid post workspace')
    const extension = extname(filePath)
    this.path = workspace ? join(dirname(filePath), `${basename(filePath, extension)}-${workspace}${extension}`) : filePath
  }

  private serialize(posts: PostRecord[]): string {
    const active = posts.filter((post) => post.status === 'scheduled' || post.status === 'publishing')
    const finished = posts.filter((post) => post.status !== 'scheduled' && post.status !== 'publishing')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    if (active.length > MAX_RECORDS) throw new Error('Post history is full of active posts. Finish or cancel a post before adding another.')
    const encode = (finishedCount: number): string => JSON.stringify({
      version: this.workspace ? 2 : VERSION,
      ...(this.workspace ? { workspace: this.workspace } : {}),
      posts: [...active, ...finished.slice(0, finishedCount)]
    }, null, 2)
    const limit = Math.min(finished.length, MAX_RECORDS - active.length)
    let low = 0
    let high = limit
    let result: string | null = null
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const payload = encode(middle)
      if (Buffer.byteLength(payload) <= MAX_CACHE_BYTES) {
        result = payload
        low = middle + 1
      } else high = middle - 1
    }
    if (result === null) throw new Error('Active post history exceeds the storage limit. Existing history was preserved.')
    return result
  }

  /** Move a bound legacy file only when it belongs to this workspace. */
  private migrateLegacy(): void {
    if (!this.workspace || existsSync(this.path) || !existsSync(this.filePath)) return
    if (!readableCache(this.filePath, MAX_LEGACY_BYTES)) throw new Error('Legacy post history could not be migrated. The file was preserved.')
    let raw: { version?: unknown; workspace?: unknown; posts?: unknown }
    try { raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) }
    catch { quarantineUnbound(this.filePath); return }
    if (raw.version !== 2 || raw.workspace !== this.workspace) {
      if (raw.version !== 2 || typeof raw.workspace !== 'string') quarantineUnbound(this.filePath)
      return
    }
    const records = Array.isArray(raw.posts) ? raw.posts.map(parsePostRecord).filter((post): post is PostRecord => post !== null) : []
    this.write(records)
    try { renameSync(this.filePath, `${this.filePath}.migrated-${Date.now()}`) }
    catch { /* The scoped copy is already durable; leave the old file for recovery. */ }
  }

  /** Newest first. A damaged file is set aside so the next write can't erase it. */
  list(): PostRecord[] {
    this.migrateLegacy()
    if (!existsSync(this.path)) return []
    try {
      if (!readableCache(this.path, MAX_CACHE_BYTES)) { quarantineUnbound(this.path); return [] }
      const raw = JSON.parse(readFileSync(this.path, 'utf-8')) as { version?: unknown; workspace?: unknown; posts?: unknown }
      if (this.workspace && (raw.version !== 2 || raw.workspace !== this.workspace)) {
        quarantineUnbound(this.path)
        return []
      }
      const posts = Array.isArray(raw.posts) ? raw.posts.map(parsePostRecord).filter((p): p is PostRecord => p !== null) : []
      return posts.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    } catch {
      try { renameSync(this.path, `${this.path}.damaged-${Date.now()}`) } catch { /* Keep going with an empty history. */ }
      return []
    }
  }

  get(id: string): PostRecord | null {
    return this.list().find((post) => post.id === id) ?? null
  }

  private archiveDirectory(): string { return `${this.path}.history` }

  private archivePath(id: string): string {
    return join(this.archiveDirectory(), `${createHash('sha256').update(id).digest('hex')}.json`)
  }

  private checkArchiveDirectory(): boolean {
    try {
      const stat = lstatSync(this.archiveDirectory())
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid history directory')
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw new Error('Saved publishing history is unavailable.')
    }
  }

  private readArchived(file: string): PostRecord {
    // An unreadable record could hide a pending delivery. Fail closed so disk
    // cleanup cannot treat incomplete publishing evidence as safe to delete.
    try {
      if (!readableCache(file, MAX_CACHE_BYTES)) throw new Error('Invalid record file')
      const raw = JSON.parse(readFileSync(file, 'utf-8'))
      const post = parsePostRecord(raw.post)
      if (raw.version !== 1 || raw.workspace !== this.workspace || !post || this.archivePath(post.id) !== file) throw new Error('Invalid record')
      return post
    } catch { throw new Error('Saved publishing history could not be read. Your files have been kept.') }
  }

  private archive(post: PostRecord): void {
    if (!parsePostRecord(post)) throw new Error('Invalid publishing record. Activity was kept.')
    if (!this.checkArchiveDirectory()) mkdirSync(this.archiveDirectory(), { mode: 0o700 })
    const file = this.archivePath(post.id)
    const payload = JSON.stringify({ version: 1, workspace: this.workspace, post })
    if (Buffer.byteLength(payload) > MAX_CACHE_BYTES) throw new Error('Publishing record is too large. Activity was kept.')
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, payload, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
      renameSync(temporary, file)
    } finally { rmSync(temporary, { force: true }) }
  }

  /** Main-only publishing evidence, independent of dismissed or trimmed activity. */
  history(): PostRecord[] {
    const visible = this.list()
    const records = new Map<string, PostRecord>()
    if (this.checkArchiveDirectory()) {
      for (const name of readdirSync(this.archiveDirectory())) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
        const post = this.readArchived(join(this.archiveDirectory(), name))
        records.set(post.id, post)
      }
    }
    // A retried or refreshed activity entry supersedes its archived snapshot.
    for (const post of visible) records.set(post.id, post)
    return [...records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  }

  /** Removing an automation bank copy must preserve its original Library link. */
  relink(id: string, bankPath: string, originalPath: string): void {
    const visible = this.get(id)
    if (visible) {
      if (visible.clipPath === bankPath) this.save({ ...visible, clipPath: originalPath })
    } else if (this.checkArchiveDirectory() && existsSync(this.archivePath(id))) {
      const archived = this.readArchived(this.archivePath(id))
      if (archived.clipPath === bankPath) this.archive({ ...archived, clipPath: originalPath })
    }
  }

  /** Reserve enough room for the largest accepted provider response before creating a remote post. */
  reserveActive(base: PostRecord): () => void {
    const worst: PostRecord = {
      ...base,
      id: 'x'.repeat(64),
      scheduledFor: '2026-09-25T10:00:00.000Z',
      timezone: 'x'.repeat(64),
      status: 'publishing',
      // JSON can escape one UTF-16 code unit as six bytes. Reserve that
      // upper bound for provider strings rather than their character count.
      error: '\0'.repeat(300),
      targets: base.targets.map((target) => ({
        ...target,
        error: '\0'.repeat(300),
        url: '\0'.repeat(2048)
      }))
    }
    this.serialize([...this.list(), ...this.reservations, worst])
    this.reservations.push(worst)
    return () => {
      const index = this.reservations.indexOf(worst)
      if (index !== -1) this.reservations.splice(index, 1)
    }
  }

  private write(posts: PostRecord[], dismissed: PostRecord[] = []): void {
    const payload = this.serialize(posts)
    const retained = new Set<string>((JSON.parse(payload).posts as PostRecord[]).map(post => post.id))
    // Preserve evidence BEFORE removing activity, including on legacy migration
    // and automatic pruning. A failed archive leaves the activity file intact.
    for (const post of [...dismissed, ...posts.filter(post => !retained.has(post.id))]) this.archive(post)
    const tempPath = `${this.path}.${randomUUID()}.tmp`
    try {
      writeFileSync(tempPath, payload, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
      renameSync(tempPath, this.path)
    } finally { rmSync(tempPath, { force: true }) }
  }

  /** Insert or replace records by id. */
  save(...records: PostRecord[]): PostRecord[] {
    const byId = new Map(this.list().map((post) => [post.id, post]))
    for (const record of records) byId.set(record.id, record)
    this.write([...byId.values()])
    return this.list()
  }

  remove(id: string): PostRecord[] {
    const posts = this.list()
    this.write(posts.filter((post) => post.id !== id), posts.filter((post) => post.id === id))
    return this.list()
  }

  clear(): void {
    this.write([], this.list())
  }
}
