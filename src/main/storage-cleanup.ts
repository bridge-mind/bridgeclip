import { createHash, randomUUID } from 'crypto'
import { lstatSync, readdirSync, realpathSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import type { SourceStorageSummary, StorageCleanupItem, StorageCleanupKind, StorageCleanupPreview, StorageCleanupResult } from '../shared/output-storage'
import { loadSettings } from './settings-store'
import { getJobHistory, manualPostedFile } from './file-manager'
import { checkedRun, deleteLibraryClips, deleteLibraryRun, previewLibraryDeletion, readRunJson } from './library-management'
import { editorBusy, freeEditorMedia, readEditorStorage } from './clip-editor'
import { liveJobIds } from './job-manager'
import { publishedCleanupClips } from './library-posting'
import { listAutomations } from './automations'
import { hasActiveUploads, listPosts } from './zernio/posts'

const MAX_PROJECTS = 5000
const MAX_AGE = 15 * 60_000
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const pathKey = (value: string): string => {
  const path = resolve(value.replace(/^file:\/\//, ''))
  return process.platform === 'win32' ? path.toLowerCase() : path
}
const postingStamp = (): string => digest(loadSettings().zernioApiKey ? [listPosts(), listAutomations()] : [])
const busy = (run: string): boolean => liveJobIds().has(basename(run)) || editorBusy(run)

/** Root metadata and file identities guard against edits between preview and confirmation. */
function signature(run: string): string {
  const root = lstatSync(run), canonical = realpathSync(run)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('The Library project changed.')
  const names = readdirSync(run).sort()
  if (names.length > 10_000) throw new Error('This project has too many files to check safely.')
  return digest([canonical, root.dev, root.ino, readRunJson(run, 'job_output.json'), names.map(name => {
    const stat = lstatSync(join(run, name))
    return [name, stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs]
  })])
}

function clipBytes(run: string, indices: number[]): number {
  const files = new Map<string, { bytes: number; links: number; seen: number }>()
  for (const index of indices) {
    const name = `clip_${String(index).padStart(2, '0')}`
    for (const file of [`${name}.mp4`, `${name}.framing.json`, `${name}.srt`, `${name}.youtube.txt`, manualPostedFile(index)]) {
      const path = join(run, file)
      try {
        const stat = lstatSync(path)
        if (!stat.isFile() || stat.isSymbolicLink() || dirname(realpathSync(path)) !== realpathSync(run)) throw new Error('Unsafe clip file.')
        const key = `${stat.dev}:${stat.ino}`, previous = files.get(key)
        if (previous) previous.seen++
        else files.set(key, { bytes: stat.size, links: stat.nlink, seen: 1 })
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
  return [...files.values()].reduce((sum, file) => sum + (file.seen >= file.links ? file.bytes : 0), 0)
}

export async function sourceStorageSummary(): Promise<SourceStorageSummary> {
  const outputDirectory = loadSettings().outputDirectory
  const summary: SourceStorageSummary = { outputDirectory, sourceBytes: 0, previewBytes: 0, projects: 0, readyProjects: 0, readyBytes: 0, unfinishedProjects: 0, unavailableProjects: 0 }
  const history = (await getJobHistory(outputDirectory)).filter(run => run.editorProject)
  summary.unavailableProjects = Math.max(0, history.length - MAX_PROJECTS)
  for (const run of history.slice(0, MAX_PROJECTS)) {
    try {
      const media = readEditorStorage(run.outputDir)
      if (!media.sourceBytes && !media.previewBytes) continue
      summary.projects++
      summary.sourceBytes += media.sourceBytes
      summary.previewBytes += media.previewBytes
      if (media.remaining) summary.unfinishedProjects++
      else if (!busy(run.outputDir)) { summary.readyProjects++; summary.readyBytes += media.reclaimableBytes }
    } catch { summary.unavailableProjects++ }
  }
  if (loadSettings().outputDirectory !== outputDirectory) throw new Error('The output folder changed. Refresh storage.')
  return summary
}

interface Target { item: StorageCleanupItem; run: string; signature: string; indices: number[]; revision?: number }
interface Plan { at: number; outputDirectory: string; library: string; workspace: string; posting: string; kind: StorageCleanupKind; targets: Target[] }
const plans = new Map<string, Plan>()
let cleaning = false

/** The renderer receives opaque IDs, never authority to add paths to a cleanup. */
export async function previewStorageCleanup(kind: unknown): Promise<StorageCleanupPreview> {
  if (kind !== 'published' && kind !== 'sources') throw new Error('Choose a cleanup option.')
  if (cleaning) throw new Error('Wait for the current cleanup to finish.')
  if (kind === 'published' && hasActiveUploads()) throw new Error('Wait for uploads to finish before cleaning published content.')
  const settings = loadSettings(), outputDirectory = settings.outputDirectory
  const history = (await getJobHistory(outputDirectory)).filter(run => run.status === 'completed')
  const runs = history.slice(0, MAX_PROJECTS)
  const posting = kind === 'published' ? postingStamp() : ''
  const baselines = new Map<string, string>()
  if (kind === 'published') for (const run of runs) {
    try { baselines.set(run.outputDir, signature(run.outputDir)) } catch { /* Unreadable projects cannot be cleanup targets. */ }
  }
  const statuses = kind === 'published' ? await publishedCleanupClips(runs.map(run => run.outputDir)) : new Map<string, number[] | null>()
  const automations = kind === 'published' && settings.zernioApiKey ? listAutomations() : []
  const protectedPaths = new Set(automations.flatMap(automation => automation.content.filter(item => item.status !== 'posted' && item.sourceClipPath).map(item => pathKey(item.sourceClipPath!))))
  const targets: Target[] = [], items: StorageCleanupItem[] = []
  let unavailableProjects = Math.max(0, history.length - MAX_PROJECTS)
  for (const entry of runs) {
    if (kind === 'sources' && !entry.editorProject) continue
    try {
      const { check, output } = await checkedRun(entry.outputDir, { allowBusy: true })
      const run = check(), media = output.editor_project ? readEditorStorage(run) : null
      let item: StorageCleanupItem
      let indices: number[] = []
      if (kind === 'sources') {
        if (!media || !media.sourceBytes && !media.previewBytes) continue
        item = { id: randomUUID(), title: entry.videoTitle, kind: 'source', bytes: media.reclaimableBytes, clipCount: 0, partial: false,
          ...(media.remaining ? { keepReason: `${media.remaining} ${media.remaining === 1 ? 'clip' : 'clips'} still to finish` } : busy(run) ? { keepReason: 'Project in use' } : {}) }
      } else {
        if (baselines.get(run) !== signature(run)) throw new Error('Project changed while checking posted status.')
        const eligible = statuses.get(run)
        if (!eligible) { unavailableProjects++; continue }
        indices = eligible.filter(index => {
          const clip = output.clips.find(clip => clip.clip_index === index)
          return clip && !protectedPaths.has(pathKey(clip.s3_url))
        })
        if (!indices.length) continue
        if (busy(run)) { unavailableProjects++; continue }
        // Only fully delivered, finished projects can lose their entire folder.
        const wholeRun = indices.length === output.clips.length && (!media || media.remaining === 0)
        const before = signature(run)
        const estimate = wholeRun ? await previewLibraryDeletion(run) : null
        if (signature(run) !== before) throw new Error('Project changed while counting.')
        item = { id: randomUUID(), title: entry.videoTitle, kind: wholeRun ? 'run' : 'clips', bytes: estimate?.bytes ?? clipBytes(run, indices), clipCount: indices.length, partial: estimate?.partial ?? false }
      }
      check()
      items.push(item)
      if (!item.keepReason) targets.push({ item, run, indices, signature: signature(run), revision: media?.revision })
    } catch { unavailableProjects++ }
  }
  if (loadSettings().outputDirectory !== outputDirectory || loadSettings().zernioApiKey !== settings.zernioApiKey || kind === 'published' && postingStamp() !== posting) throw new Error('The Library changed while checking. Try again.')
  const token = randomUUID()
  // Missing/empty libraries still have a useful empty preview, but no delete authority.
  const library = targets.length ? realpathSync(outputDirectory) : outputDirectory
  for (const [id, plan] of plans) if (Date.now() - plan.at > MAX_AGE) plans.delete(id)
  while (plans.size >= 3) plans.delete(plans.keys().next().value!)
  plans.set(token, { at: Date.now(), outputDirectory, library, workspace: settings.zernioApiKey, posting, kind, targets })
  return { token, outputDirectory, kind, items, unavailableProjects }
}

export async function cleanStoredContent(token: unknown, ids: unknown): Promise<StorageCleanupResult> {
  const plan = typeof token === 'string' ? plans.get(token) : undefined
  if (!plan || Date.now() - plan.at > MAX_AGE) throw new Error('This cleanup preview expired. Review it again.')
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_PROJECTS || !ids.every(id => typeof id === 'string' && plan.targets.some(target => target.item.id === id)) || new Set(ids).size !== ids.length) throw new Error('Select projects from this cleanup preview.')
  if (cleaning) throw new Error('Wait for the current cleanup to finish.')
  const contextCurrent = (): boolean => loadSettings().outputDirectory === plan.outputDirectory && realpathSync(plan.outputDirectory) === plan.library && loadSettings().zernioApiKey === plan.workspace && (plan.kind !== 'published' || !hasActiveUploads() && postingStamp() === plan.posting)
  if (!contextCurrent()) throw new Error('The Library or posting status changed. Review the cleanup again.')
  cleaning = true
  plans.delete(token as string)
  const result: StorageCleanupResult = { cleaned: 0, skipped: 0, failed: 0 }
  try {
    for (const target of plan.targets.filter(target => ids.includes(target.item.id))) {
      let changed = false
      const guard = (ownEditorOperation = false): void => {
        if (!contextCurrent() || liveJobIds().has(basename(target.run)) || !ownEditorOperation && editorBusy(target.run) || signature(target.run) !== target.signature) {
          changed = true
          throw new Error('This project changed after the preview.')
        }
      }
      try {
        guard()
        if (target.item.kind === 'source') {
          await freeEditorMedia(target.run, target.revision, () => guard(true))
          const remaining = readEditorStorage(target.run)
          if (remaining.sourceBytes || remaining.previewBytes) throw new Error('Some source files could not be removed.')
        } else if (target.item.kind === 'run') {
          if (!await deleteLibraryRun(target.run, () => guard())) throw new Error('Some project files could not be removed yet.')
        }
        else await deleteLibraryClips(target.run, target.indices, { beforeDelete: () => guard(), keepFinishedCandidates: true })
        result.cleaned++
      } catch { if (changed) result.skipped++; else result.failed++ }
    }
  } finally { cleaning = false }
  return result
}
