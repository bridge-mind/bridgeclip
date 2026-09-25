import { app } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { open, unlink } from 'fs/promises'
import { basename, extname, join } from 'path'
import { pipeline } from 'stream/promises'
import { AUTOMATION_PLATFORMS, dueSlots, nextAutomationContent, type Automation, type AutomationAccount, type AutomationContent, type AutomationUpdate, type AutomationTikTokReview, type AutomationTikTokReviewUpdate, type GeneratedPlatformMetadata } from '../shared/automations'
import { isPostableAccount, isZernioId, type ZernioOverview } from '../shared/zernio'
import { checkCaption, checkClip, defaultFacebookFormat, isValidTimeZone, tiktokOptionsError, youtubeTitleFor, type PostClipRequest } from '../shared/zernio-posts'
import { loadSettings } from './settings-store'
import { assertMediaPath, authorizeMedia, isWithinDirectory, openAuthorizedMedia } from './security'
import { getJobOutput } from './file-manager'
import { getZernioOverview, readCachedOverview } from './zernio/service'
import { getTikTokCreatorInfo, probeClipForPosting, publishClip } from './zernio/posts'
import { parsePostClipRequest, parseTikTokOptions } from './zernio/posts-payload'
import { workspaceId } from './zernio/workspace-cache'
import { logger } from './logger'
import { generateAutomationMetadata, transcribeAutomationClip } from './automation-metadata'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm'])
const MAX_FILE_BYTES = 5 * 1024 ** 3
const MAX_STORE_BYTES = 32 * 1024 * 1024
const MAX_AUTOMATIONS = 100
const MAX_CONTENT = 500

let cachedWorkspace: string | null = null
let cached: Automation[] = []
const busy = new Set<string>()
// One review per bank item; a newer preview replaces the previous one.
const reviews = new Map<string, { id: string; fingerprint: string }>()

function fileStamp(path: string): { size: number; mtimeMs: number; ino: number } {
  const { size, mtimeMs, ino } = statSync(path)
  return { size, mtimeMs, ino }
}

function sameFileStamp(a: ReturnType<typeof fileStamp>, b: ReturnType<typeof fileStamp>): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino
}

function clearTikTokReview(item: AutomationContent): void {
  item.tiktokApproval = null
  item.tiktokDraftCaption = null
  reviews.delete(item.id)
}

function assertApprovedFile(item: AutomationContent, path: string): void {
  if (item.tiktokApproval && !sameFileStamp(item.tiktokApproval.fileStamp, fileStamp(path))) {
    clearTikTokReview(item)
    item.transcript = null
    item.generatedMetadata = null
    throw new Error('The clip file changed. Review it for TikTok again before posting.')
  }
}

function reviewFingerprint(workspace: string, automation: Automation, item: AutomationContent): string {
  return createHash('sha256').update(JSON.stringify({ workspace, automationId: automation.id,
    profileId: automation.profileId, accounts: automation.accounts, metadataMode: automation.metadataMode,
    itemId: item.id, title: item.title, caption: item.caption, generatedMetadata: item.generatedMetadata,
    file: fileStamp(join(bankPath(workspace, automation.id), item.fileName)) })).digest('hex')
}

function validTikTokApproval(item: AutomationContent): boolean {
  const approval = item.tiktokApproval
  if (approval == null) return true
  if (!approval || typeof approval !== 'object' || typeof approval.caption !== 'string' || !approval.caption.trim() ||
      approval.caption.includes('\0') || checkCaption('tiktok', approval.caption).error ||
      typeof approval.reviewedAt !== 'string' || !Number.isFinite(Date.parse(approval.reviewedAt))) return false
  if (!approval.fileStamp || ![approval.fileStamp.size, approval.fileStamp.mtimeMs, approval.fileStamp.ino].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return false
  const options = approval.options
  if (!options || typeof options !== 'object' || !options.accounts || typeof options.accounts !== 'object' || Array.isArray(options.accounts)) return false
  const ids = Object.keys(options.accounts)
  if (!ids.length || ids.length > 20 || !ids.every(isZernioId) || options.consent !== true) return false
  return (['disclose', 'yourBrand', 'brandedContent', 'madeWithAi', 'draft'] as const).every((key) => typeof options[key] === 'boolean') &&
    ids.every((id) => {
      const account = options.accounts[id]
      return account && typeof account.privacyLevel === 'string' && /^[A-Z_]{1,64}$/.test(account.privacyLevel) &&
        (['allowComment', 'allowDuet', 'allowStitch'] as const).every((key) => typeof account[key] === 'boolean')
    })
}

function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.length > 80 || Array.from(name).some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) {
    throw new Error('Use a name of up to 80 characters.')
  }
  return name
}

function currentWorkspace(): string {
  const key = loadSettings().zernioApiKey
  if (!key) throw new Error('Connect a Zernio account before creating automations.')
  return workspaceId(key)
}

