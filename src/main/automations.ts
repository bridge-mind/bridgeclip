import type { LibraryClipTarget } from '../shared/library-posting'
import { app, powerSaveBlocker, shell } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { open, unlink } from 'fs/promises'
import { basename, extname, join } from 'path'
import { pipeline } from 'stream/promises'
import { MAX_ENHANCEMENT_GUIDANCE, MAX_RESEARCH_URL, needsTikTokReview, AUTOMATION_PLATFORMS, dueSlots, missedSlots, recentSlots, slotDueSoon, type Automation, type AutomationAccount, type AutomationContent, type AutomationUpdate, type GeneratedPlatformMetadata, type AutomationSourceContext, type MetadataEnhancement, type MetadataResearch, type AutomationSourceGroup, type AutomationBatchResult, nextAutomationContent, type AutomationTikTokReview, type AutomationTikTokReviewUpdate, validMissedNotice } from '../shared/automations'
import { isPostableAccount, isZernioId, type ZernioOverview } from '../shared/zernio'
import { checkCaption, checkClip, defaultFacebookFormat, isValidTimeZone, tiktokOptionsError, youtubeTitleFor, type PostClipRequest } from '../shared/zernio-posts'
import { loadSettings } from './settings-store'
import { assertMediaPath, authorizeMedia, isWithinDirectory, openAuthorizedMedia } from './security'
import { getJobOutput } from './file-manager'
import { getZernioOverview, readCachedOverview } from './zernio/service'
import { getTikTokCreatorInfo, inspectAutomationPost, probeClipForPosting, publishClip, relinkAutomationPost } from './zernio/posts'
import type { AutomationReviewResult } from '../shared/automations'
import { parsePostClipRequest, parseTikTokOptions } from './zernio/posts-payload'
import { workspaceId } from './zernio/workspace-cache'
import { errorSummary, logger } from './logger'
import { generateAutomationMetadata, transcribeAutomationClip, researchAutomationTopic, generateAutomationMetadataBatch, metadataFailureCode, type MetadataBatchClip } from './automation-metadata'

import { completeSourceContext, findLibraryClipForClip, parseSourceContext, recoverSourceContext, sourceFromOutput, sourceResearchKey } from './automation-source'
import { hasContentWarnings, reorderQueuedContent } from '../shared/automations'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm'])
const MAX_FILE_BYTES = 5 * 1024 ** 3
const MAX_STORE_BYTES = 32 * 1024 * 1024
const MAX_AUTOMATIONS = 100
/** Clips not yet submitted (queued, posting or held) per automation. */
const MAX_CONTENT = 500
/** Everything kept per automation, including Submitted history; the oldest history is pruned first. */
const MAX_TOTAL_CONTENT = 1000

let cachedWorkspace: string | null = null
let cached: Automation[] = []
const busy = new Set<string>()
/** Scheduled slots that came due while another operation (such as enhancement) held the automation. */
const deferredSlots = new Map<string, Map<string, { slot: { time: string; date: string }; since: number }>>()
/** A deferred slot still posts when the lock frees within this time; after it, the slot is reported as missed. */
const MAX_SLOT_DEFERRAL_MS = 60 * 60_000
/** The last scheduled slot that reported "nothing ready", so repeat ticks in its grace period stay quiet. */
const blockedSlots = new Map<string, string>()

const DRAFTS_PENDING = 'Apply or discard the enhanced metadata drafts before these clips can post.'
const TIKTOK_REVIEW_PENDING = 'Review a queued clip for TikTok before it can post automatically.'
const NO_QUEUED_CLIPS = 'No queued clips are available.'

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

function validEnhancement(value: MetadataEnhancement): boolean {
  if (!value || !UUID.test(value.id) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
      !Array.isArray(value.platforms) || value.platforms.length > AUTOMATION_PLATFORMS.length || !value.platforms.every((platform) => AUTOMATION_PLATFORMS.includes(platform)) ||
      !Array.isArray(value.posts) || value.posts.length !== value.platforms.length ||
      !value.posts.every((post) => post && value.platforms.includes(post.platform) && typeof post.caption === 'string' && post.caption.length <= 63206 &&
        (post.title === null || (typeof post.title === 'string' && post.title.length <= 500)) &&
        (post.categoryId === null || typeof post.categoryId === 'string') && (post.topicTag === null || typeof post.topicTag === 'string') &&
        Array.isArray(post.tags) && post.tags.length <= 8 && post.tags.every((tag) => typeof tag === 'string' && tag.length <= 100))) return false
  if (value.guidance !== undefined && (typeof value.guidance !== 'string' || value.guidance.length > MAX_ENHANCEMENT_GUIDANCE)) return false
  try { parseSourceContext(value.source) } catch { return false }
  return validResearch(value.research)
}

