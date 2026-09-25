import type { ZernioPlatform } from './zernio'
import type { ClipMediaInfo, TikTokCreatorInfo, TikTokPostOptions, YouTubeVisibility } from './zernio-posts'

/** TikTok clips require review before the scheduler can publish them. */
export const AUTOMATION_PLATFORMS = ['instagram', 'youtube', 'twitter', 'facebook', 'linkedin', 'threads', 'tiktok'] as const satisfies readonly ZernioPlatform[]

export interface AutomationTikTokApproval {
  caption: string
  options: TikTokPostOptions
  reviewedAt: string
  fileStamp: { size: number; mtimeMs: number; ino: number }
}

export interface AutomationTikTokReview {
  reviewId: string
  clipPath: string
  caption: string
  media: ClipMediaInfo
  creators: { info: TikTokCreatorInfo; businessConnection: boolean; handle: string }[]
}

export interface AutomationTikTokReviewUpdate {
  reviewId: string
  caption: string
  options: TikTokPostOptions
  previewConfirmed: boolean
}

export interface AutomationAccount {
  accountId: string
  platform: (typeof AUTOMATION_PLATFORMS)[number]
}

export type AutomationContentStatus = 'queued' | 'posting' | 'posted' | 'needs_review'

export interface GeneratedPlatformMetadata {
  platform: AutomationAccount['platform']
  caption: string
  /** YouTube, or Facebook when the clip is posted as a Reel. */
  title: string | null
  tags: string[]
  categoryId: string | null
  /** Threads only. Optional so older saved metadata remains readable. */
  topicTag?: string | null
}

export interface AutomationContent {
  id: string
  /** Changes only after a person reviews an uncertain post and returns the clip to the queue. */
  postingAttemptId?: string
  fileName: string
  title: string
  caption: string
  /** Speech recognized from this exact bank clip; never inferred from its filename. */
  transcript: string | null
  generatedMetadata: GeneratedPlatformMetadata[] | null
  /** The exact TikTok caption and choices approved for this clip; absent in older banks. */
  tiktokApproval?: AutomationTikTokApproval | null
  /** Keeps the last reviewed copy when approval is revoked to reopen the editor. */
  tiktokDraftCaption?: string | null
  status: AutomationContentStatus
  addedAt: string
  postedAt: string | null
  postId: string | null
  error: string | null
}

export interface Automation {
  id: string
  name: string
  enabled: boolean
  /** Exactly one Zernio profile owns this automation's selected accounts. */
  profileId: string | null
  /** Automations start with manual captions; AI metadata is opt-in. */
  metadataMode: 'ai' | 'manual'
  accounts: AutomationAccount[]
  /** Daily times in the configured IANA time zone, as HH:mm. */
  times: string[]
  timezone: string
  youtubeVisibility: YouTubeVisibility
  youtubeMadeForKids: boolean
  /** Time -> most recent local YYYY-MM-DD that was attempted. */
  lastSlots: Record<string, string>
  content: AutomationContent[]
  createdAt: string
  lastRunAt: string | null
  lastError: string | null
}

export interface AutomationUpdate {
  name: string
  enabled: boolean
  profileId: string | null
  metadataMode: 'ai' | 'manual'
  accounts: AutomationAccount[]
  times: string[]
  timezone: string
  youtubeVisibility: YouTubeVisibility
  youtubeMadeForKids: boolean
}

export function needsTikTokReview(automation: Pick<Automation, 'accounts'>, item: AutomationContent): boolean {
  const targets = automation.accounts.filter((account) => account.platform === 'tiktok')
  return targets.length > 0 && (!item.tiktokApproval?.options.consent ||
    targets.some((target) => !item.tiktokApproval?.options.accounts[target.accountId]?.privacyLevel))
}

export function nextAutomationContent(automation: Pick<Automation, 'accounts' | 'content'>): AutomationContent | undefined {
  return automation.content.find((item) => item.status === 'queued' && !needsTikTokReview(automation, item))
}

/** Return due local slots, including a short grace period after wake/reopen. */
export function dueSlots(times: readonly string[], timezone: string, now: number, graceMinutes = 5): { time: string; date: string }[] {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23'
  })
  const wanted = new Set(times)
  const found = new Set<string>()
  const slots: { time: string; date: string }[] = []
  for (let minutesAgo = graceMinutes - 1; minutesAgo >= 0; minutesAgo--) {
    const parts = Object.fromEntries(formatter.formatToParts(now - minutesAgo * 60_000).map((part) => [part.type, part.value]))
    const time = `${parts.hour}:${parts.minute}`
    const date = `${parts.year}-${parts.month}-${parts.day}`
    const key = `${date}/${time}`
    if (wanted.has(time) && !found.has(key)) { found.add(key); slots.push({ time, date }) }
  }
  return slots
}