function dataPath(workspace: string): string { return join(app.getPath('userData'), `automations-${workspace}.json`) }
function bankPath(workspace: string, automationId: string): string { return join(app.getPath('userData'), 'automation-bank', workspace, automationId) }

function validContent(value: unknown): value is AutomationContent {
  if (!value || typeof value !== 'object') return false
  const item = value as AutomationContent
  return UUID.test(item.id) && (item.postingAttemptId === undefined || (typeof item.postingAttemptId === 'string' && UUID.test(item.postingAttemptId))) && typeof item.fileName === 'string' &&
    item.fileName === `${item.id}${extname(item.fileName)}` && VIDEO_EXTENSIONS.has(extname(item.fileName)) &&
    typeof item.title === 'string' && item.title.length <= 500 &&
    typeof item.caption === 'string' && item.caption.length <= 63_206 &&
    (item.transcript === null || (typeof item.transcript === 'string' && item.transcript.length <= 20_000)) &&
    (item.generatedMetadata === null || (Array.isArray(item.generatedMetadata) && item.generatedMetadata.length <= AUTOMATION_PLATFORMS.length &&
      item.generatedMetadata.every((post: GeneratedPlatformMetadata) => post && AUTOMATION_PLATFORMS.includes(post.platform) &&
        typeof post.caption === 'string' && post.caption.length <= 63_206 && (post.title === null || typeof post.title === 'string') &&
        (post.categoryId === null || typeof post.categoryId === 'string') && (post.topicTag === undefined || post.topicTag === null || typeof post.topicTag === 'string') &&
        Array.isArray(post.tags) && post.tags.length <= 8 && post.tags.every((tag) => typeof tag === 'string' && tag.length <= 100)))) &&
    validTikTokApproval(item) &&
    (item.tiktokDraftCaption == null || (typeof item.tiktokDraftCaption === 'string' && !item.tiktokDraftCaption.includes('\0') && !checkCaption('tiktok', item.tiktokDraftCaption).error)) &&
    ['queued', 'posting', 'posted', 'needs_review'].includes(item.status) &&
    typeof item.addedAt === 'string' && Number.isFinite(Date.parse(item.addedAt)) &&
    (item.postedAt === null || typeof item.postedAt === 'string') &&
    (item.postId === null || isZernioId(item.postId)) &&
    (item.error === null || typeof item.error === 'string')
}

function validAutomation(value: unknown): value is Automation {
  if (!value || typeof value !== 'object') return false
  const item = value as Automation
  return UUID.test(item.id) && typeof item.name === 'string' && item.name.length <= 80 &&
    typeof item.enabled === 'boolean' && (item.profileId === null || isZernioId(item.profileId)) &&
    (item.metadataMode === 'ai' || item.metadataMode === 'manual') &&
    Array.isArray(item.accounts) && item.accounts.length <= 20 &&
    item.accounts.every((account) => account && isZernioId(account.accountId) && AUTOMATION_PLATFORMS.includes(account.platform)) &&
    Array.isArray(item.times) && item.times.length <= 24 && item.times.every((time) => typeof time === 'string' && TIME.test(time)) &&
    isValidTimeZone(item.timezone) && ['public', 'unlisted', 'private'].includes(item.youtubeVisibility) && typeof item.youtubeMadeForKids === 'boolean' &&
    item.lastSlots && typeof item.lastSlots === 'object' && !Array.isArray(item.lastSlots) &&
    Array.isArray(item.content) && item.content.length <= MAX_CONTENT && item.content.every(validContent) &&
    typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt)) &&
    (item.lastRunAt === null || typeof item.lastRunAt === 'string') &&
    (item.lastError === null || typeof item.lastError === 'string')
}

