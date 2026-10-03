import { editorBusy } from './clip-editor'
import { randomUUID } from 'crypto'
import { closeSync, constants, type Dirent, fstatSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { readdir, rm } from 'fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { DELETING_RUN_PREFIX, getJobOutput, isManuallyPosted, isRunFavorite, LIBRARY_FAVORITE_FILE, manualPostedFile, removeRunThumbnails } from './file-manager'
import { logger } from './logger'
import { parseJobOutput, type JobOutput } from '../shared/job-output'
import { parseEditorProject } from '../shared/clip-editor'
import { dismissJob, liveJobIds } from './job-manager'
import { loadSettings } from './settings-store'
import { scanOutputStorage, STORAGE_SCAN_LIMITS } from './output-storage'
import type { LibraryDeletionPreview, OutputStorageUsage } from '../shared/output-storage'

/** Only a completed, immediate child of the configured Library can be changed. */
export async function checkedRun(raw: unknown, { allowBusy = false }: { allowBusy?: boolean } = {}): Promise<{ check: () => string; output: JobOutput; library: string; identity: { dev: number; ino: number } }> {
  const librarySetting = loadSettings().outputDirectory
  if (typeof raw !== 'string' || !isAbsolute(raw) || raw.includes('\0')) throw new Error('Choose a run in your Library.')
  const library = realpathSync(librarySetting)
  const path = resolve(raw)
  const original = lstatSync(path)
  const canonical = realpathSync(path)
  const check = (): string => {
    const current = lstatSync(path)
    if (loadSettings().outputDirectory !== librarySetting || realpathSync(librarySetting) !== library ||
        !current.isDirectory() || current.isSymbolicLink() || realpathSync(path) !== canonical ||
        dirname(canonical) !== library || realpathSync(dirname(path)) !== library ||
        current.dev !== original.dev || current.ino !== original.ino) throw new Error('The Library run changed. Refresh and try again.')
    if (!allowBusy && editorBusy(path)) throw new Error('Wait for the editor to finish before changing this run.')
    if (!allowBusy && liveJobIds().has(basename(path))) throw new Error('Wait for this run to finish before changing it.')
    return path
  }
  check()
  const output = await getJobOutput(path, library)
  if (!output) throw new Error('This completed run is no longer available in your Library.')
  check()
  return { check, output, library, identity: { dev: original.dev, ino: original.ino } }
}

/** Total local file size for a Library card; reading is safe while an editor is open. */
export async function libraryStorageUsage(outputDir: unknown): Promise<OutputStorageUsage> {
  const { check } = await checkedRun(outputDir, { allowBusy: true })
  const usage = await scanOutputStorage(check())
  check()
  return usage
}

/** Fresh, read-only estimate of the same folder that run deletion removes. */
export async function previewLibraryDeletion(outputDir: unknown): Promise<LibraryDeletionPreview> {
  const { check, output } = await checkedRun(outputDir)
  const path = check()
  const usage = await scanOutputStorage(path, STORAGE_SCAN_LIMITS, { reclaimable: true })
  check()
  if (!usage.exists) throw new Error('This Library folder is no longer available.')
  return { outputDirectory: path, bytes: usage.bytes, fileCount: usage.fileCount, clipCount: output.clips.length,
    partial: Boolean(usage.truncated || usage.unreadableCount) }
}

export async function setLibraryFavorite(outputDir: unknown, favorite: unknown): Promise<boolean> {
  if (typeof favorite !== 'boolean') throw new Error('Choose a valid favorite value.')
  const { check } = await checkedRun(outputDir)
  const path = check()
  const marker = join(path, LIBRARY_FAVORITE_FILE)
  if (favorite) {
    if (!isRunFavorite(path)) writeFileSync(marker, '', { flag: 'wx', mode: 0o600 })
  } else {
    try { unlinkSync(marker) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return favorite
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const isDeletingRun = (name: string): boolean => name.startsWith(DELETING_RUN_PREFIX) && UUID.test(name.slice(DELETING_RUN_PREFIX.length))

export async function deleteLibraryRun(outputDir: unknown, beforeDelete?: () => void): Promise<boolean> {
  const { check, output, library, identity } = await checkedRun(outputDir)
  beforeDelete?.()
  removeRunThumbnails(check(), output)
  // Rename right after the final check (no await in between), then delete.
  // The Library never lists a half-deleted run, a locked file on Windows
  // fails the rename before anything is removed, and a crash leaves a hidden
  // folder that the next startup finishes removing.
  const path = check()
  const trash = join(library, `${DELETING_RUN_PREFIX}${randomUUID()}`)
  renameSync(path, trash)
  const moved = lstatSync(trash)
  if (!moved.isDirectory() || moved.isSymbolicLink() || moved.dev !== identity.dev || moved.ino !== identity.ino) {
    try { renameSync(trash, path) } catch { /* Best effort: it is still a folder directly inside the Library. */ }
    throw new Error('The Library run changed. Refresh and try again.')
  }
  dismissJob(basename(path))
  // Never follow the manifest's media paths. Remove only this validated run
  // directory; recursive rm unlinks internal symlinks rather than their targets.
  try { rmSync(trash, { recursive: true }) } catch {
    logger.warn('library.delete.cleanup_deferred', { message: 'Some run files could not be removed; they will be removed at the next start.' })
    return false
  }
  return true
}

/**
 * Finish run deletions interrupted by a crash or a locked file. Only real
 * directories named .deleting-<uuid> directly inside the Library are removed.
 */
export async function sweepDeletingRuns(): Promise<void> {
  let library: string
  try { library = realpathSync(loadSettings().outputDirectory) } catch { return }
  let entries: Dirent[]
  try { entries = await readdir(library, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (!isDeletingRun(entry.name) || !entry.isDirectory()) continue
    const path = join(library, entry.name)
    try {
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || dirname(realpathSync(path)) !== library) continue
      await rm(path, { recursive: true })
    } catch {
      logger.warn('library.delete.sweep_failed', { message: 'A run left from an interrupted deletion could not be removed yet.' })
    }
  }
}

export async function setLibraryPosted(outputDir: unknown, clipIndex: unknown, posted: unknown): Promise<boolean> {
  if (!Number.isSafeInteger(clipIndex) || (clipIndex as number) < 0 || (clipIndex as number) > 999 || typeof posted !== 'boolean') {
    throw new Error('Choose a clip and a valid posted status.')
  }
  const { check } = await checkedRun(outputDir)
  const run = check()
  const output = parseJobOutput(readRunJson(run, 'job_output.json'))
  if (!output?.clips.some((clip) => clip.clip_index === clipIndex)) throw new Error('This clip is no longer in the run.')
  const marker = join(run, manualPostedFile(clipIndex as number))
  if (posted) {
    if (!isManuallyPosted(run, clipIndex as number)) writeFileSync(marker, '', { flag: 'wx', mode: 0o600 })
  } else {
    try { unlinkSync(marker) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return posted
}

/** Keep the complete persisted metadata, including fields not exposed to React. */
export function readRunJson(run: string, name: string): Record<string, unknown> {
  const path = join(run, name)
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const file = fstatSync(fd), current = lstatSync(path)
    if (!file.isFile() || current.isSymbolicLink() || file.dev !== current.dev || file.ino !== current.ino ||
        file.size > 32 * 1024 * 1024 || dirname(realpathSync(path)) !== realpathSync(run)) throw new Error('Invalid Library metadata.')
    const bytes = Buffer.alloc(file.size + 1)
    let used = 0, count = 0
    do { count = readSync(fd, bytes, used, bytes.length - used, null); used += count } while (count && used < bytes.length)
    if (used !== file.size) throw new Error('Library metadata changed. Refresh and retry.')
    const data = JSON.parse(bytes.subarray(0, used).toString('utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid Library metadata.')
    return data
  } finally { closeSync(fd) }
}

export async function deleteLibraryClips(outputDir: unknown, indices: unknown, { beforeDelete, keepFinishedCandidates = false }: { beforeDelete?: () => void; keepFinishedCandidates?: boolean } = {}): Promise<JobOutput> {
  if (!Array.isArray(indices) || indices.length === 0 || indices.length > 1000 ||
      indices.some((id) => !Number.isSafeInteger(id) || id < 0 || id > 999) || new Set(indices).size !== indices.length) {
    throw new Error('Select clips from this Library run to delete.')
  }
  const { check } = await checkedRun(outputDir)
  const run = check(), canonical = realpathSync(run)
  // No awaits below: re-read after validation so overlapping requests cannot
  // overwrite a newer manifest or race an editor operation in this process.
  const raw = readRunJson(run, 'job_output.json'), output = parseJobOutput(raw)
  if (!output) throw new Error('Invalid Library metadata.')
  const selected = new Set<number>(indices)
  const picked = output.clips.filter((clip) => selected.has(clip.clip_index))
  if (picked.length !== selected.size) throw new Error('Some selected clips are no longer in this run. Refresh and retry.')
  const files: string[] = []
  const include = (file: string): void => {
    try {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || dirname(realpathSync(file)) !== canonical) throw new Error('The selected clip has an unsafe file path.')
      files.push(file)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  for (const clip of picked) {
    const file = resolve(clip.s3_url.replace(/^file:\/\//, ''))
    const name = `clip_${String(clip.clip_index).padStart(2, '0')}`
    // Derive the allowed filename from its ID; a forged manifest cannot delete
    // source media, editor previews, metadata or another run's files.
    if (basename(file) !== `${name}.mp4` || realpathSync(dirname(file)) !== canonical) throw new Error('The selected clip is outside its Library run.')
    include(file)
    // Sidecars written next to each clip: framing, captions and upload notes.
    for (const suffix of ['.framing.json', '.srt', '.youtube.txt']) include(join(run, `${name}${suffix}`))
    include(join(run, manualPostedFile(clip.clip_index)))
  }
  const changes: [string, Record<string, unknown>][] = []
  if (output.editor_project) {
    const project = readRunJson(run, 'editor-project.json')
    parseEditorProject(project)
    for (const c of project.candidates as Record<string, unknown>[]) {
      const previous = c.exports as number[]
      c.exports = previous.filter((id) => !selected.has(id))
      // Earlier exports may describe older edits. Removing the latest bake
      // means the current edit needs rendering again, even if older copies remain.
      // Published-content cleanup removes a delivered export, not its completed
      // editing work. Ordinary clip deletion still asks for a fresh bake.
      if (!keepFinishedCandidates && c.status === 'baked' && previous.length && selected.has(previous[previous.length - 1])) c.status = 'ready'
    }
    project.revision = (project.revision as number) + 1
    changes.push(['editor-project.json', project])
  }
  // IDs are permanent provenance for posts and automation bank copies. Never
  // recycle a deleted export's ID, even after deleting every clip in a run.
  raw.next_clip_index = Math.max(Number.isSafeInteger(raw.next_clip_index) ? raw.next_clip_index as number : 0,
    ...output.clips.map((clip) => clip.clip_index + 1))
  raw.clips = (raw.clips as { clip_index: number }[]).filter((clip) => !selected.has(clip.clip_index))
  raw.total_clips = (raw.clips as unknown[]).length
  changes.push(['job_output.json', raw])
  check()
  beforeDelete?.()
  removeRunThumbnails(run, { ...output, clips: picked })
  const staging = mkdtempSync(join(run, '.delete-clips-'))
  const moved: [string, string][] = [], installed: string[] = []
  try {
    for (const [name, value] of changes) writeFileSync(join(staging, `new-${name}`), JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    for (const file of files) {
      const destination = join(staging, basename(file))
      renameSync(file, destination); moved.push([file, destination])
    }
    for (const [name] of changes) {
      const path = join(run, name), backup = join(staging, name)
      renameSync(path, backup); moved.push([path, backup])
      renameSync(join(staging, `new-${name}`), path); installed.push(path)
    }
  } catch (error) {
    try {
      for (const path of installed.reverse()) unlinkSync(path)
      for (const [path, backup] of moved.reverse()) renameSync(backup, path)
      rmSync(staging, { recursive: true })
    } catch { throw new Error('Deletion failed and could not be fully restored. The recovery files remain in the run folder. Reopen the Library to check its files.') }
    throw error
  }
  // Metadata now references only the retained clips. Do not roll back after
  // cleanup starts, since some deleted files may already have been removed.
  try { rmSync(staging, { recursive: true }) } catch { throw new Error('Clips were removed from the Library, but some files could not be cleaned up in the run folder.') }
  return parseJobOutput(raw)!
}