function validResearch(research: MetadataResearch): boolean {
  return research && ['complete', 'skipped', 'unavailable'].includes(research.status) && typeof research.summary === 'string' && research.summary.length <= 6000 &&
    Array.isArray(research.sources) && research.sources.length <= 3 && research.sources.every((source) => source && typeof source.title === 'string' && source.title.length <= 300 &&
      typeof source.url === 'string' && source.url.length <= MAX_RESEARCH_URL && /^https:\/\//.test(source.url))
}

function validSourceResearchEntry(entry: NonNullable<Automation['sourceResearch']>[number]): boolean {
  try {
    return Boolean(entry && /^[a-f0-9]{64}$/.test(entry.key) && typeof entry.createdAt === 'string' && Number.isFinite(Date.parse(entry.createdAt)) &&
      parseSourceContext(entry.source) && validResearch(entry.research))
  } catch { return false }
}

/**
 * Optional context attached to an automation or clip. An invalid value is
 * dropped on load rather than making the whole store unreadable; dropping any
 * of these can only ask for review or regeneration again, never post sooner.
 */
const OPTIONAL_CONTENT_FIELDS: { [K in keyof AutomationContent]?: (value: AutomationContent[K], item: AutomationContent) => boolean } = {
  sourceContext: (value) => { try { parseSourceContext(value); return true } catch { return false } },
  metadataDraft: (value) => value == null || validEnhancement(value),
  metadataEnhancement: (value) => value == null || validEnhancement(value),
  metadataError: (value) => value == null || (typeof value === 'string' && value.length <= 500),
  warningsAcknowledged: (value) => value === undefined || typeof value === 'boolean',
  metadataErrorAcknowledged: (value) => value === undefined || typeof value === 'boolean',
  sourceClipPath: (value) => value === undefined || (typeof value === 'string' && value.length <= 8192 && !value.includes('\0')),
  tiktokApproval: (_value, item) => validTikTokApproval(item),
  tiktokDraftCaption: (value) => value == null || (typeof value === 'string' && !value.includes('\0') && !checkCaption('tiktok', value).error)
}

/** Remove invalid optional fields in place. Returns true when the store needs rewriting. */
function dropInvalidOptionalFields(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const automation = value as Automation
  let changed = false
  const drop = (field: string, contentId?: string): void => {
    changed = true
    logger.warn('automation.store.field_dropped', { automationId: typeof automation.id === 'string' ? automation.id.slice(0, 64) : null, contentId: contentId?.slice(0, 64) ?? null, field })
  }
  if (automation.missedNotice != null && !validMissedNotice(automation.missedNotice)) { delete automation.missedNotice; drop('missedNotice') }
  // Builds before missedNotice reported missed slots as a run failure.
  if (typeof automation.lastError === 'string' && automation.lastError.startsWith('BridgeClip was closed or asleep at ')) {
    automation.lastError = null
    automation.lastErrorAcknowledged = false
    changed = true
  }
  if (automation.sourceResearch !== undefined) {
    if (!Array.isArray(automation.sourceResearch)) { delete automation.sourceResearch; drop('sourceResearch') }
    else {
      const kept = automation.sourceResearch.filter(validSourceResearchEntry).slice(-50)
      if (kept.length !== automation.sourceResearch.length) { automation.sourceResearch = kept; drop('sourceResearch') }
    }
  }
  if (!Array.isArray(automation.content)) return changed
  for (const item of automation.content as unknown[]) {
    if (!item || typeof item !== 'object') continue
    const content = item as AutomationContent
    for (const [field, valid] of Object.entries(OPTIONAL_CONTENT_FIELDS) as [keyof AutomationContent, (value: unknown, item: AutomationContent) => boolean][]) {
      let ok: boolean
      try { ok = valid(content[field], content) } catch { ok = false }
      if (!ok) { delete content[field]; drop(field, typeof content.id === 'string' ? content.id : undefined) }
    }
  }
  return changed
}

function validContent(value: unknown): value is AutomationContent {
  if (!value || typeof value !== 'object') return false
  const item = value as AutomationContent
  try { parseSourceContext(item.sourceContext) } catch { return false }
  for (const enhancement of [item.metadataDraft, item.metadataEnhancement]) {
    if (enhancement === undefined || enhancement === null) continue
    if (!validEnhancement(enhancement)) return false
  }
  return UUID.test(item.id) && (item.postingAttemptId === undefined || (typeof item.postingAttemptId === 'string' && UUID.test(item.postingAttemptId))) && typeof item.fileName === 'string' &&
    (item.warningsAcknowledged === undefined || typeof item.warningsAcknowledged === 'boolean') &&
    (item.metadataErrorAcknowledged === undefined || typeof item.metadataErrorAcknowledged === 'boolean') &&
    (item.sourceClipPath === undefined || (typeof item.sourceClipPath === 'string' && item.sourceClipPath.length <= 8192 && !item.sourceClipPath.includes('\0'))) &&
    item.fileName === `${item.id}${extname(item.fileName)}` && VIDEO_EXTENSIONS.has(extname(item.fileName)) &&
    (item.metadataError === undefined || item.metadataError === null || (typeof item.metadataError === 'string' && item.metadataError.length <= 500)) &&
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
  if (item.sourceResearch !== undefined &&
      (!Array.isArray(item.sourceResearch) || item.sourceResearch.length > 50 || !item.sourceResearch.every(validSourceResearchEntry))) return false
  return UUID.test(item.id) && typeof item.name === 'string' && item.name.length <= 80 &&
    (item.lastErrorAcknowledged === undefined || typeof item.lastErrorAcknowledged === 'boolean') &&
    typeof item.enabled === 'boolean' && (item.profileId === null || isZernioId(item.profileId)) &&
    (item.metadataMode === 'ai' || item.metadataMode === 'manual') &&
    Array.isArray(item.accounts) && item.accounts.length <= 20 &&
    item.accounts.every((account) => account && isZernioId(account.accountId) && AUTOMATION_PLATFORMS.includes(account.platform)) &&
    Array.isArray(item.times) && item.times.length <= 24 && item.times.every((time) => typeof time === 'string' && TIME.test(time)) &&
    isValidTimeZone(item.timezone) && ['public', 'unlisted', 'private'].includes(item.youtubeVisibility) && typeof item.youtubeMadeForKids === 'boolean' &&
    item.lastSlots && typeof item.lastSlots === 'object' && !Array.isArray(item.lastSlots) &&
    Array.isArray(item.content) && item.content.length <= MAX_TOTAL_CONTENT && item.content.every(validContent) &&
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
        for (const automation of cached) if (dropInvalidOptionalFields(automation)) migrated = true
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
        item.warningsAcknowledged = false
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

/** Acknowledge existing messages only; never retry, release, or mark a clip as posted. */
export function acknowledgeAutomationWarnings(id: unknown, contentId?: unknown): Automation[] {
  const { workspace, automations } = data()
  if (contentId !== undefined && (id === null || typeof contentId !== 'string' || !UUID.test(contentId))) throw new Error('Choose a clip to dismiss its warnings.')
  const targets = id === null ? automations : [find(id).automation]
  if (contentId !== undefined && !targets[0].content.some((item) => item.id === contentId)) throw new Error('Clip not found')
  if (targets.some((automation) => busy.has(automation.id))) throw new Error('Wait for the current operation to finish before acknowledging warnings.')
  const previous = structuredClone(automations)
  try {
    for (const automation of targets) {
      if (contentId === undefined && automation.lastError) automation.lastErrorAcknowledged = true
      if (contentId === undefined) automation.missedNotice = null
      for (const item of automation.content) if ((contentId === undefined || item.id === contentId) && hasContentWarnings(item)) item.warningsAcknowledged = true
    }
    save(workspace)
  } catch (error) {
    // Preserve existing object identities for operations on unrelated automations.
    for (const automation of targets) {
      const old = previous.find((entry) => entry.id === automation.id)!
      automation.lastErrorAcknowledged = old.lastErrorAcknowledged
      automation.missedNotice = old.missedNotice
      for (const item of automation.content) item.warningsAcknowledged = old.content.find((entry) => entry.id === item.id)?.warningsAcknowledged
    }
    throw error
  }
  return listAutomations()
}

export function dismissAutomationMetadataError(id: unknown, contentId: unknown): Automation[] {
  const { workspace, automation } = find(id)
  const item = automation.content.find((entry) => entry.id === contentId)
  if (!item) throw new Error('Clip not found')
  if (busy.has(automation.id)) throw new Error('Wait for the current operation to finish.')
  if (!item.metadataError) return listAutomations()
  const previous = item.metadataErrorAcknowledged
  item.metadataErrorAcknowledged = true
  try { save(workspace) } catch (error) { item.metadataErrorAcknowledged = previous; throw error }
  return listAutomations()
}

export function showAutomationContentInFolder(id: unknown, contentId: unknown): boolean {
  const { workspace, automation } = find(id)
  const item = automation.content.find((entry) => entry.id === contentId)
  if (!item) throw new Error('Clip not found.')
  const path = join(bankPath(workspace, automation.id), item.fileName)
  if (!isAutomationMedia(path)) return false
  shell.showItemInFolder(path)
  return true
}

export async function automationLibraryClip(id: unknown, contentId: unknown): Promise<LibraryClipTarget | null> {
  const { workspace, automation } = find(id)
  const item = automation.content.find((entry) => entry.id === contentId)
  if (!item) throw new Error('Clip not found.')
  const library = loadSettings().outputDirectory
  const path = join(bankPath(workspace, automation.id), item.fileName)
  const validBank = isAutomationMedia(path)
  if (validBank) authorizeMedia(path)
  const run = await findLibraryClipForClip(validBank ? path : null, library, item.sourceClipPath)
  if (currentWorkspace() !== workspace || loadSettings().outputDirectory !== library || !cached.includes(automation) || !automation.content.includes(item)) throw new Error('The automation changed. Try again.')
  return run
}

/** Recognize only a recorded bank file in the current workspace. */
export function isAutomationMedia(path: unknown): path is string {
  return automationMediaMatcher()(path)
}

/** isAutomationMedia for many paths, reading the automation store once. */
export function automationMediaMatcher(): (path: unknown) => path is string {
  let owners: Map<string, string>
  let workspace: string
  try {
    const current = data()
    workspace = current.workspace
    owners = new Map(current.automations.flatMap((automation) => automation.content.map((item) => [join(bankPath(workspace, automation.id), item.fileName), automation.id] as const)))
  } catch { return (_path: unknown): _path is string => false }
  return (path: unknown): path is string => {
    if (typeof path !== 'string') return false
    const automationId = owners.get(path)
    if (!automationId) return false
    try {
      if (lstatSync(path).isSymbolicLink()) return false
      const directory = bankPath(workspace, automationId)
      return !lstatSync(directory).isSymbolicLink() && isWithinDirectory(path, directory) && isWithinDirectory(path, app.getPath('userData'))
    } catch { return false }
  }
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
    const lastSlots = Object.fromEntries(Object.entries(automation.lastSlots).filter(([time]) => update.times.includes(time) && automation.enabled))
    // Enabling, or adding a time, starts from the next occurrence: a slot that
    // passed before this save is never caught up as a late post.
    if (update.enabled) for (const slot of recentSlots(update.times, update.timezone, Date.now())) if (slot.minutesAgo >= 5) lastSlots[slot.time] ??= slot.date
    Object.assign(automation, update, { lastSlots })
    save(workspace)
  } catch (error) {
    Object.assign(automation, previous)
    for (const [contentId, review] of previousReviews) if (review) reviews.set(contentId, review)
    throw error
  }
  return listAutomations()
}

/** Post history outlives a removed bank copy: point it at the original clip instead. */
function forgetBankItems(workspace: string, automationId: string, items: readonly AutomationContent[]): void {
  for (const item of items) {
    reviews.delete(item.id)
    if (item.postId) relinkAutomationPost(item.postId, join(bankPath(workspace, automationId), item.fileName), item.sourceClipPath)
  }
}

export function deleteAutomation(id: unknown): Automation[] {
  const { workspace, automation } = find(id)
  if (busy.has(automation.id)) throw new Error('Wait for the current post to finish.')
  const previous = cached
  cached = cached.filter((item) => item.id !== automation.id)
  // A failed save keeps the automation, so the UI and the scheduler still see it.
  try { save(workspace) } catch (error) { cached = previous; throw error }
  forgetBankItems(workspace, automation.id, automation.content)
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
  return addAutomationContent(id, paths, titles, sourceFromOutput(output))
}

export async function addAutomationContent(id: unknown, paths: string[], titles?: readonly string[], sourceContext?: AutomationSourceContext): Promise<Automation[]> {
  const { workspace, automation } = find(id)
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 30) throw new Error('Choose up to 30 clips at a time.')
  // Submitted clips are history and never block new content; see pruneHistory.
  if (automation.content.filter((item) => item.status !== 'posted').length + paths.length > MAX_CONTENT) {
    throw new Error(`An automation can hold up to ${MAX_CONTENT} clips that have not been submitted. Remove some before adding more.`)
  }
  if (busy.has(automation.id)) throw new Error('Wait for the current operation to finish.')
  busy.add(automation.id)
  const directory = bankPath(workspace, automation.id)
  const copiedFiles: string[] = []
  const pendingItems: AutomationContent[] = []
  let committed = false
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
        const item: AutomationContent = { id: itemId, sourceClipPath: source.canonical, fileName, title, caption: title, sourceContext: sourceContext ?? null, transcript: null, generatedMetadata: null, status: 'queued', addedAt: new Date().toISOString(), postedAt: null, postId: null, error: null }
        copiedFiles.push(dest)
        pendingItems.push(item)
      } catch (error) {
        await unlink(dest).catch(() => {})
        throw error
      } finally { await source.handle.close() }
    }
    if (currentWorkspace() !== workspace || cachedWorkspace !== workspace || !cached.includes(automation)) {
      throw new Error('Automation changed while adding content.')
    }
    const previousContent = automation.content
    const pruned = pruneHistory([...previousContent, ...pendingItems])
    automation.content = [...previousContent, ...pendingItems].filter((item) => !pruned.includes(item))
    try { save(workspace); committed = true }
    catch (error) { automation.content = previousContent; throw error }
    forgetBankItems(workspace, automation.id, pruned)
    for (const item of pruned) rmSync(join(directory, item.fileName), { force: true })
  } finally {
    if (!committed) for (const file of copiedFiles) await unlink(file).catch(() => {})
    release(automation.id)
  }
  return listAutomations()
}