function data(): { workspace: string; automations: Automation[] } {
  const workspace = currentWorkspace()
  if (cachedWorkspace !== workspace) {
    const path = dataPath(workspace)
    let migrated = false
    if (!existsSync(path)) cached = []
    else {
      const file = statSync(path)
      if (!file.isFile() || file.size > MAX_STORE_BYTES) throw new Error('Automation data could not be read. The file was preserved for recovery.')
      try {
        const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
        const record = value as { version?: unknown; workspace?: unknown; automations?: unknown }
        if (![1, 2, 3].includes(Number(record.version)) || record.workspace !== workspace || !Array.isArray(record.automations) ||
            record.automations.length > MAX_AUTOMATIONS) throw new Error('Invalid automation data')
        if (record.version === 1 || record.version === 2) {
          const known = readCachedOverview()?.accounts ?? []
          cached = record.automations.map((value: unknown) => {
            const old = value as Automation
            const profileIds = record.version === 1 ? old.accounts?.map((account) => known.find((item) => item.id === account.accountId && item.platform === account.platform)?.profileId) : []
            const profileId = record.version === 1 ? (profileIds?.length && profileIds.every((id) => id && id === profileIds[0]) ? profileIds[0] ?? null : null) : old.profileId
            return { ...old, profileId, metadataMode: 'manual' as const,
              content: old.content.map((item) => ({ ...item, transcript: null, generatedMetadata: null })),
              accounts: profileId ? old.accounts : [], enabled: profileId ? old.enabled : false,
              lastError: !profileId && old.accounts?.length ? 'Choose one Zernio profile and reselect its accounts.' : old.lastError }
          })
          migrated = true
        } else cached = record.automations
        if (!cached.every(validAutomation)) throw new Error('Invalid automation data')
      } catch {
        throw new Error('Automation data could not be read. The file was preserved for recovery.')
      }
    }
    // A publishing reservation left by a crash needs a person to verify its result.
    let recovered = false
    for (const automation of cached) for (const item of automation.content) {
      if (item.status === 'posting') {
        item.status = 'needs_review'
        item.error = 'BridgeClip closed while posting. Check Zernio before returning this clip to the queue.'
        recovered = true
      } else if (item.status === 'needs_review' && !item.postId &&
          (item.error === 'The upload was interrupted. Check your connection and try again.' ||
            item.error === 'The upload stalled. Check your connection and try again.')) {
        // These errors happen before Zernio receives a post request. Older
        // versions kept the clip in review even though it is safe to retry.
        item.status = 'queued'
        recovered = true
      }
    }
    cachedWorkspace = workspace
    if (recovered || migrated) save(workspace)
  }
  return { workspace, automations: cached }
}

function save(workspace: string): void {
  // Async imports and posts can resume after a key switch has loaded another
  // workspace into the module-level cache. Never write that cache to a stale path.
  if (cachedWorkspace !== workspace || currentWorkspace() !== workspace) {
    throw new Error('The Zernio workspace changed. Please try again.')
  }
  const path = dataPath(workspace)
  mkdirSync(app.getPath('userData'), { recursive: true, mode: 0o700 })
  const payload = JSON.stringify({ version: 3, workspace, automations: cached })
  if (Buffer.byteLength(payload) > MAX_STORE_BYTES) throw new Error('Automation data limit reached.')
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, payload, { flag: 'wx', mode: 0o600 })
    renameSync(temp, path)
  } finally { rmSync(temp, { force: true }) }
}

function find(id: unknown): { workspace: string; automation: Automation } {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Invalid automation')
  const { workspace, automations } = data()
  const automation = automations.find((item) => item.id === id)
  if (!automation) throw new Error('Automation not found')
  return { workspace, automation }
}

function validatedUpdate(raw: unknown): AutomationUpdate {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid automation settings')
  const value = raw as AutomationUpdate
  const name = cleanName(value.name)
  if (typeof value.enabled !== 'boolean' || !isValidTimeZone(value.timezone)) throw new Error('Invalid automation settings')
  if (value.metadataMode !== 'ai' && value.metadataMode !== 'manual') throw new Error('Choose how automation metadata is prepared.')
  if (value.profileId !== null && !isZernioId(value.profileId)) throw new Error('Choose one Zernio profile.')
  if (!['public', 'unlisted', 'private'].includes(value.youtubeVisibility) || typeof value.youtubeMadeForKids !== 'boolean') throw new Error('Choose YouTube visibility and audience.')
  if (!Array.isArray(value.accounts) || value.accounts.length > 20 || !value.accounts.every((account: AutomationAccount) =>
    account && isZernioId(account.accountId) && AUTOMATION_PLATFORMS.includes(account.platform))) throw new Error('Choose valid accounts.')
  const accounts = [...new Map(value.accounts.map((account) => [account.accountId, account])).values()]
  if (!value.profileId && accounts.length > 0) throw new Error('Choose one Zernio profile before selecting accounts.')
  if (!Array.isArray(value.times) || value.times.length > 24 || !value.times.every((time: string) => TIME.test(time))) throw new Error('Use valid daily times.')
  const times = [...new Set(value.times)].sort()
  if (value.enabled && (!value.profileId || accounts.length === 0 || times.length === 0)) throw new Error('Choose a profile, an account in it, and at least one daily time before enabling.')
  if (value.enabled && value.metadataMode === 'ai') {
    const settings = loadSettings()
    if (!settings.openrouterApiKey) throw new Error('Add an OpenRouter API key in Settings before enabling automatic metadata.')
  }
  return { name, enabled: value.enabled, profileId: value.profileId, metadataMode: value.metadataMode, accounts, times, timezone: value.timezone, youtubeVisibility: value.youtubeVisibility, youtubeMadeForKids: value.youtubeMadeForKids }
}

function checkProfileAccounts(overview: ZernioOverview, profileId: string, accounts: AutomationAccount[]): void {
  const profile = overview.profiles.find((item) => item.id === profileId)
  if (!profile) throw new Error('The selected Zernio profile is no longer available. Choose another profile.')
  if (profile.isOverLimit) throw new Error('The selected Zernio profile is over its account limit.')
  for (const selected of accounts) {
    const account = overview.accounts.find((item) => item.id === selected.accountId && item.platform === selected.platform)
    if (!account || account.profileId !== profileId) throw new Error('A selected account is no longer in this Zernio profile. Review its accounts.')
    if (!isPostableAccount(account)) throw new Error('A selected account needs reconnection. Check Accounts before the next run.')
  }
}

export function listAutomations(): Automation[] { return structuredClone(data().automations) }

/** Recognize only a recorded bank file in the current workspace. */
export function isAutomationMedia(path: unknown): path is string {
  if (typeof path !== 'string') return false
  try {
    const { workspace, automations } = data()
    const automation = automations.find((entry) => entry.content.some((item) =>
      path === join(bankPath(workspace, entry.id), item.fileName)
    ))
    if (!automation || lstatSync(path).isSymbolicLink()) return false
    const directory = bankPath(workspace, automation.id)
    return !lstatSync(directory).isSymbolicLink() && isWithinDirectory(path, directory) && isWithinDirectory(path, app.getPath('userData'))
  } catch { return false }
}

export function createAutomation(rawName: unknown): Automation[] {
  const name = cleanName(rawName)
  const { workspace, automations } = data()
  if (automations.length >= MAX_AUTOMATIONS) throw new Error('Automation limit reached.')
  const item: Automation = {
    id: randomUUID(), name, enabled: false, profileId: null, metadataMode: 'manual', accounts: [], times: [],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', youtubeVisibility: 'public', youtubeMadeForKids: false,
    lastSlots: {}, content: [],
    createdAt: new Date().toISOString(), lastRunAt: null, lastError: null
  }
  automations.unshift(item)
  save(workspace)
  return listAutomations()
}

export async function updateAutomation(id: unknown, raw: unknown): Promise<Automation[]> {
  const { workspace, automation } = find(id)
  if (busy.has(automation.id)) throw new Error('Wait for the current operation to finish.')
  const update = validatedUpdate(raw)
  if (update.profileId) checkProfileAccounts(await getZernioOverview(), update.profileId, update.accounts)
  if (currentWorkspace() !== workspace || !cached.includes(automation) || busy.has(automation.id)) throw new Error('Automation changed while saving. Try again.')
  const previous = { ...automation, content: automation.content.map((item) => ({ ...item })) }
  const previousReviews = new Map(automation.content.map((item) => [item.id, reviews.get(item.id)]))
  try {
    if (automation.profileId !== update.profileId || automation.metadataMode !== update.metadataMode ||
        JSON.stringify(automation.accounts.filter((account) => account.platform === 'tiktok').map((account) => account.accountId).sort()) !==
        JSON.stringify(update.accounts.filter((account) => account.platform === 'tiktok').map((account) => account.accountId).sort())) {
      for (const item of automation.content) if (item.status !== 'posted') clearTikTokReview(item)
    }
    Object.assign(automation, update, { lastSlots: Object.fromEntries(Object.entries(automation.lastSlots).filter(([time]) => update.times.includes(time))) })
    save(workspace)
  } catch (error) {
    Object.assign(automation, previous)
    for (const [contentId, review] of previousReviews) if (review) reviews.set(contentId, review)
    throw error
  }
  return listAutomations()
}

export function deleteAutomation(id: unknown): Automation[] {
  const { workspace, automation } = find(id)
  if (busy.has(automation.id)) throw new Error('Wait for the current post to finish.')
  for (const item of automation.content) reviews.delete(item.id)
  cached = cached.filter((item) => item.id !== automation.id)
  save(workspace)
  rmSync(bankPath(workspace, automation.id), { recursive: true, force: true })
  return listAutomations()
}

export async function addLibraryClipsToAutomation(id: unknown, outputDir: unknown, clipIndices: unknown): Promise<Automation[]> {
  const library = loadSettings().outputDirectory
  if (typeof outputDir !== 'string' || !isWithinDirectory(outputDir, library)) throw new Error('Run is outside the library.')
  if (!Array.isArray(clipIndices) || clipIndices.length === 0 || clipIndices.length > 30 ||
      !clipIndices.every((index) => Number.isSafeInteger(index) && index >= 0) ||
      new Set(clipIndices).size !== clipIndices.length) throw new Error('Choose up to 30 unique clips.')
  const output = await getJobOutput(outputDir, library)
  if (!output) throw new Error('This run is no longer available in the library.')
  const clips = clipIndices.map((index) => output.clips.find((clip) => clip.clip_index === index))
  if (clips.some((clip) => !clip)) throw new Error('A selected clip is no longer in this run.')
  const paths = clips.map((clip) => {
    const url = clip!.s3_url
    const path = url.startsWith('file://') ? url.slice('file://'.length) : url
    if (!isWithinDirectory(path, outputDir)) throw new Error('A selected clip is outside this run.')
    assertMediaPath(path, library)
    return path
  })
  const titles = clips.map((clip) => clip!.summary || `Clip ${clip!.clip_index + 1}`)
  return addAutomationContent(id, paths, titles)
}