/** The oldest Submitted clips that must go so the bank stays within MAX_TOTAL_CONTENT. */
function pruneHistory(content: readonly AutomationContent[]): AutomationContent[] {
  const excess = content.length - MAX_TOTAL_CONTENT
  if (excess <= 0) return []
  return content.filter((item) => item.status === 'posted')
    .sort((a, b) => (a.postedAt ?? a.addedAt).localeCompare(b.postedAt ?? b.addedAt))
    .slice(0, excess)
}

export function reorderAutomationContent(id: unknown, contentId: unknown, beforeId: unknown): Automation[] {
  const { workspace, automation } = find(id)
  if (busy.has(automation.id)) throw new Error('Wait for the current operation to finish.')
  if (typeof contentId !== 'string' || !UUID.test(contentId) || (beforeId !== null && (typeof beforeId !== 'string' || !UUID.test(beforeId)))) throw new Error('Choose queued clips to reorder.')
  const previous = automation.content
  automation.content = reorderQueuedContent(previous, contentId, beforeId)
  try { save(workspace) } catch (error) { automation.content = previous; throw error }
  return listAutomations()
}

export function updateAutomationContent(id: unknown, contentId: unknown, raw: unknown): Automation[] {
  const { workspace, automation } = find(id)
  const item = automation.content.find((content) => content.id === contentId)
  if (!item || !raw || typeof raw !== 'object') throw new Error('Clip not found')
  if (item.status === 'posting' || busy.has(automation.id)) throw new Error('Wait for the current post to finish.')
  if (item.metadataDraft) throw new Error('Apply or discard the enhanced draft before editing this clip.')
  const update = raw as { title?: unknown; caption?: unknown; returnToQueue?: unknown }
  if (typeof update.title !== 'string' || !update.title.trim() || update.title.length > 500 ||
      typeof update.caption !== 'string' || update.caption.length > 63_206) throw new Error('Enter a title and caption within the allowed lengths.')
  if (update.returnToQueue === true) {
    if (item.status !== 'needs_review') throw new Error('Only clips needing review can return to the queue.')
    if (item.postId) throw new Error('This clip has a Zernio post. Open Posts to review or retry it.')
  }
  const previous = { ...item }
  const previousReview = reviews.get(item.id)
  if (item.title !== update.title.trim() || item.caption !== update.caption) {
    item.title = update.title.trim()
    item.caption = update.caption
    item.generatedMetadata = null
    item.metadataEnhancement = null
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

export async function reviewAutomationContent(id: unknown, contentId: unknown, returnToQueue: unknown): Promise<AutomationReviewResult> {
  const { workspace, automation } = find(id)
  const item = automation.content.find((content) => content.id === contentId)
  if (!item || item.status !== 'needs_review' || typeof returnToQueue !== 'boolean') throw new Error('Choose a held clip to review.')
  if (busy.has(automation.id)) throw new Error('Wait for the current operation to finish.')
  busy.add(automation.id)
  const previous = { ...item }
  const previousReview = reviews.get(item.id)
  try {
    const post = item.postId ? await inspectAutomationPost(item.postId, {
      clipPath: join(bankPath(workspace, automation.id), item.fileName), clipTitle: item.title, addedAt: item.addedAt
    }, returnToQueue) : null
    if (currentWorkspace() !== workspace || !cached.includes(automation)) throw new Error('The Zernio workspace changed. Please try again.')
    let outcome: AutomationReviewResult['outcome'] = 'held'
    let message = 'This clip has no linked Zernio post. Use Return to queue after confirming it was not published.'
    if (post?.missing) {
      // Zernio no longer has the post, so it can't prove the clip was not
      // published. Unlink it; returning it now needs a person's confirmation.
      item.postId = null
      item.error = 'Zernio no longer has this clip’s post. Confirm it was not published to any selected account before returning it to the queue.'
      item.warningsAcknowledged = false
      message = 'Zernio no longer has this post, so its status can’t be checked. Confirm it was not published, then use Return to queue, or remove the clip.'
    } else if (post?.submitted) {
      item.status = 'posted'
      item.postedAt ??= new Date().toISOString()
      item.error = null
      item.warningsAcknowledged = false
      outcome = 'submitted'
      message = 'Zernio already has this post published or in progress. The clip was moved to Submitted.'
    } else if (post && !post.fullyFailed) {
      message = 'This post may have published to some accounts, or its status is incomplete. Check Posts and retry only failed accounts there.'
    } else if (returnToQueue) {
      item.postingAttemptId = randomUUID()
      item.postId = null
      item.postedAt = null
      item.status = 'queued'
      item.error = null
      item.warningsAcknowledged = false
      clearTikTokReview(item)
      outcome = 'queued'
      message = 'Clip returned to the queue.'
    } else {
      message = 'Zernio confirms this post failed on every account. You can return the clip to the queue.'
    }
    save(workspace)
    return { automations: listAutomations(), outcome, message }
  } catch (error) {
    Object.assign(item, previous)
    if (previousReview) reviews.set(item.id, previousReview)
    throw error
  } finally { release(automation.id) }
}

export function removeAutomationContent(id: unknown, contentId: unknown): Automation[] {
  const { workspace, automation } = find(id)
  const item = automation.content.find((content) => content.id === contentId)
  if (!item) throw new Error('Clip not found')
  if (item.status === 'posting' || busy.has(automation.id)) throw new Error('Wait for the current post to finish.')
  // Removing never re-queues anything. Submitted and held clips leave the
  // bank as history; their posts stay in Zernio and in Posts.
  const previous = automation.content
  automation.content = automation.content.filter((content) => content.id !== item.id)
  try { save(workspace) } catch (error) { automation.content = previous; throw error }
  forgetBankItems(workspace, automation.id, [item])
  rmSync(join(bankPath(workspace, automation.id), item.fileName), { force: true })
  return listAutomations()
}

async function completeBankSource(automation: Automation, source: AutomationSourceContext | null): Promise<AutomationSourceContext | null> {
  if (!source || source.description) return source
  const identity = source.url || source.videoId
  const previous = identity && automation.content.map((item) => item.sourceContext).find((candidate) => candidate && (candidate.url || candidate.videoId) === identity && candidate.description)
  return previous ? { ...source, description: previous.description, channel: source.channel || previous.channel } : completeSourceContext(source)
}

async function sharedSourceResearch(workspace: string, automation: Automation, source: AutomationSourceContext | null, transcript = '', guidance = ''): Promise<MetadataResearch> {
  const sourceKey = sourceResearchKey(source)
  const key = sourceKey && guidance ? createHash('sha256').update(JSON.stringify([sourceKey, guidance])).digest('hex') : sourceKey
  if (!key || !source) return researchAutomationTopic(transcript, source, 'clip', guidance)
  const previous = automation.sourceResearch?.find((entry) => entry.key === key)
  // Source terminology is stable; retry unavailable searches after a short cooldown.
  const ttl = previous?.research.status === 'complete' ? 7 * 86400000 : 5 * 60000
  if (previous && Date.now() - Date.parse(previous.createdAt) >= 0 && Date.now() - Date.parse(previous.createdAt) < ttl) {
    return { ...previous.research, scope: 'source', reused: true, researchedAt: previous.createdAt }
  }
  const research = await researchAutomationTopic('', source, 'source', guidance)
  if (currentWorkspace() !== workspace || cachedWorkspace !== workspace || !cached.includes(automation)) throw new Error('The Zernio workspace changed. Please try again.')
  const createdAt = new Date().toISOString()
  const result = { ...research, scope: 'source' as const, reused: false, researchedAt: createdAt }
  const old = automation.sourceResearch
  automation.sourceResearch = [...(old ?? []).filter((entry) => entry.key !== key).slice(-49), { key, createdAt, source, research: result }]
  try { save(workspace) } catch (error) { automation.sourceResearch = old; throw error }
  return result
}

/** Resolve legacy imports before showing video groups; this performs no AI inference. */
export async function automationEnhancementGroups(id: unknown): Promise<AutomationSourceGroup[]> {
  const { automation, workspace } = find(id)
  const platforms = automation.accounts.length ? automation.accounts.map((account) => account.platform) : ['youtube' as const]
  const needsDraft = (item: AutomationContent): boolean => item.status === 'queued' && !item.postId && !item.metadataDraft &&
    !(item.metadataEnhancement && platforms.every((platform) => item.generatedMetadata?.some((post) => post.platform === platform)))
  const candidates = automation.content.filter(needsDraft)
  for (const item of candidates.slice(0, 100)) {
    if (currentWorkspace() !== workspace || !cached.includes(automation)) throw new Error('The Zernio workspace changed. Please try again.')
    await automationContentSource(id, item.id)
  }
  const groups = new Map<string, AutomationSourceGroup>()
  for (const item of candidates) {
    if (!needsDraft(item)) continue
    const key = sourceResearchKey(item.sourceContext ?? null) ?? `clip:${item.id}`
    const group = groups.get(key) ?? { key, sourceType: item.sourceContext?.url ? 'linked' as const : 'file' as const, title: item.sourceContext?.title || item.title, contentIds: [] }
    group.contentIds.push(item.id)
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** Keep a whole writing batch reserved, so scheduled publishing cannot race draft preparation. */
export async function enhanceAutomationBatch(id: unknown, rawIds: unknown, rawKey: unknown, rawGuidance: unknown = ''): Promise<AutomationBatchResult> {
  const { workspace, automation } = find(id)
  if (typeof rawGuidance !== 'string' || rawGuidance.length > MAX_ENHANCEMENT_GUIDANCE) throw new Error(`Use a prompt of up to ${MAX_ENHANCEMENT_GUIDANCE} characters.`)
  const guidance = rawGuidance.trim()
  if (!Array.isArray(rawIds) || !rawIds.length || rawIds.length > 5 || new Set(rawIds).size !== rawIds.length || !rawIds.every((id) => typeof id === 'string' && UUID.test(id)) || typeof rawKey !== 'string') throw new Error('Choose up to five clips from one video.')
  if (busy.has(automation.id)) throw new Error('Wait for the current operation to finish.')
  const selected: AutomationContent[] = []
  const errors: AutomationBatchResult['errors'] = []
  let skipped = 0
  const platforms = automation.accounts.length ? [...new Set(automation.accounts.map((account) => account.platform))] : ['youtube' as const]
  for (const id of rawIds) {
    const item = automation.content.find((item) => item.id === id)
    if (!item || item.status !== 'queued' || item.postId || item.metadataDraft ||
        (item.metadataEnhancement && platforms.every((platform) => item.generatedMetadata?.some((post) => post.platform === platform)))) { skipped++; continue }
    if ((sourceResearchKey(item.sourceContext ?? null) ?? `clip:${item.id}`) !== rawKey) {
      errors.push({ contentId: item.id, message: 'This clip’s source context changed. Refresh the source groups and retry.' }); continue
    }
    selected.push(item)
  }
  busy.add(automation.id)
  const ensureCurrent = (): void => {
    if (currentWorkspace() !== workspace || cachedWorkspace !== workspace || !cached.includes(automation)) throw new Error('The Zernio workspace changed. Please try again.')
  }
  const recordErrors = (): void => {
    ensureCurrent()
    for (const failure of errors) {
      const item = automation.content.find((item) => item.id === failure.contentId)
      if (item && !item.metadataDraft) {
        item.metadataError = failure.message.slice(0, 500)
        item.metadataErrorAcknowledged = false
        item.warningsAcknowledged = false
      }
      logger.warn('automation.metadata.clip_failed', { automationId: automation.id, contentId: failure.contentId, code: metadataFailureCode(failure.message) })
    }
    save(workspace)
  }
  try {
    const clips: MetadataBatchClip[] = []
    for (const item of selected) {
      ensureCurrent()
      try {
        const path = join(bankPath(workspace, automation.id), item.fileName)
        if (!isAutomationMedia(path)) throw new Error('Clip file is missing from the content bank.')
        authorizeMedia(path)
        if (!item.transcript) {
          const transcript = await transcribeAutomationClip(path)
          ensureCurrent(); item.transcript = transcript; save(workspace)
        }
        const facebookFormat = platforms.includes('facebook') ? defaultFacebookFormat(await probeClipForPosting(path, null)) : 'feed'
        ensureCurrent()
        clips.push({ id: item.id, title: item.title, notes: item.caption, transcript: item.transcript, facebookFormat })
      } catch (error) { ensureCurrent(); errors.push({ contentId: item.id, message: error instanceof Error ? error.message.slice(0, 500) : 'Clip preparation failed.' }) }
    }
    if (!clips.length) { recordErrors(); return { automations: listAutomations(), completed: 0, skipped, errors } }
    const source = selected[0].sourceContext ?? null
    const research = await sharedSourceResearch(workspace, automation, source, clips[0].transcript, guidance)
    ensureCurrent()
    const result = await generateAutomationMetadataBatch(clips, platforms, { source, research, guidance })
    ensureCurrent()
    let completed = 0
    for (const item of selected) {
      const posts = result.posts.get(item.id)
      if (!posts) {
        if (result.errors.has(item.id)) errors.push({ contentId: item.id, message: result.errors.get(item.id)! })
        continue
      }
      item.metadataDraft = { id: randomUUID(), createdAt: new Date().toISOString(), platforms, posts, source, research, guidance }
      item.metadataError = null
      try { save(workspace); completed++ } catch (error) { item.metadataDraft = null; throw error }
    }
    recordErrors()
    logger.info('automation.metadata.batch.completed', { automationId: automation.id, requested: rawIds.length, completed, skipped, failed: errors.length })
    return { automations: listAutomations(), completed, skipped, errors }
  } catch (error) {
    ensureCurrent()
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Metadata enhancement failed. Try again.'
    for (const item of selected) if (!item.metadataDraft && !errors.some((failure) => failure.contentId === item.id)) errors.push({ contentId: item.id, message })
    recordErrors()
    return { automations: listAutomations(), completed: selected.filter((item) => item.metadataDraft).length, skipped, errors }
  } finally { release(automation.id) }
}

/** Resolve context separately so the user can inspect/correct it before paid generation. */
export async function automationContentSource(id: unknown, contentId: unknown): Promise<AutomationSourceContext | null> {
  const { workspace, automation } = find(id)
  const item = automation.content.find((content) => content.id === contentId)
  if (!item || item.status !== 'queued' || item.postId) throw new Error('Choose an unposted queued clip.')
  if (busy.has(automation.id)) throw new Error('Wait for the current operation to finish.')
  busy.add(automation.id)
  try {
    const path = join(bankPath(workspace, automation.id), item.fileName)
    if (!isAutomationMedia(path)) throw new Error('Clip file is missing from the content bank.')
    authorizeMedia(path)
    const source = await completeBankSource(automation, item.sourceContext ?? await recoverSourceContext(path, item.title, loadSettings().outputDirectory))
    if (currentWorkspace() !== workspace || cachedWorkspace !== workspace || !cached.includes(automation)) throw new Error('The Zernio workspace changed. Please try again.')
    item.sourceContext = source
    save(workspace)
    return source
  } finally { release(automation.id) }
}

export async function enhanceAutomationContent(id: unknown, contentId: unknown, raw: unknown): Promise<Automation[]> {
  const { workspace, automation } = find(id)
  const item = automation.content.find((content) => content.id === contentId)
  if (!item || item.status !== 'queued' || item.postId) throw new Error('Choose an unposted queued clip.')
  if (!raw || typeof raw !== 'object' || typeof (raw as { research?: unknown }).research !== 'boolean') throw new Error('Choose whether to research the topic.')
  const options = raw as { source?: unknown; research: boolean }
  let source = options.source === undefined ? item.sourceContext ?? null : parseSourceContext(options.source)
  const platforms = automation.accounts.length ? [...new Set(automation.accounts.map((account) => account.platform))] : ['youtube' as const]
  if (busy.has(automation.id)) throw new Error('Wait for the current operation to finish.')
  busy.add(automation.id)
  const ensureCurrent = (): void => {
    if (currentWorkspace() !== workspace || cachedWorkspace !== workspace || !cached.includes(automation)) throw new Error('The Zernio workspace changed. Please try again.')
  }
  try {
    const path = join(bankPath(workspace, automation.id), item.fileName)
    if (!isAutomationMedia(path)) throw new Error('Clip file is missing from the content bank.')
    authorizeMedia(path)
    source = await completeBankSource(automation, source)
    ensureCurrent()
    if (!item.transcript) {
      const transcript = await transcribeAutomationClip(path)
      ensureCurrent()
      item.transcript = transcript
      save(workspace)
    }
    const facebookFormat = platforms.includes('facebook') ? defaultFacebookFormat(await probeClipForPosting(path, null)) : 'feed'
    ensureCurrent()
    const research = options.research ? await sharedSourceResearch(workspace, automation, source, item.transcript)
      : { status: 'skipped' as const, summary: 'Web research was turned off.', sources: [] }
    ensureCurrent()
    const posts = await generateAutomationMetadata(item.transcript, item.title, item.caption, platforms, { facebookFormat, source, research })
    ensureCurrent()
    const previous = item.metadataDraft
    item.metadataError = null
    item.metadataDraft = { id: randomUUID(), createdAt: new Date().toISOString(), platforms, posts, source, research }
    try { save(workspace) } catch (error) { item.metadataDraft = previous; throw error }
    return listAutomations()
  } finally { release(automation.id) }
}

async function prepareMetadata(workspace: string, automation: Automation, item: AutomationContent, path: string): Promise<{ facebookFormat: 'feed' | 'reel'; generated: GeneratedPlatformMetadata[] | null }> {
  const facebookFormat = (automation.metadataMode === 'ai' || Boolean(item.metadataEnhancement)) && automation.accounts.some((account) => account.platform === 'facebook')
    ? defaultFacebookFormat(await probeClipForPosting(path, null)) : 'feed'
  let generated: GeneratedPlatformMetadata[] | null = null
  if (item.metadataEnhancement && item.generatedMetadata) {
    const platforms = automation.accounts.map((account) => account.platform)
    if (!platforms.every((platform) => item.generatedMetadata!.some((post) => post.platform === platform))) {
      throw new Error('The selected platforms changed. Enhance and review this clip again before posting.')
    }
    generated = item.generatedMetadata
  } else if (automation.metadataMode === 'ai') {
    const platforms = [...new Set(automation.accounts.map((account) => account.platform))]
    if (!item.transcript) {
      const transcript = await transcribeAutomationClip(path)
      if (currentWorkspace() !== workspace || !cached.includes(automation)) throw new Error('The Zernio workspace changed. Please try again.')
      item.transcript = transcript
      save(workspace)
    }
    if (!item.generatedMetadata || item.generatedMetadata.some((post) => post.topicTag === undefined) ||
        !platforms.every((platform) => item.generatedMetadata?.some((post) => post.platform === platform))) {
      // Unattended posting: the uploader-controlled description never reaches
      // the writer here. Reviewed drafts (Enhance, then Apply) may use it.
      const source = item.sourceContext ? { ...item.sourceContext, description: '' } : null
      const metadata = await generateAutomationMetadata(item.transcript, item.title, item.caption, platforms, { facebookFormat, source })
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
  if (item.metadataDraft) throw new Error('Apply or discard the enhanced draft before reviewing TikTok.')
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
  } finally { release(automation.id) }
}

export async function approveAutomationTikTokReview(id: unknown, contentId: unknown, raw: unknown): Promise<Automation[]> {
  const { workspace, automation } = find(id)
  const item = automation.content.find((content) => content.id === contentId)
  const value = raw as AutomationTikTokReviewUpdate | null
  if (!item || item.status !== 'queued' || !value || typeof value !== 'object') throw new Error('Only queued clips can be approved for TikTok.')
  if (busy.has(automation.id)) throw new Error('Wait for the current operation to finish.')
  if (item.metadataDraft) throw new Error('Apply or discard the enhanced draft before reviewing TikTok.')
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
    if (automation.lastError === TIKTOK_REVIEW_PENDING) automation.lastError = null
    try { save(workspace) }
    catch (error) {
      automation.content[automation.content.indexOf(item)] = previous
      automation.lastError = previousError
      throw error
    }
    reviews.delete(item.id)
    return listAutomations()
  } finally { release(automation.id) }
}

/** Only a stored, validated draft can be applied; renderer cannot substitute generated posts. */
export function resolveAutomationMetadataDraft(id: unknown, contentId: unknown, draftId: unknown, apply: unknown): Automation[] {
  const { workspace, automation } = find(id)
  const item = automation.content.find((content) => content.id === contentId)
  if (!item || item.status !== 'queued' || item.postId || !item.metadataDraft || item.metadataDraft.id !== draftId || typeof apply !== 'boolean') throw new Error('This draft is no longer available. Refresh the bank.')
  if (busy.has(automation.id)) throw new Error('Wait for the current operation to finish.')
  const draft = item.metadataDraft
  if (apply && !automation.accounts.every((account) => draft.platforms.includes(account.platform))) throw new Error('The selected platforms changed. Generate a new draft.')
  const previous = { ...item }
  const previousReview = reviews.get(item.id)
  const previousError = automation.lastError
  if (apply) {
    clearTikTokReview(item)
    item.generatedMetadata = draft.posts
    item.metadataEnhancement = draft
    item.sourceContext = draft.source
    const primary = draft.posts.find((post) => post.platform === 'youtube') ?? draft.posts[0]
    item.title = primary.title || item.title
    item.caption = primary.caption
  }
  item.metadataDraft = null
  item.error = null
  // Only the drafts warning is resolved here; keep unrelated failures visible.
  if (automation.lastError === DRAFTS_PENDING) automation.lastError = null
  try { save(workspace) } catch (error) {
    Object.assign(item, previous)
    automation.lastError = previousError
    if (previousReview) reviews.set(item.id, previousReview)
    throw error
  }
  return listAutomations()
}

/**
 * Posting takes priority over other work. Releasing the lock runs any slot
 * that came due meanwhile; runAutomation takes the lock synchronously, before
 * another request (for example, the next enhancement batch) can.
 */
function release(automationId: string): void {
  busy.delete(automationId)
  const waiting = deferredSlots.get(automationId)
  if (!waiting?.size) return
  deferredSlots.delete(automationId)
  void (async () => {
    for (const entry of waiting.values()) await runDeferredSlot(automationId, entry)
  })().catch((error) => logger.warn('automation.scheduler.failed', { message: error instanceof Error ? error.message : 'Unknown error' }))
}

async function runDeferredSlot(automationId: string, entry: { slot: { time: string; date: string }; since: number }): Promise<void> {
  const { workspace, automation } = find(automationId)
  const { slot } = entry
  if (!automation.enabled || !automation.times.includes(slot.time) || automation.lastSlots[slot.time] === slot.date) return
  if (Date.now() - entry.since <= MAX_SLOT_DEFERRAL_MS) { await runAutomation(automationId, slot); return }
  if (busy.has(automation.id)) return
  automation.lastSlots[slot.time] = slot.date
  automation.lastError = `The ${slot.time} post was skipped because another task on this automation ran for too long. The next scheduled time will post as usual.`
  automation.lastErrorAcknowledged = false
  save(workspace)
  logger.warn('automation.slot.missed', { automationId })
}

/** Retry one pre-submit failure without changing queue order or post identity. */
export async function retryAutomationContent(id: unknown, contentId: unknown): Promise<Automation[]> {
  const { automation } = find(id)
  if (busy.has(automation.id)) throw new Error('Wait for the current operation to finish.')
  const item = automation.content.find((entry) => entry.id === contentId)
  if (!item || item.status !== 'queued' || item.postId || !item.error) throw new Error('Choose a failed, unposted queued clip to retry.')
  if (item.metadataDraft) throw new Error('Apply or discard this clip’s metadata draft before retrying.')
  if (needsTikTokReview(automation, item)) throw new Error('Review this clip for TikTok before retrying.')
  return runAutomation(id, undefined, item.id)
}

export async function runAutomation(id: unknown, slot?: { time: string; date: string }, contentId?: string, catchUp = false): Promise<Automation[]> {
  const { workspace, automation } = find(id)
  if (slot && (!automation.enabled || automation.lastSlots[slot.time] === slot.date)) return listAutomations()
  if (busy.has(automation.id)) {
    // Keep a due slot instead of dropping it; release() runs it next.
    if (slot) {
      const waiting = deferredSlots.get(automation.id) ?? new Map()
      const key = `${slot.date}/${slot.time}`
      if (!waiting.has(key)) waiting.set(key, { slot, since: Date.now() })
      deferredSlots.set(automation.id, waiting)
    }
    return listAutomations()
  }
  const item = contentId === undefined ? nextAutomationContent(automation) : automation.content.find((entry) => entry.id === contentId)
  if (!item) {
    const queued = automation.content.filter((content) => content.status === 'queued')
    const message = queued.some((content) => content.metadataDraft) ? DRAFTS_PENDING : queued.length ? TIKTOK_REVIEW_PENDING : NO_QUEUED_CLIPS
    // Warn again for every new blocked slot or manual run, even with the same message.
    const key = slot ? `${slot.date}/${slot.time}` : null
    let changed = false
    // A late slot is used up even with nothing ready, so clips added later
    // wait for the next scheduled time instead of posting the moment they arrive.
    if (slot && catchUp) { automation.lastSlots[slot.time] = slot.date; changed = true }
    if (automation.lastError !== message || !key || blockedSlots.get(automation.id) !== key) {
      automation.lastError = message
      automation.lastErrorAcknowledged = false
      if (key) blockedSlots.set(automation.id, key)
      changed = true
    }
    if (changed) save(workspace)
    return listAutomations()
  }
  const hadTikTokApproval = automation.accounts.some((account) => account.platform === 'tiktok') && item.tiktokApproval != null
  // Waiting for approval is not an attempt. A clip approved during the wake-up
  // grace period can still use the slot; actual attempts reserve it once.
  if (slot) { automation.lastSlots[slot.time] = slot.date; save(workspace) }
  if (!automation.profileId || automation.accounts.length === 0) {
    automation.lastErrorAcknowledged = false
    automation.lastError = 'Choose one Zernio profile and at least one of its accounts.'
    save(workspace)
    return listAutomations()
  }
  let submissionStarted = false
  // Recorded with a failure: error messages can hold titles or paths and stay out of the log.
  let stage: 'accounts' | 'file' | 'metadata' | 'tiktok' | 'request' | 'publish' = 'accounts'
  busy.add(automation.id)
  try {
    checkProfileAccounts(await getZernioOverview(), automation.profileId, automation.accounts)
    if (currentWorkspace() !== workspace || !cached.includes(automation)) return []
    stage = 'file'
    const path = join(bankPath(workspace, automation.id), item.fileName)
    if (!isAutomationMedia(path)) throw new Error('Clip file is missing from the content bank.')
    const tiktokTargets = automation.accounts.filter((account) => account.platform === 'tiktok')
    if (tiktokTargets.length) assertApprovedFile(item, path)
    authorizeMedia(path)
    stage = 'metadata'
    const { facebookFormat, generated } = await prepareMetadata(workspace, automation, item, path)
    // A scheduled run must check current creator permissions even if the user
    // approved seconds ago and the publishing service still has cached info.
    stage = 'tiktok'
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
    stage = 'request'
    parsePostClipRequest(request)
    stage = 'publish'
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
      // An on-time scheduled post means the app is running again.
      if (slot && !catchUp) automation.missedNotice = null
    } else {
      item.status = 'needs_review'
      item.error = result.outcome === 'partial' ? 'Some accounts failed. Check Posts before returning this clip to the queue.' : result.message
      automation.lastError = item.error
      automation.lastErrorAcknowledged = false
      item.warningsAcknowledged = false
      logger.warn('automation.post.held', { automationId: automation.id, contentId: item.id, outcome: result.outcome })
    }
    save(workspace)
    if (catchUp && item.status === 'posted') logger.info('automation.slot.caught_up', { automationId: automation.id, contentId: item.id })
  } catch (error) {
    if (currentWorkspace() === workspace && cached.includes(automation)) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Posting failed. Check Zernio before retrying.'
      // A changed file revokes the exact TikTok review before any upload. Let
      // a fresh review use this due slot; keep reservations for other failures.
      if (slot && hadTikTokApproval && item.tiktokApproval == null && item.status === 'queued' &&
          !submissionStarted && automation.lastSlots[slot.time] === slot.date) delete automation.lastSlots[slot.time]
      if (item.status === 'posting') {
        item.status = submissionStarted ? 'needs_review' : 'queued'
        item.error = message
      } else if (item.status === 'queued') item.error = message
      automation.lastError = message
      automation.lastErrorAcknowledged = false
      item.warningsAcknowledged = false
      save(workspace)
    }
    logger.warn('automation.post.failed', { automationId: automation.id, contentId: item.id, stage, submissionStarted, ...errorSummary(error) })
  } finally { release(automation.id) }
  return listAutomations()
}

/**
 * Slots that passed while BridgeClip was closed, asleep or restarting. The
 * newest one still posts, late, unless the next scheduled time is close; the
 * rest are marked missed and reported, so a long outage never posts a burst.
 */
async function catchUpMissedSlots(automationId: string, now: number): Promise<void> {
  const { workspace, automation } = find(automationId)
  if (!automation.enabled || busy.has(automation.id)) return
  const missed = missedSlots(automation.times, automation.timezone, automation.lastSlots, now)
  if (!missed.length) return
  const postLate = !slotDueSoon(automation.times, automation.timezone, now)
  const skipped = postLate ? missed.slice(1) : missed
  for (const slot of skipped) automation.lastSlots[slot.time] = slot.date
  if (skipped.length) {
    save(workspace)
    logger.warn('automation.slot.missed', { automationId: automation.id, count: skipped.length, cause: 'not_running' })
  }
  if (postLate) await runAutomation(automation.id, missed[0], undefined, true)
  if (currentWorkspace() !== workspace || !cached.includes(automation)) return
  const late = postLate && automation.content.some((item) => item.status === 'posted' && item.postedAt && Date.parse(item.postedAt) >= now) ? missed[0].time : null
  if (skipped.length || late) {
    automation.missedNotice = { date: missed[0].date, skipped: skipped.map((slot) => slot.time).sort(), late }
    save(workspace)
  }
}

export function startAutomationScheduler(): () => void {
  // Idle sleep stops the scheduler's timers, and a slot that passes while the
  // Mac sleeps can only post late. Hold the system awake while anything is scheduled.
  let blocker: number | null = null
  const keepAwake = (wanted: boolean): void => {
    try {
      if (wanted && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension')
      else if (!wanted && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null }
    } catch (error) { logger.warn('automation.power.failed', errorSummary(error)) }
  }
  const tick = (): void => {
    try {
      if (!loadSettings().zernioApiKey) { keepAwake(false); return }
      const now = Date.now()
      const automations = listAutomations()
      keepAwake(automations.some((automation) => automation.enabled && automation.times.length > 0))
      for (const automation of automations) {
        if (!automation.enabled) continue
        // Distinct automations can post together; one slow upload must not delay another account's slot.
        void (async () => {
          for (const slot of dueSlots(automation.times, automation.timezone, now)) await runAutomation(automation.id, slot)
          await catchUpMissedSlots(automation.id, now)
        })().catch((error) => logger.warn('automation.scheduler.failed', { message: error instanceof Error ? error.message : 'Unknown error' }))
      }
    } catch (error) {
      logger.warn('automation.scheduler.failed', { message: error instanceof Error ? error.message : 'Unknown error' })
    }
  }
  const timer = setInterval(tick, 15_000)
  setTimeout(tick, 2_000)
  return () => { clearInterval(timer); keepAwake(false) }
}