export async function addAutomationContent(id: unknown, paths: string[], titles?: readonly string[]): Promise<Automation[]> {
  const { workspace, automation } = find(id)
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 30 || automation.content.length + paths.length > MAX_CONTENT) throw new Error('Choose up to 30 clips at a time.')
  if (busy.has(automation.id)) throw new Error('Wait for the current operation to finish.')
  busy.add(automation.id)
  const directory = bankPath(workspace, automation.id)
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    for (const [index, path] of paths.entries()) {
      if (currentWorkspace() !== workspace || !cached.includes(automation)) throw new Error('Automation changed while adding content.')
      // A caller must already have selected this file in the native picker or
      // proved that it belongs to the output library. Never grant access here.
      assertMediaPath(path, loadSettings().outputDirectory)
      const source = await openAuthorizedMedia(path, loadSettings().outputDirectory)
      const extension = extname(source.canonical).toLowerCase()
      const itemId = randomUUID()
      const fileName = `${itemId}${extension}`
      const dest = join(directory, fileName)
      try {
        if (currentWorkspace() !== workspace || cachedWorkspace !== workspace || !cached.includes(automation)) {
          throw new Error('Automation changed while adding content.')
        }
        if (!VIDEO_EXTENSIONS.has(extension)) throw new Error('Use MP4, MOV, M4V or WebM clips.')
        if (source.size === 0 || source.size > MAX_FILE_BYTES) throw new Error('Clips must be between 1 byte and 5 GB.')
        const target = await open(dest, 'wx', 0o600)
        try { await pipeline(source.handle.createReadStream({ autoClose: false }), createWriteStream('', { fd: target.fd, autoClose: false })) }
        finally { await target.close() }
        if (currentWorkspace() !== workspace || cachedWorkspace !== workspace || !cached.includes(automation)) {
          throw new Error('Automation changed while adding content.')
        }
        const title = Array.from(titles?.[index] || basename(path, extname(path))).filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join('').replace(/[_-]+/g, ' ').trim().slice(0, 500) || 'Untitled clip'
        const item: AutomationContent = { id: itemId, fileName, title, caption: title, transcript: null, generatedMetadata: null, status: 'queued', addedAt: new Date().toISOString(), postedAt: null, postId: null, error: null }
        automation.content.push(item)
        try { save(workspace) }
        catch (error) { automation.content.pop(); throw error }
      } catch (error) {
        await unlink(dest).catch(() => {})
        throw error
      } finally { await source.handle.close() }
    }
  } finally { busy.delete(automation.id) }
  return listAutomations()
}

export function updateAutomationContent(id: unknown, contentId: unknown, raw: unknown): Automation[] {
  const { workspace, automation } = find(id)
  const item = automation.content.find((content) => content.id === contentId)
  if (!item || !raw || typeof raw !== 'object') throw new Error('Clip not found')
  if (item.status === 'posting' || busy.has(automation.id)) throw new Error('Wait for the current post to finish.')
  const update = raw as { title?: unknown; caption?: unknown; returnToQueue?: unknown }
  if (typeof update.title !== 'string' || !update.title.trim() || update.title.length > 500 ||
      typeof update.caption !== 'string' || update.caption.length > 63_206) throw new Error('Enter a title and caption within the allowed lengths.')
  if (update.returnToQueue === true) {
    if (item.status !== 'needs_review') throw new Error('Only clips needing review can return to the queue.')
    if (item.postId) throw new Error('This clip has a Zernio post. Use Posts on Accounts to review or retry it.')
  }
  const previous = { ...item }
  const previousReview = reviews.get(item.id)
  if (item.title !== update.title.trim() || item.caption !== update.caption) {
    item.title = update.title.trim()
    item.caption = update.caption
    item.generatedMetadata = null
    if (item.status !== 'posted') clearTikTokReview(item)
  }
  if (update.returnToQueue === true) {
    // The old request ID stays in the attempt journal. Only a person who has
    // checked Zernio may authorize a new post after an uncertain response.
    item.postingAttemptId = randomUUID()
    clearTikTokReview(item)
    item.status = 'queued'
    item.error = null
  }
  try { save(workspace) }
  catch (error) {
    automation.content[automation.content.indexOf(item)] = previous
    if (previousReview) reviews.set(item.id, previousReview)
    throw error
  }
  return listAutomations()
}

export function removeAutomationContent(id: unknown, contentId: unknown): Automation[] {
  const { workspace, automation } = find(id)
  const item = automation.content.find((content) => content.id === contentId)
  if (!item) throw new Error('Clip not found')
  if (item.status === 'posting' || busy.has(automation.id)) throw new Error('Wait for the current post to finish.')
  reviews.delete(item.id)
  automation.content = automation.content.filter((content) => content.id !== item.id)
  save(workspace)
  rmSync(join(bankPath(workspace, automation.id), item.fileName), { force: true })
  return listAutomations()
}

async function prepareMetadata(workspace: string, automation: Automation, item: AutomationContent, path: string): Promise<{ facebookFormat: 'feed' | 'reel'; generated: GeneratedPlatformMetadata[] | null }> {
  const facebookFormat = automation.metadataMode === 'ai' && automation.accounts.some((account) => account.platform === 'facebook')
    ? defaultFacebookFormat(await probeClipForPosting(path, null)) : 'feed'
  let generated: GeneratedPlatformMetadata[] | null = null
  if (automation.metadataMode === 'ai') {
    const platforms = [...new Set(automation.accounts.map((account) => account.platform))]
    if (!item.transcript) {
      const transcript = await transcribeAutomationClip(path)
      if (currentWorkspace() !== workspace || !cached.includes(automation)) throw new Error('The Zernio workspace changed. Please try again.')
      item.transcript = transcript
      save(workspace)
    }
    if (!item.generatedMetadata || item.generatedMetadata.some((post) => post.topicTag === undefined) ||
        !platforms.every((platform) => item.generatedMetadata?.some((post) => post.platform === platform))) {
      const metadata = await generateAutomationMetadata(item.transcript, item.title, item.caption, platforms, { facebookFormat })
      if (currentWorkspace() !== workspace || !cached.includes(automation)) throw new Error('The Zernio workspace changed. Please try again.')
      item.generatedMetadata = metadata
      save(workspace)
    }
    generated = item.generatedMetadata
  }
  return { facebookFormat, generated }
}

/** Prepare the exact caption and local preview without uploading or scheduling anything. */
export async function prepareAutomationTikTokReview(id: unknown, contentId: unknown): Promise<AutomationTikTokReview> {
  const { workspace, automation } = find(id)
  const item = automation.content.find((content) => content.id === contentId)
  if (!item || item.status !== 'queued') throw new Error('Only queued clips can be approved for TikTok.')
  if (busy.has(automation.id)) throw new Error('Wait for the current operation to finish.')
  const targets = automation.accounts.filter((account) => account.platform === 'tiktok')
  if (!automation.profileId || !targets.length) throw new Error('Save a TikTok account on this automation first.')
  busy.add(automation.id)
  try {
    // Persist the caption before revoking approval, so cancelling/reloading the
    // dialog cannot lose previously reviewed edits or silently resume posting.
    const previous = { ...item }
    item.tiktokDraftCaption = item.tiktokApproval?.caption ?? item.tiktokDraftCaption ?? null
    item.tiktokApproval = null
    try { save(workspace) } catch (error) { automation.content[automation.content.indexOf(item)] = previous; throw error }
    reviews.delete(item.id)
    const overview = await getZernioOverview()
    checkProfileAccounts(overview, automation.profileId, automation.accounts)
    if (currentWorkspace() !== workspace || !cached.includes(automation)) throw new Error('The Zernio workspace changed. Please try again.')
    const path = join(bankPath(workspace, automation.id), item.fileName)
    if (!isAutomationMedia(path)) throw new Error('Clip file is missing from the content bank.')
    const originalFile = fileStamp(path)
    if (previous.tiktokApproval && !sameFileStamp(previous.tiktokApproval.fileStamp, originalFile)) {
      clearTikTokReview(item)
      item.transcript = null
      item.generatedMetadata = null
      save(workspace)
    }
    authorizeMedia(path)
    const { generated } = await prepareMetadata(workspace, automation, item, path)
    const media = await probeClipForPosting(path, null)
    const creators = await Promise.all(targets.map(async (target) => {
      const account = overview.accounts.find((account) => account.id === target.accountId)!
      return { info: await getTikTokCreatorInfo(target.accountId), businessConnection: account.integrationLane === 'business',
        handle: account.username ? `@${account.username}` : account.displayName || 'TikTok account' }
    }))
    if (currentWorkspace() !== workspace || !cached.includes(automation)) throw new Error('The Zernio workspace changed. Please try again.')
    if (!sameFileStamp(originalFile, fileStamp(path))) {
      clearTikTokReview(item)
      item.transcript = null
      item.generatedMetadata = null
      save(workspace)
      throw new Error('The clip file changed while preparing the review. Reload the review.')
    }
    const reviewId = randomUUID()
    // Bound abandoned reviews across workspace switches.
    if (reviews.size >= MAX_CONTENT) reviews.delete(reviews.keys().next().value!)
    reviews.set(item.id, { id: reviewId, fingerprint: reviewFingerprint(workspace, automation, item) })
    return { reviewId, clipPath: path, caption: item.tiktokDraftCaption ?? generated?.find((post) => post.platform === 'tiktok')?.caption ?? item.caption, media, creators }
  } finally { busy.delete(automation.id) }
}

export async function approveAutomationTikTokReview(id: unknown, contentId: unknown, raw: unknown): Promise<Automation[]> {
  const { workspace, automation } = find(id)
  const item = automation.content.find((content) => content.id === contentId)
  const value = raw as AutomationTikTokReviewUpdate | null
  if (!item || item.status !== 'queued' || !value || typeof value !== 'object') throw new Error('Only queued clips can be approved for TikTok.')
  if (busy.has(automation.id)) throw new Error('Wait for the current operation to finish.')
  const review = reviews.get(item.id)
  if (!review || review.id !== value.reviewId || review.fingerprint !== reviewFingerprint(workspace, automation, item)) {
    throw new Error('The clip or automation changed. Reopen the TikTok review.')
  }
  if (value.previewConfirmed !== true) throw new Error('Confirm that you reviewed this clip and caption.')
  if (typeof value.caption !== 'string' || !value.caption.trim() || value.caption.includes('\0')) throw new Error('Enter a TikTok caption.')
  const captionError = checkCaption('tiktok', value.caption)
  if (captionError.error) throw new Error(captionError.error)
  const targets = automation.accounts.filter((account) => account.platform === 'tiktok')
  const options = parseTikTokOptions(value.options, targets.map((target) => target.accountId))
  busy.add(automation.id)
  try {
    const overview = await getZernioOverview()
    checkProfileAccounts(overview, automation.profileId!, automation.accounts)
    const infos = await Promise.all(targets.map((target) => getTikTokCreatorInfo(target.accountId)))
    const problem = tiktokOptionsError(options, infos)
    if (problem) throw new Error(problem)
    const media = await probeClipForPosting(join(bankPath(workspace, automation.id), item.fileName), null)
    for (const info of infos) {
      const blocking = checkClip('tiktok', media, { tiktokMaxSec: info.maxVideoDurationSec }).blocking
      if (blocking) throw new Error(blocking)
      const account = overview.accounts.find((account) => account.id === info.accountId)!
      if (!options.draft && account.integrationLane === 'business' && options.accounts[info.accountId].privacyLevel !== 'PUBLIC_TO_EVERYONE') {
        throw new Error('TikTok Business connections require Everyone for direct video posts. Choose Everyone or send to your TikTok inbox.')
      }
      const choice = options.accounts[info.accountId]
      choice.allowComment &&= info.interactions.comment
      choice.allowDuet &&= info.interactions.duet
      choice.allowStitch &&= info.interactions.stitch
    }
    if (currentWorkspace() !== workspace || !cached.includes(automation) || review.fingerprint !== reviewFingerprint(workspace, automation, item)) {
      throw new Error('The clip or automation changed. Reopen the TikTok review.')
    }
    const previous = { ...item }
    const previousError = automation.lastError
    item.tiktokApproval = { caption: value.caption, options, reviewedAt: new Date().toISOString(), fileStamp: fileStamp(join(bankPath(workspace, automation.id), item.fileName)) }
    item.tiktokDraftCaption = null
    item.error = null
    automation.lastError = null
    try { save(workspace) }
    catch (error) {
      automation.content[automation.content.indexOf(item)] = previous
      automation.lastError = previousError
      throw error
    }
    reviews.delete(item.id)
    return listAutomations()
  } finally { busy.delete(automation.id) }
}

export async function runAutomation(id: unknown, slot?: { time: string; date: string }): Promise<Automation[]> {
  const { workspace, automation } = find(id)
  if (busy.has(automation.id)) return listAutomations()
  if (slot && (!automation.enabled || automation.lastSlots[slot.time] === slot.date)) return listAutomations()
  const item = nextAutomationContent(automation)
  if (!item) {
    const message = automation.content.some((content) => content.status === 'queued')
      ? 'Review a queued clip for TikTok before it can post automatically.' : 'No queued clips are available.'
    if (automation.lastError !== message) { automation.lastError = message; save(workspace) }
    return listAutomations()
  }
  // Waiting for approval is not an attempt. A clip approved during the wake-up
  // grace period can still use the slot; actual attempts reserve it once.
  if (slot) { automation.lastSlots[slot.time] = slot.date; save(workspace) }
  if (!automation.profileId || automation.accounts.length === 0) {
    automation.lastError = 'Choose one Zernio profile and at least one of its accounts.'
    save(workspace)
    return listAutomations()
  }
  let submissionStarted = false
  busy.add(automation.id)
  try {
    checkProfileAccounts(await getZernioOverview(), automation.profileId, automation.accounts)
    if (currentWorkspace() !== workspace || !cached.includes(automation)) return []
    const path = join(bankPath(workspace, automation.id), item.fileName)
    if (!isAutomationMedia(path)) throw new Error('Clip file is missing from the content bank.')
    const tiktokTargets = automation.accounts.filter((account) => account.platform === 'tiktok')
    if (tiktokTargets.length) assertApprovedFile(item, path)
    authorizeMedia(path)
    const { facebookFormat, generated } = await prepareMetadata(workspace, automation, item, path)
    // A scheduled run must check current creator permissions even if the user
    // approved seconds ago and the publishing service still has cached info.
    await Promise.all(tiktokTargets.map((target) => getTikTokCreatorInfo(target.accountId)))
    if (currentWorkspace() !== workspace || !cached.includes(automation)) return []
    if (tiktokTargets.length) assertApprovedFile(item, path)
    const youtube = generated?.find((post) => post.platform === 'youtube')
    const facebook = generated?.find((post) => post.platform === 'facebook')
    const threads = generated?.find((post) => post.platform === 'threads')
    // Automatic retries use one attempt per bank item. A manual review can
    // start a new attempt without discarding the old request journal.
    const request: PostClipRequest = {
      attemptId: item.postingAttemptId ?? item.id, clipPath: path, clipTitle: item.title, durationMs: null, caption: item.caption,
      targets: automation.accounts.map((account) => {
        const caption = account.platform === 'tiktok' ? item.tiktokApproval?.caption : generated?.find((post) => post.platform === account.platform)?.caption
        return { ...account, ...(caption ? { customContent: caption } : {}) }
      }), timing: { mode: 'now' },
      options: {
        tiktok: automation.accounts.some((account) => account.platform === 'tiktok') ? item.tiktokApproval?.options : undefined,
        youtube: automation.accounts.some((account) => account.platform === 'youtube')
          ? { title: youtube?.title || youtubeTitleFor(item.title) || 'Untitled clip', visibility: automation.youtubeVisibility, madeForKids: automation.youtubeMadeForKids,
              ...(youtube?.categoryId ? { categoryId: youtube.categoryId } : {}), ...(youtube?.tags?.length ? { tags: youtube.tags } : {}) } : undefined,
        instagram: automation.accounts.some((account) => account.platform === 'instagram') ? { shareToFeed: true } : undefined,
        facebook: automation.accounts.some((account) => account.platform === 'facebook') ? { format: facebookFormat,
          ...(facebookFormat === 'reel' && facebook?.title ? { title: facebook.title } : {}) } : undefined,
        threads: threads?.topicTag ? { topicTag: threads.topicTag } : undefined
      }
    }
    parsePostClipRequest(request)
    item.status = 'posting'
    item.error = null
    automation.lastRunAt = new Date().toISOString()
    automation.lastError = null
    save(workspace)
    const result = await publishClip(request, (progress) => {
      if (progress.phase === 'publishing') submissionStarted = true
    })
    if (currentWorkspace() !== workspace || !cached.includes(automation)) return []
    item.postId = result.post?.id ?? null
    if (result.post && !['failed', 'duplicate', 'partial'].includes(result.outcome)) {
      item.status = 'posted'
      item.postedAt = new Date().toISOString()
    } else {
      item.status = 'needs_review'
      item.error = result.outcome === 'partial' ? 'Some accounts failed. Check Posts on Accounts before returning this clip to the queue.' : result.message
      automation.lastError = item.error
    }
    save(workspace)
  } catch (error) {
    if (currentWorkspace() === workspace && cached.includes(automation)) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Posting failed. Check Zernio before retrying.'
      if (item.status === 'posting') {
        item.status = submissionStarted ? 'needs_review' : 'queued'
        item.error = message
      } else if (item.status === 'queued') item.error = message
      automation.lastError = message
      save(workspace)
    }
    logger.warn('automation.post.failed', { automationId: automation.id, contentId: item.id })
  } finally { busy.delete(automation.id) }
  return listAutomations()
}

export function startAutomationScheduler(): () => void {
  const tick = (): void => {
    try {
      if (!loadSettings().zernioApiKey) return
      const now = Date.now()
      for (const automation of listAutomations()) {
        if (!automation.enabled) continue
        // Distinct automations can post together; one slow upload must not delay another account's slot.
        void (async () => {
          for (const slot of dueSlots(automation.times, automation.timezone, now)) await runAutomation(automation.id, slot)
        })().catch((error) => logger.warn('automation.scheduler.failed', { message: error instanceof Error ? error.message : 'Unknown error' }))
      }
    } catch (error) {
      logger.warn('automation.scheduler.failed', { message: error instanceof Error ? error.message : 'Unknown error' })
    }
  }
  const timer = setInterval(tick, 15_000)
  setTimeout(tick, 2_000)
  return () => clearInterval(timer)
}
