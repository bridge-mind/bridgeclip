import { randomUUID } from 'crypto'
import { basename, join } from 'path'
import { dialog, shell, type BrowserWindow } from 'electron'
import { CAPTION_PRESETS, isCaptionPresetId } from '../../shared/caption-presets'
import type { AssistantNavigationPage } from '../../shared/assistant'
import { DURATION_IDS, DURATION_OPTIONS, VIDEO_SPEED_OPTIONS, CLIP_REQUEST_MAX_CHARS } from '../../shared/job-contract'
import type { ClipJobRequest, JobSnapshot } from '../../shared/jobs'
import { isActiveJobStatus } from '../../shared/jobs'
import type { JobOutput } from '../../shared/job-output'
import type { Automation, AutomationUpdate } from '../../shared/automations'
import { AUTOMATION_PLATFORMS } from '../../shared/automations'
import type { CandidateEdit } from '../../shared/clip-editor'
import { defaultCaption, defaultFacebookFormat, youtubeTitleFor, type PostClipRequest, type PostRecord } from '../../shared/zernio-posts'
import { isPostableAccount, ZERNIO_PLATFORM_NAMES, type ZernioAccount, type ZernioPlatform } from '../../shared/zernio'
import { loadSettings, publicSettings, savePublicSettings } from '../settings-store'
import { getJobHistory, getJobOutput } from '../file-manager'
import { cancelTrackedJob, getJob, listJobs, liveJobIds, onJobUpdate } from '../job-manager'
import { startClipJobRequest } from '../job-start'
import { listCaptionStyles } from '../caption-library'
import { loadCaptionPreferences } from '../caption-preferences'
import { defaultCaptionId } from '../../shared/caption-preferences'
import { authorizeMedia, isWebUrl } from '../security'
import { getYouTubePreview } from '../youtube-preview'
import { resolveBinary } from '../tools'
import { findYouTubeVideos, ytDlpRunner } from './youtube-discovery'
import { deleteLibraryClips, deleteLibraryRun, setLibraryFavorite, setLibraryPosted } from '../library-management'
import { libraryPostingStatus } from '../library-posting'
import { inspectEdits } from '../edit-inspector'
import { openEditor, runEditor, saveEditor } from '../clip-editor'
import {
  addLibraryClipsToAutomation,
  createAutomation,
  deleteAutomation,
  listAutomations,
  removeAutomationContent,
  reorderAutomationContent,
  runAutomation,
  updateAutomation,
  updateAutomationContent
} from '../automations'
import { getZernioOverview, readCachedOverview } from '../zernio/service'
import { cancelPost, listPosts, probeClipForPosting, publishClip, refreshPosts, reschedulePost, retryPost } from '../zernio/posts'
import { logger } from '../logger'
import { AssistantToolError, type AssistantToolSpec } from './tool-types'

export type DataScope = 'library' | 'automations' | 'posts' | 'settings' | 'accounts'
export type AppPage = AssistantNavigationPage

export interface ToolHost {
  getMainWindow: () => BrowserWindow | null
  /** Tell the window that main-side data changed, so open pages reload it. */
  dataChanged: (scope: DataScope) => void
  /** Show a page (and optionally a Library run) in the window. */
  navigate: (page: AppPage, runDir?: string) => void
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ID_PATTERN = '^[A-Za-z0-9_-]{1,64}$'

const runIdProperty = { type: 'string', description: 'A Library run id: the runId from list_library_runs, or a jobId (they are the same).', pattern: UUID.source }
const clipIndexProperty = { type: 'integer', minimum: 0, maximum: 999, description: 'clipIndex from get_library_run.' }
const captionStyleProperty = { type: 'string', minLength: 1, maxLength: 64, description: 'A default or saved custom caption style id from get_clip_options. Use the id, not its name.' }

function resolveCaptionStyle(id?: unknown): Pick<ClipJobRequest, 'captionPreset' | 'customCaption'> {
  if (id === undefined) id = defaultCaptionId(loadCaptionPreferences(), listCaptionStyles())
  if (isCaptionPresetId(id)) return { captionPreset: id }
  const customCaption = listCaptionStyles().find((style) => style.id === id)
  if (!customCaption) throw new AssistantToolError('Caption style not found. Call get_clip_options for current default and saved custom preset ids.')
  return { captionPreset: customCaption.baseId, customCaption }
}

function object(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false }
}

function seconds(ms: number | null | undefined): number | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? Math.round(ms / 100) / 10 : null
}

function libraryPath(runId: unknown): string {
  if (typeof runId !== 'string' || !UUID.test(runId)) throw new AssistantToolError('runId must be a run id from list_library_runs.')
  return join(loadSettings().outputDirectory, runId)
}

/** Source shown to the agent: links as-is, local files by name only. */
function sourceLabel(source: string): string {
  return isWebUrl(source) ? source : basename(source)
}

function jobView(job: JobSnapshot): Record<string, unknown> {
  return {
    jobId: job.id,
    runId: job.id,
    status: job.status,
    active: isActiveJobStatus(job.status),
    percent: Math.round(job.percent),
    step: job.step,
    source: sourceLabel(job.request.videoUrl),
    workflow: job.request.workflow ?? 'automatic',
    clipsDone: job.clipsDone,
    clipsTotal: job.clipsTotal,
    error: job.error,
    errorHint: job.errorHint,
    queuedAt: job.queuedAt,
    finishedAt: job.finishedAt,
    ...(job.output ? { videoTitle: job.output.source_video_title, clipCount: job.output.total_clips } : {})
  }
}

function clipView(clip: JobOutput['clips'][number]): Record<string, unknown> {
  return {
    clipIndex: clip.clip_index,
    title: clip.summary || `Clip ${clip.clip_index + 1}`,
    durationSeconds: seconds(clip.duration_ms),
    sourceStartSeconds: seconds(clip.start_time_ms),
    sourceEndSeconds: seconds(clip.end_time_ms),
    viralityScore: clip.virality_score,
    tags: clip.tags,
    layout: clip.layout_type
  }
}

async function runOutput(runId: unknown): Promise<{ path: string; output: JobOutput }> {
  const path = libraryPath(runId)
  const output = await getJobOutput(path, loadSettings().outputDirectory)
  if (!output) throw new AssistantToolError('That run has no finished clips in the Library (it may have failed, been deleted, or still be running).')
  return { path, output }
}

function clipFile(clip: JobOutput['clips'][number]): string {
  return clip.s3_url.startsWith('file://') ? clip.s3_url.slice('file://'.length) : clip.s3_url
}

function automationView(automation: Automation, includeContent = true): Record<string, unknown> {
  const counts = { queued: 0, posting: 0, posted: 0, needs_review: 0 }
  for (const item of automation.content) counts[item.status] += 1
  return {
    automationId: automation.id,
    name: automation.name,
    enabled: automation.enabled,
    profileId: automation.profileId,
    metadataMode: automation.metadataMode,
    accounts: automation.accounts,
    times: automation.times,
    timezone: automation.timezone,
    youtubeVisibility: automation.youtubeVisibility,
    youtubeMadeForKids: automation.youtubeMadeForKids,
    counts,
    lastRunAt: automation.lastRunAt,
    lastError: automation.lastError,
    ...(includeContent ? {
      content: automation.content.slice(0, 60).map((item) => ({
        contentId: item.id,
        title: item.title,
        caption: item.caption.length > 300 ? `${item.caption.slice(0, 299)}…` : item.caption,
        status: item.status,
        addedAt: item.addedAt,
        postedAt: item.postedAt,
        error: item.error,
        hasPendingDraft: Boolean(item.metadataDraft)
      })),
      ...(automation.content.length > 60 ? { contentNote: `Showing the first 60 of ${automation.content.length} clips.` } : {})
    } : {})
  }
}

function findAutomation(id: unknown): Automation {
  const automation = listAutomations().find((item) => item.id === id)
  if (!automation) throw new AssistantToolError('No automation with that automationId. Call list_automations.')
  return automation
}

function postView(post: PostRecord): Record<string, unknown> {
  return {
    postId: post.id,
    clipTitle: post.clipTitle,
    status: post.status,
    scheduledFor: post.scheduledFor,
    timezone: post.timezone,
    createdAt: post.createdAt,
    error: post.error,
    targets: post.targets.map((target) => ({ platform: target.platform, handle: target.handle, status: target.status, url: target.url, error: target.error }))
  }
}

async function socialAccounts(): Promise<ZernioAccount[]> {
  if (!loadSettings().zernioApiKey) throw new AssistantToolError('No Zernio key is saved. The user can connect social accounts in Accounts (Zernio key in Settings).')
  try {
    return (await getZernioOverview()).accounts
  } catch (error) {
    const cached = readCachedOverview()
    if (cached) return cached.accounts
    throw error
  }
}

function accountLabel(account: ZernioAccount): string {
  const name = account.username ? `@${account.username.replace(/^@/, '')}` : account.displayName ?? account.id
  return `${ZERNIO_PLATFORM_NAMES[account.platform as ZernioPlatform] ?? account.platform} ${name}`
}

function waitForJob(jobId: string, timeoutMs: number, signal: AbortSignal): Promise<JobSnapshot | null> {
  return new Promise((resolve) => {
    const current = getJob(jobId)
    if (!current || !isActiveJobStatus(current.status)) return resolve(current)
    let unsubscribe = (): void => {}
    const finish = (): void => {
      clearTimeout(timer)
      unsubscribe()
      signal.removeEventListener('abort', finish)
      resolve(getJob(jobId))
    }
    const timer = setTimeout(finish, timeoutMs)
    signal.addEventListener('abort', finish, { once: true })
    unsubscribe = onJobUpdate((snapshot) => {
      if (snapshot.id === jobId && !isActiveJobStatus(snapshot.status)) finish()
    })
  })
}

/** The full Create-page request for start_clip_job's input, with the Create page's defaults. */
export function clipJobRequestFromInput(input: Record<string, unknown>): ClipJobRequest {
  const mode = (input.mode as 'quality' | 'economy' | undefined) ?? 'quality'
  const aspectRatio = (input.aspectRatio as string | undefined) ?? '9:16'
  const layout = (input.layout as string | undefined) ?? 'auto'
  return {
    videoUrl: String(input.source).trim(),
    workflow: (input.workflow as 'automatic' | 'review' | undefined) ?? 'automatic',
    clippingMode: mode,
    ...(typeof input.clipRequest === 'string' && input.clipRequest.trim() ? { clipRequest: input.clipRequest.trim() } : {}),
    maxClips: typeof input.maxClips === 'number' ? input.maxClips : null,
    autoClipCount: typeof input.maxClips !== 'number',
    durationRanges: (input.durations as string[] | undefined) ?? ['short'],
    aspectRatio,
    layoutStyle: layout,
    layoutVision: mode !== 'economy' && aspectRatio === '9:16' && layout === 'auto',
    pacing: (input.pacing as string | undefined) ?? 'tight',
    videoSpeed: (input.speed as number | undefined) ?? 1,
    includeCaptions: input.captions !== false,
    ...resolveCaptionStyle(input.captionStyle),
    includeTitle: input.titleCard !== false,
    startTimeSeconds: (input.startSeconds as number | undefined) ?? null,
    endTimeSeconds: (input.endSeconds as number | undefined) ?? null,
    bannerPlatform: null,
    bannerChannelUrl: null
  }
}

/** Background review-project exports: the tool returns at once and reports progress later. */
const editorRuns = new Map<string, { action: string; startedAt: string; finishedAt: string | null; error: string | null }>()

export function createBridgeClipTools(host: ToolHost): AssistantToolSpec[] {
  // Preserve the exact style shown for approval even if its saved preset changes
  // while the card is open. Denied calls can be garbage collected with their input.
  const approvedJobRequests = new WeakMap<Record<string, unknown>, ClipJobRequest>()
  const tools: AssistantToolSpec[] = [
    // ── Overview and options ──────────────────────────────────────────────
    {
      name: 'get_overview',
      title: 'Checked BridgeClip status',
      description: 'Current state of BridgeClip: whether the OpenRouter key (needed to make clips) and Zernio key (needed to post) are set, running and queued jobs, Library size and automations. Call this first when you need context.',
      inputSchema: object({}),
      readOnly: true,
      run: async () => {
        const settings = loadSettings()
        const jobs = listJobs()
        const history = await getJobHistory(settings.outputDirectory, liveJobIds()).catch(() => [])
        // Automations belong to a Zernio workspace, so there are none to list without a key.
        let automations: Automation[] | null = null
        try { automations = settings.zernioApiKey ? listAutomations() : null } catch { automations = null }
        return {
          openrouterKeySaved: Boolean(settings.openrouterApiKey),
          zernioKeySaved: Boolean(settings.zernioApiKey),
          libraryFolder: settings.outputDirectory,
          jobs: {
            running: jobs.filter((job) => isActiveJobStatus(job.status) && job.status !== 'queued').length,
            queued: jobs.filter((job) => job.status === 'queued').length,
            finishedThisSession: jobs.filter((job) => !isActiveJobStatus(job.status)).length
          },
          library: {
            runs: history.length,
            completedRuns: history.filter((entry) => entry.status === 'completed').length,
            clips: history.reduce((sum, entry) => sum + (entry.clipCount || 0), 0)
          },
          automations: automations
            ? { total: automations.length, enabled: automations.filter((item) => item.enabled).length }
            : { total: 0, enabled: 0, note: 'Automations need a Zernio key (Settings) and connected accounts.' },
          now: new Date().toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
        }
      }
    },
    {
      name: 'get_clip_options',
      title: 'Read clip options',
      description: 'Current default caption styles and saved custom caption presets from the Captions lab, plus clip lengths, speeds, aspect ratios, workflows and modes. Use the returned caption ids with start_clip_job or update_review_candidates. Read this to answer questions about saved caption presets; they are separate from Settings.',
      inputSchema: object({}),
      readOnly: true,
      run: async () => {
        const styles = listCaptionStyles()
        const preferences = loadCaptionPreferences()
        const defaultId = defaultCaptionId(preferences, styles)
        return {
          captionStyles: CAPTION_PRESETS,
          customCaptionStyles: styles.map(({ id, name }) => ({ id, name })),
          defaultCaptionStyle: defaultId,
          defaultCaptionStyleName: CAPTION_PRESETS.find(style => style.id === defaultId)?.name ?? styles.find(style => style.id === defaultId)?.name,
          captionDefaultMode: preferences.defaultId ? 'selected-preset' : 'first-bookmark',
          captionDefaultSetting: 'Captions → Default caption. First bookmark uses the first available bookmarked style, or Pop when none are available.',
          durations: DURATION_OPTIONS,
          speeds: VIDEO_SPEED_OPTIONS,
          aspectRatios: ['9:16 (vertical, for TikTok/Reels/Shorts)', '16:9 (horizontal)'],
          workflows: {
            automatic: 'Finds, checks and exports clips with no further input. Best default.',
            review: 'Builds a review project of candidate clips; nothing is exported until clips are marked ready and exported (see get_review_project).'
          },
          modes: { quality: 'Best results (default).', economy: 'Cheaper planning model, no paid vision checks.' },
          layouts: { auto: 'Smart per-shot framing (default for 9:16).', fill: 'Always crop to fill the frame.', fit: 'Letterbox the full frame.' },
          pacing: { tight: 'Cut dead air and filler words (default).', natural: 'Keep original timing.' }
        }
      }
    },
    {
      name: 'preview_video',
      title: 'Looked up a video',
      description: 'Title, channel, duration, views and upload date for a YouTube link, without downloading it.',
      inputSchema: object({ url: { type: 'string', maxLength: 2048 } }, ['url']),
      readOnly: true,
      run: async (input) => getYouTubePreview(input.url, true)
    },
    {
      name: 'find_youtube_videos',
      title: 'Looked on YouTube',
      description: 'Find YouTube videos and their links. With channel (an @handle, a channel link, or a channel name such as "BridgeMind"), lists that channel\'s newest uploads and live streams, newest first; a name is matched to YouTube\'s best channel and the runners-up are returned too. With query, searches YouTube (sort "relevance" or "newest"). Returns each video\'s title, link, channel, approximate publish date, duration, views and live status. Use this whenever the user names a channel or video without giving a link; never guess a link. Streams that are "live now", "upcoming" or "processing" can\'t be clipped yet.',
      inputSchema: object({
        channel: { type: 'string', minLength: 1, maxLength: 200, description: 'An @handle, channel link, or channel name.' },
        query: { type: 'string', minLength: 1, maxLength: 200, description: 'Words to search YouTube for, when not listing a channel.' },
        sort: { type: 'string', enum: ['newest', 'relevance'], description: 'For query searches. Default relevance.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'How many videos. Default 8.' }
      }),
      readOnly: true,
      describe: (input) => input.channel ? `Looked up ${String(input.channel).slice(0, 60)} on YouTube` : `Searched YouTube for “${String(input.query ?? '').slice(0, 60)}”`,
      run: async (input) => findYouTubeVideos(input, ytDlpRunner(resolveBinary('yt-dlp')))
    },
    {
      name: 'pick_local_video',
      title: 'Asked you to choose a video file',
      description: 'Opens a file picker so the user can choose a video on their computer. Returns its path for start_clip_job. Only files the user picks here can be clipped.',
      inputSchema: object({}),
      run: async () => {
        const window = host.getMainWindow()
        if (!window || window.isDestroyed()) throw new AssistantToolError('Open the BridgeClip window first.')
        window.focus()
        const result = await dialog.showOpenDialog(window, {
          properties: ['openFile'],
          title: 'Choose a video to clip',
          filters: [{ name: 'Video Files', extensions: ['mp4', 'm4v', 'mkv', 'webm', 'avi', 'mov', 'flv'] }]
        })
        if (result.canceled || !result.filePaths.length) return { picked: false, summary: 'No file chosen' }
        const path = authorizeMedia(result.filePaths[0])
        return { picked: true, path, name: basename(path), summary: basename(path) }
      }
    },

    // ── Clipping jobs ─────────────────────────────────────────────────────
    {
      name: 'start_clip_job',
      title: 'Start a clipping job',
      description: 'Turn a video into short clips. source is a public video URL (YouTube, Twitch VOD, direct link) or a path from pick_local_video. All other fields are optional with good defaults. Uses the user\'s OpenRouter credit, so the app asks them to approve it. Returns a jobId; use wait_for_job to follow it.',
      inputSchema: object({
        source: { type: 'string', minLength: 1, maxLength: 8192, description: 'Video URL, or a path returned by pick_local_video.' },
        workflow: { type: 'string', enum: ['automatic', 'review'], description: 'Default automatic.' },
        mode: { type: 'string', enum: ['quality', 'economy'], description: 'Default quality.' },
        aspectRatio: { type: 'string', enum: ['9:16', '16:9'], description: 'Default 9:16.' },
        captions: { type: 'boolean', description: 'Burn in captions. Default true.' },
        captionStyle: { ...captionStyleProperty, description: `${captionStyleProperty.description} Omit to use the saved Default caption preference reported by get_clip_options.` },
        titleCard: { type: 'boolean', description: 'Title card at the top of Automatic clips. Default true.' },
        durations: { type: 'array', items: { type: 'string', enum: DURATION_IDS }, minItems: 1, maxItems: DURATION_IDS.length, description: 'Clip length ranges. Default ["short"] (30–60s).' },
        maxClips: { type: 'integer', minimum: 1, maximum: 100, description: 'Exact number of clips. Omit to let BridgeClip decide.' },
        speed: { type: 'number', enum: [...VIDEO_SPEED_OPTIONS], description: 'Playback speed for every clip. Default 1.' },
        pacing: { type: 'string', enum: ['tight', 'natural'] },
        layout: { type: 'string', enum: ['auto', 'fill', 'fit'] },
        startSeconds: { type: 'number', minimum: 0, description: 'Only use the source from this time.' },
        endSeconds: { type: 'number', minimum: 0, description: 'Only use the source up to this time.' },
        clipRequest: { type: 'string', maxLength: CLIP_REQUEST_MAX_CHARS, description: 'What to clip, in the user\'s words (topics, moments, people). Omit for the best moments.' }
      }, ['source']),
      describe: () => 'Start a clipping job',
      confirm: async (input) => {
        const request = clipJobRequestFromInput(input)
        approvedJobRequests.set(input, request)
        const source = String(input.source)
        let label = sourceLabel(source)
        if (isWebUrl(source)) {
          try {
            const preview = await getYouTubePreview(source, false)
            if (preview.title) label = `${preview.title}${preview.channel ? ` (${preview.channel})` : ''}`
          } catch { /* not YouTube, or offline: show the link */ }
        }
        const durations = ((input.durations as string[] | undefined) ?? ['short']).map((id) => {
          const option = DURATION_OPTIONS.find((item) => item.id === id)
          return option ? `${option.label} ${option.range}` : id
        })
        const presetName = request.customCaption?.name ?? CAPTION_PRESETS.find((item) => item.id === request.captionPreset)?.name
        return [
          `Video: ${label}`,
          `${input.workflow === 'review' ? 'Review & edit' : 'Automatic'} · ${input.mode === 'economy' ? 'Economy' : 'Quality'} · ${input.aspectRatio ?? '9:16'}${input.speed && input.speed !== 1 ? ` · ${input.speed}×` : ''}`,
          `${typeof input.maxClips === 'number' ? `${input.maxClips} clips` : 'BridgeClip picks the number of clips'} · ${durations.join(', ')}`,
          input.captions === false ? 'No captions' : `Captions: ${presetName}`,
          ...(input.clipRequest ? [`Focus: “${String(input.clipRequest).slice(0, 200)}”`] : []),
          'Uses your OpenRouter credit for transcription and planning.'
        ]
      },
      run: async (input) => {
        const request = approvedJobRequests.get(input) ?? clipJobRequestFromInput(input)
        approvedJobRequests.delete(input)
        const result = await startClipJobRequest(request)
        if ('error' in result) throw new AssistantToolError(result.error)
        return { ...jobView(result.job), queued: result.queued, summary: result.queued ? 'Queued' : 'Started' }
      }
    },
    {
      name: 'list_jobs',
      title: 'Checked jobs',
      description: 'Clipping jobs from this app session (queued, running and finished), newest first. Older runs are in list_library_runs.',
      inputSchema: object({}),
      readOnly: true,
      run: async () => ({ jobs: listJobs().slice(0, 30).map(jobView) })
    },
    {
      name: 'get_job',
      title: 'Checked a job',
      description: 'Progress and result of one clipping job.',
      inputSchema: object({ jobId: { type: 'string', pattern: UUID.source } }, ['jobId']),
      readOnly: true,
      run: async (input) => {
        const job = getJob(String(input.jobId))
        if (!job) throw new AssistantToolError('No job with that id in this session. Finished runs from earlier sessions are in list_library_runs.')
        return jobView(job)
      }
    },
    {
      name: 'wait_for_job',
      title: 'Waited for a job',
      description: 'Wait until a job finishes (or the timeout passes) and return its state. Clipping usually takes several minutes; call again if it is still running.',
      inputSchema: object({
        jobId: { type: 'string', pattern: UUID.source },
        timeoutSeconds: { type: 'integer', minimum: 5, maximum: 600, description: 'Default 240.' }
      }, ['jobId']),
      readOnly: true,
      describe: () => 'Waiting for the job',
      run: async (input, context) => {
        const job = await waitForJob(String(input.jobId), ((input.timeoutSeconds as number | undefined) ?? 240) * 1000, context.signal)
        if (!job) throw new AssistantToolError('No job with that id in this session.')
        const view = jobView(job)
        return { ...view, finished: !isActiveJobStatus(job.status), summary: `${job.status}${isActiveJobStatus(job.status) ? ` · ${Math.round(job.percent)}%` : ''}` }
      }
    },
    {
      name: 'cancel_job',
      title: 'Cancel a job',
      description: 'Cancel a queued or running clipping job. Work done so far is discarded.',
      inputSchema: object({ jobId: { type: 'string', pattern: UUID.source } }, ['jobId']),
      confirm: (input) => {
        const job = getJob(String(input.jobId))
        return [`Cancel the job for ${job ? sourceLabel(job.request.videoUrl) : 'this video'}${job ? ` (${job.status}, ${Math.round(job.percent)}%)` : ''}.`, 'Progress so far is discarded.']
      },
      run: async (input) => {
        if (!cancelTrackedJob(String(input.jobId))) throw new AssistantToolError('That job is not queued or running.')
        return { cancelled: true, summary: 'Cancelled' }
      }
    },

    // ── Library ───────────────────────────────────────────────────────────
    {
      name: 'list_library_runs',
      title: 'Browsed the Library',
      description: 'Clipping runs in the Library, newest first, with clip counts. Filter by text in the video title or by status.',
      inputSchema: object({
        search: { type: 'string', maxLength: 200 },
        status: { type: 'string', enum: ['completed', 'failed', 'cancelled', 'running', 'interrupted', 'incomplete'] },
        bookmarkedOnly: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 20.' },
        offset: { type: 'integer', minimum: 0 }
      }),
      readOnly: true,
      run: async (input) => {
        const history = await getJobHistory(loadSettings().outputDirectory, liveJobIds())
        const search = typeof input.search === 'string' ? input.search.toLowerCase() : ''
        const matching = history.filter((entry) =>
          (!search || entry.videoTitle.toLowerCase().includes(search)) &&
          (!input.status || entry.status === input.status) &&
          (!input.bookmarkedOnly || entry.favorite))
        const offset = (input.offset as number | undefined) ?? 0
        const limit = (input.limit as number | undefined) ?? 20
        return {
          total: matching.length,
          runs: matching.slice(offset, offset + limit).map((entry) => ({
            runId: entry.jobId,
            title: entry.videoTitle,
            date: entry.date,
            status: entry.status,
            clipCount: entry.clipCount,
            bookmarked: Boolean(entry.favorite),
            reviewProject: Boolean(entry.editorProject),
            ...(entry.editorProject ? { candidateCount: entry.candidateCount ?? null } : {}),
            costUsd: entry.totalCostUsd,
            error: entry.errorMessage
          }))
        }
      }
    },
    {
      name: 'get_library_run',
      title: 'Opened a Library run',
      description: 'The clips in one Library run: titles, lengths, timecodes in the source, virality scores, tags and whether each has been posted.',
      inputSchema: object({ runId: runIdProperty }, ['runId']),
      readOnly: true,
      run: async (input) => {
        const { path, output } = await runOutput(input.runId)
        const statuses = await libraryPostingStatus(path).catch(() => [])
        return {
          runId: output.job_id,
          videoTitle: output.source_video_title,
          channel: output.source_video_channel ?? null,
          source: sourceLabel(output.source_video_url),
          sourceDurationSeconds: output.source_video_duration_seconds,
          reviewProject: Boolean(output.editor_project),
          clips: output.clips.map((clip) => {
            const status = statuses.find((item) => item.clipIndex === clip.clip_index)
            return { ...clipView(clip), posting: status ? { state: status.state, platforms: status.platforms, markedPostedByHand: Boolean(status.manuallyPosted) } : null }
          }),
          ...(output.editor_project ? { note: 'This is a Review & edit run. Use get_review_project to see candidates and export them.' } : {})
        }
      }
    },
    {
      name: 'get_run_transcript',
      title: 'Read a transcript',
      description: 'The saved transcript of a run\'s source video with timecodes. Use a time window or maxChars for long videos.',
      inputSchema: object({
        runId: runIdProperty,
        startSeconds: { type: 'number', minimum: 0 },
        endSeconds: { type: 'number', minimum: 0 },
        maxChars: { type: 'integer', minimum: 500, maximum: 50000, description: 'Default 20000.' }
      }, ['runId']),
      readOnly: true,
      run: async (input) => {
        const audit = await inspectEdits(libraryPath(input.runId), loadSettings().outputDirectory)
        const start = ((input.startSeconds as number | undefined) ?? 0) * 1000
        const end = typeof input.endSeconds === 'number' ? input.endSeconds * 1000 : Infinity
        const maxChars = (input.maxChars as number | undefined) ?? 20000
        const stamp = (ms: number): string => {
          const total = Math.floor(ms / 1000)
          const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60
          return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`
        }
        let text = ''
        let truncated = false
        for (const segment of audit.transcript) {
          if (segment.end_ms < start || segment.start_ms > end) continue
          const line = `[${stamp(segment.start_ms)}]${segment.speaker ? ` ${segment.speaker}:` : ''} ${segment.text.trim()}\n`
          if (text.length + line.length > maxChars) { truncated = true; break }
          text += line
        }
        return { title: audit.title, durationSeconds: seconds(audit.duration_ms), transcript: text, truncated }
      }
    },
    {
      name: 'bookmark_run',
      title: 'Updated a bookmark',
      description: 'Bookmark or unbookmark a Library run.',
      inputSchema: object({ runId: runIdProperty, bookmarked: { type: 'boolean' } }, ['runId', 'bookmarked']),
      run: async (input) => {
        await setLibraryFavorite(libraryPath(input.runId), input.bookmarked)
        host.dataChanged('library')
        return { bookmarked: input.bookmarked, summary: input.bookmarked ? 'Bookmarked' : 'Bookmark removed' }
      }
    },
    {
      name: 'mark_clips_posted',
      title: 'Marked clips as posted',
      description: 'Mark clips as posted (or not) in the Library, for clips the user published themselves. Only changes local Library status.',
      inputSchema: object({ runId: runIdProperty, clipIndices: { type: 'array', items: clipIndexProperty, minItems: 1, maxItems: 100 }, posted: { type: 'boolean' } }, ['runId', 'clipIndices', 'posted']),
      run: async (input) => {
        const path = libraryPath(input.runId)
        for (const index of input.clipIndices as number[]) await setLibraryPosted(path, index, input.posted)
        host.dataChanged('library')
        return { updated: (input.clipIndices as number[]).length, summary: `${(input.clipIndices as number[]).length} clip(s) marked ${input.posted ? 'posted' : 'not posted'}` }
      }
    },
    {
      name: 'delete_library_run',
      title: 'Delete a Library run',
      description: 'Permanently delete a run folder with all its clips and files. Published posts are not affected.',
      inputSchema: object({ runId: runIdProperty }, ['runId']),
      destructive: true,
      confirm: async (input) => {
        const { output } = await runOutput(input.runId)
        return [`Permanently delete “${output.source_video_title}” and its ${output.total_clips} clip(s) from your computer.`, 'This can’t be undone. Posts already published stay up.']
      },
      run: async (input) => {
        await deleteLibraryRun(libraryPath(input.runId))
        host.dataChanged('library')
        return { deleted: true, summary: 'Run deleted' }
      }
    },
    {
      name: 'delete_clips',
      title: 'Delete clips',
      description: 'Permanently delete specific clips from a Library run. The source footage and other clips stay.',
      inputSchema: object({ runId: runIdProperty, clipIndices: { type: 'array', items: clipIndexProperty, minItems: 1, maxItems: 100 } }, ['runId', 'clipIndices']),
      destructive: true,
      confirm: async (input) => {
        const { output } = await runOutput(input.runId)
        const indices = input.clipIndices as number[]
        const titles = output.clips.filter((clip) => indices.includes(clip.clip_index)).map((clip) => `• ${clip.summary || `Clip ${clip.clip_index + 1}`}`)
        return [`Permanently delete ${indices.length} clip(s) from “${output.source_video_title}”:`, ...titles.slice(0, 12), 'This can’t be undone.']
      },
      run: async (input) => {
        const output = await deleteLibraryClips(libraryPath(input.runId), input.clipIndices)
        host.dataChanged('library')
        return { remainingClips: output.total_clips, summary: `${(input.clipIndices as number[]).length} clip(s) deleted` }
      }
    },
    {
      name: 'show_in_bridgeclip',
      title: 'Opened a page in BridgeClip',
      description: 'Show a page in the BridgeClip window, e.g. a Library run after it finishes, or Automations after editing one.',
      inputSchema: object({
        page: { type: 'string', enum: ['clip', 'library', 'jobs', 'captions', 'accounts', 'posts', 'automations', 'settings'], description: 'clip is the Create page; captions is the Captions lab for browsing and editing presets.' },
        runId: { ...runIdProperty, description: 'With page "library": open this run.' }
      }, ['page']),
      run: async (input) => {
        const page = input.page as AppPage
        host.navigate(page, page === 'library' && input.runId ? libraryPath(input.runId) : undefined)
        return { shown: page, summary: `Opened ${page === 'clip' ? 'Create' : page}` }
      }
    },
    {
      name: 'reveal_in_folder',
      title: 'Revealed files',
      description: 'Show a Library run folder (or one of its clips) in Finder / File Explorer.',
      inputSchema: object({ runId: runIdProperty, clipIndex: clipIndexProperty }, ['runId']),
      run: async (input) => {
        const { path, output } = await runOutput(input.runId)
        const clip = typeof input.clipIndex === 'number' ? output.clips.find((item) => item.clip_index === input.clipIndex) : null
        if (typeof input.clipIndex === 'number' && !clip) throw new AssistantToolError('No clip with that clipIndex in this run.')
        shell.showItemInFolder(clip ? clipFile(clip) : path)
        return { shown: true, summary: 'Shown in folder' }
      }
    },

    // ── Review & edit projects ────────────────────────────────────────────
    {
      name: 'get_review_project',
      title: 'Opened a review project',
      description: 'Candidates in a Review & edit run: id, title, status (refining, ready, baked = exported, discarded), score, why it was picked, length and caption settings. Also reports a running or finished export.',
      inputSchema: object({ runId: runIdProperty }, ['runId']),
      readOnly: true,
      run: async (input) => {
        const path = libraryPath(input.runId)
        const session = await openEditor(path)
        const project = session.project
        return {
          title: project.title,
          revision: project.revision,
          mediaFreed: Boolean(project.media_freed),
          operation: session.operation ? { action: session.operation, batch: session.batch ?? null } : null,
          lastExport: editorRuns.get(path) ?? null,
          candidates: project.candidates.map((candidate) => ({
            candidateId: candidate.id,
            title: candidate.title,
            status: candidate.status,
            score: candidate.score,
            reason: candidate.reason,
            lengthSeconds: seconds(candidate.ranges.reduce((sum, [a, b]) => sum + (b - a), 0)),
            sourceStartSeconds: seconds(candidate.ranges[0]?.[0]),
            captions: candidate.captions,
            captionStyle: candidate.custom_caption?.id ?? candidate.caption_preset,
            captionStyleName: candidate.custom_caption?.name ?? CAPTION_PRESETS.find((style) => style.id === candidate.caption_preset)?.name ?? candidate.caption_preset,
            speed: candidate.video_speed,
            exports: candidate.exports.length
          }))
        }
      }
    },
    {
      name: 'update_review_candidates',
      title: 'Updated review candidates',
      description: 'Rename candidates, mark them ready or discarded, or change their captions. Changing an exported (baked) candidate marks it ready to export again.',
      inputSchema: object({
        runId: runIdProperty,
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: 120,
          items: object({
            candidateId: { type: 'string', pattern: ID_PATTERN },
            title: { type: 'string', minLength: 1, maxLength: 200 },
            status: { type: 'string', enum: ['refining', 'ready', 'discarded'] },
            captions: { type: 'boolean' },
            captionStyle: captionStyleProperty
          }, ['candidateId'])
        }
      }, ['runId', 'changes']),
      run: async (input) => {
        const path = libraryPath(input.runId)
        const session = await openEditor(path)
        const changes = input.changes as { candidateId: string; title?: string; status?: CandidateEdit['status']; captions?: boolean; captionStyle?: string }[]
        for (const change of changes) {
          if (!session.project.candidates.some((candidate) => candidate.id === change.candidateId)) throw new AssistantToolError(`No candidate ${change.candidateId}. Call get_review_project.`)
        }
        const edits = session.project.candidates.map((candidate) => {
          const change = changes.find((item) => item.candidateId === candidate.id)
          if (!change) return candidate
          const next: CandidateEdit = { ...candidate }
          if (change.title !== undefined) next.title = change.title
          if (change.captions !== undefined) next.captions = change.captions
          if (change.captionStyle !== undefined) {
            const style = resolveCaptionStyle(change.captionStyle)
            next.caption_preset = style.captionPreset
            next.custom_caption = style.customCaption
          }
          if (change.status !== undefined) next.status = change.status
          else if (candidate.status === 'baked' && (change.title !== undefined || change.captions !== undefined || change.captionStyle !== undefined)) next.status = 'ready'
          return next
        })
        const saved = await saveEditor(path, session.project.revision, edits)
        host.dataChanged('library')
        return { revision: saved.project.revision, updated: changes.length, summary: `${changes.length} candidate(s) updated` }
      }
    },
    {
      name: 'export_review_clips',
      title: 'Exported review clips',
      description: 'Render clips from a Review & edit run: one candidate (must be ready) or every ready candidate. Runs in the background on this computer; check progress with get_review_project.',
      inputSchema: object({ runId: runIdProperty, candidateId: { type: 'string', pattern: ID_PATTERN, description: 'Omit to export every ready candidate.' } }, ['runId']),
      run: async (input) => {
        const path = libraryPath(input.runId)
        const session = await openEditor(path)
        const action = input.candidateId ? 'export' : 'export-all'
        const record = { action, startedAt: new Date().toISOString(), finishedAt: null as string | null, error: null as string | null }
        editorRuns.set(path, record)
        void runEditor(path, session.project.revision, input.candidateId ?? null, action).then(
          () => { record.finishedAt = new Date().toISOString(); host.dataChanged('library') },
          (error: unknown) => {
            record.finishedAt = new Date().toISOString()
            record.error = error instanceof Error ? error.message : 'Export failed'
            logger.warn('assistant.editorExport.failed')
          })
        // Surface immediate refusals (nothing ready, another operation running).
        await new Promise((resolve) => setTimeout(resolve, 300))
        if (record.error) throw new AssistantToolError(record.error)
        return { started: true, summary: 'Export started' }
      }
    },

    // ── Automations ───────────────────────────────────────────────────────
    {
      name: 'list_automations',
      title: 'Checked automations',
      description: 'Automations (scheduled posting queues): accounts, daily posting times, time zone, and the clips in each queue with their status.',
      inputSchema: object({ automationId: { type: 'string', pattern: ID_PATTERN, description: 'Only this automation.' } }),
      readOnly: true,
      run: async (input) => {
        const automations = listAutomations()
        if (input.automationId) return automationView(findAutomation(input.automationId))
        return { automations: automations.map((automation) => automationView(automation, automations.length <= 3)) }
      }
    },
    {
      name: 'create_automation',
      title: 'Created an automation',
      description: 'Create a new automation (off, with no accounts or times). Configure it with update_automation and fill it with add_clips_to_automation.',
      inputSchema: object({ name: { type: 'string', minLength: 1, maxLength: 80 } }, ['name']),
      run: async (input) => {
        const before = new Set(listAutomations().map((item) => item.id))
        const created = createAutomation(input.name).find((item) => !before.has(item.id))
        host.dataChanged('automations')
        return { ...(created ? automationView(created, false) : {}), summary: `Created “${String(input.name)}”` }
      }
    },
    {
      name: 'update_automation',
      title: 'Update an automation',
      description: 'Change an automation: name, on/off, the Zernio profile and accounts it posts to (all accounts must belong to that profile; get them from list_social_accounts), daily posting times (HH:mm, 24-hour) and time zone (IANA, e.g. America/New_York), AI or manual captions, and YouTube visibility. Omitted fields stay the same. Turning posting on, or changing where or when an enabled automation posts, needs the user\'s approval.',
      inputSchema: object({
        automationId: { type: 'string', pattern: ID_PATTERN },
        name: { type: 'string', minLength: 1, maxLength: 80 },
        enabled: { type: 'boolean' },
        profileId: { type: 'string', pattern: ID_PATTERN },
        accountIds: { type: 'array', items: { type: 'string', pattern: ID_PATTERN }, maxItems: 20 },
        times: { type: 'array', items: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }, maxItems: 24 },
        timezone: { type: 'string', maxLength: 64 },
        metadataMode: { type: 'string', enum: ['ai', 'manual'] },
        youtubeVisibility: { type: 'string', enum: ['public', 'unlisted', 'private'] },
        youtubeMadeForKids: { type: 'boolean' }
      }, ['automationId']),
      describe: (input) => input.enabled === true ? 'Turn on an automation' : 'Update an automation',
      confirm: async (input) => {
        const automation = findAutomation(input.automationId)
        const enabled = (input.enabled as boolean | undefined) ?? automation.enabled
        const where = input.accountIds !== undefined || input.profileId !== undefined
        const when = input.times !== undefined || input.timezone !== undefined
        if (!enabled || (!(input.enabled === true && !automation.enabled) && !where && !when)) return null
        const accounts = await socialAccounts().catch(() => [] as ZernioAccount[])
        const ids = (input.accountIds as string[] | undefined) ?? automation.accounts.map((account) => account.accountId)
        const labels = ids.map((id) => { const account = accounts.find((item) => item.id === id); return account ? accountLabel(account) : id })
        const times = (input.times as string[] | undefined) ?? automation.times
        return [
          `${automation.enabled ? 'Change scheduled posting for' : 'Turn on scheduled posting for'} “${automation.name}”.`,
          `Posts the next queued clip publicly to: ${labels.join(', ') || 'no accounts yet'}`,
          `Every day at ${times.join(', ') || 'no times yet'} (${(input.timezone as string | undefined) ?? automation.timezone})`
        ]
      },
      run: async (input) => {
        const automation = findAutomation(input.automationId)
        let accounts = automation.accounts
        if (input.accountIds !== undefined) {
          const known = await socialAccounts()
          accounts = (input.accountIds as string[]).map((id) => {
            const account = known.find((item) => item.id === id)
            if (!account) throw new AssistantToolError(`No connected account ${id}. Call list_social_accounts.`)
            if (!(AUTOMATION_PLATFORMS as readonly string[]).includes(account.platform)) throw new AssistantToolError(`${account.platform} can’t be used in automations.`)
            return { accountId: id, platform: account.platform as AutomationUpdate['accounts'][number]['platform'] }
          })
        }
        const update: AutomationUpdate = {
          name: (input.name as string | undefined) ?? automation.name,
          enabled: (input.enabled as boolean | undefined) ?? automation.enabled,
          profileId: (input.profileId as string | undefined) ?? automation.profileId,
          metadataMode: (input.metadataMode as 'ai' | 'manual' | undefined) ?? automation.metadataMode,
          accounts,
          times: (input.times as string[] | undefined) ?? automation.times,
          timezone: (input.timezone as string | undefined) ?? automation.timezone,
          youtubeVisibility: (input.youtubeVisibility as AutomationUpdate['youtubeVisibility'] | undefined) ?? automation.youtubeVisibility,
          youtubeMadeForKids: (input.youtubeMadeForKids as boolean | undefined) ?? automation.youtubeMadeForKids
        }
        const saved = (await updateAutomation(automation.id, update)).find((item) => item.id === automation.id)
        host.dataChanged('automations')
        return { ...(saved ? automationView(saved, false) : {}), summary: `Saved “${update.name}”` }
      }
    },
    {
      name: 'delete_automation',
      title: 'Delete an automation',
      description: 'Delete an automation and its queue of copied clips. Library clips and published posts are not affected.',
      inputSchema: object({ automationId: { type: 'string', pattern: ID_PATTERN } }, ['automationId']),
      destructive: true,
      confirm: (input) => {
        const automation = findAutomation(input.automationId)
        return [`Delete the automation “${automation.name}” and its ${automation.content.length} queued or posted clip copies.`, 'Library clips and published posts stay.']
      },
      run: async (input) => {
        deleteAutomation(input.automationId)
        host.dataChanged('automations')
        return { deleted: true, summary: 'Automation deleted' }
      }
    },
    {
      name: 'add_clips_to_automation',
      title: 'Added clips to an automation',
      description: 'Copy Library clips into an automation\'s posting queue (up to 30 at a time).',
      inputSchema: object({
        automationId: { type: 'string', pattern: ID_PATTERN },
        runId: runIdProperty,
        clipIndices: { type: 'array', items: clipIndexProperty, minItems: 1, maxItems: 30 }
      }, ['automationId', 'runId', 'clipIndices']),
      run: async (input) => {
        const automations = await addLibraryClipsToAutomation(input.automationId, libraryPath(input.runId), input.clipIndices)
        host.dataChanged('automations')
        const automation = automations.find((item) => item.id === input.automationId)
        return { queued: automation?.content.filter((item) => item.status === 'queued').length ?? null, summary: `${(input.clipIndices as number[]).length} clip(s) added` }
      }
    },
    {
      name: 'edit_automation_clip',
      title: 'Edited a queued clip',
      description: 'Change the title and caption of a clip in an automation queue.',
      inputSchema: object({
        automationId: { type: 'string', pattern: ID_PATTERN },
        contentId: { type: 'string', pattern: ID_PATTERN },
        title: { type: 'string', minLength: 1, maxLength: 500 },
        caption: { type: 'string', maxLength: 63206 }
      }, ['automationId', 'contentId']),
      run: async (input) => {
        const item = findAutomation(input.automationId).content.find((content) => content.id === input.contentId)
        if (!item) throw new AssistantToolError('No clip with that contentId in this automation.')
        updateAutomationContent(input.automationId, input.contentId, { title: (input.title as string | undefined) ?? item.title, caption: (input.caption as string | undefined) ?? item.caption })
        host.dataChanged('automations')
        return { saved: true, summary: 'Clip details saved' }
      }
    },
    {
      name: 'move_automation_clip',
      title: 'Reordered a queue',
      description: 'Move a queued clip before another queued clip, or to the end when beforeContentId is omitted.',
      inputSchema: object({
        automationId: { type: 'string', pattern: ID_PATTERN },
        contentId: { type: 'string', pattern: ID_PATTERN },
        beforeContentId: { type: 'string', pattern: ID_PATTERN }
      }, ['automationId', 'contentId']),
      run: async (input) => {
        reorderAutomationContent(input.automationId, input.contentId, input.beforeContentId ?? null)
        host.dataChanged('automations')
        return { moved: true, summary: 'Queue reordered' }
      }
    },
    {
      name: 'remove_automation_clip',
      title: 'Remove a clip from a queue',
      description: 'Remove a clip from an automation queue. The original Library clip stays.',
      inputSchema: object({ automationId: { type: 'string', pattern: ID_PATTERN }, contentId: { type: 'string', pattern: ID_PATTERN } }, ['automationId', 'contentId']),
      destructive: true,
      confirm: (input) => {
        const automation = findAutomation(input.automationId)
        const item = automation.content.find((content) => content.id === input.contentId)
        return [`Remove “${item?.title ?? 'this clip'}” from “${automation.name}”.`, 'The Library clip stays.']
      },
      run: async (input) => {
        removeAutomationContent(input.automationId, input.contentId)
        host.dataChanged('automations')
        return { removed: true, summary: 'Removed from queue' }
      }
    },
    {
      name: 'run_automation_now',
      title: 'Post the next clip now',
      description: 'Publish the next queued clip of an automation right now, instead of waiting for its next scheduled time.',
      inputSchema: object({ automationId: { type: 'string', pattern: ID_PATTERN } }, ['automationId']),
      confirm: async (input) => {
        const automation = findAutomation(input.automationId)
        const next = automation.content.find((item) => item.status === 'queued')
        const accounts = await socialAccounts().catch(() => [] as ZernioAccount[])
        const labels = automation.accounts.map((target) => { const account = accounts.find((item) => item.id === target.accountId); return account ? accountLabel(account) : target.platform })
        return [`Publish “${next?.title ?? 'the next queued clip'}” from “${automation.name}” now.`, `Public post to: ${labels.join(', ') || 'no accounts'}`]
      },
      run: async (input) => {
        const automations = await runAutomation(input.automationId)
        host.dataChanged('automations')
        host.dataChanged('posts')
        const automation = automations.find((item) => item.id === input.automationId)
        return { lastError: automation?.lastError ?? null, lastRunAt: automation?.lastRunAt ?? null, summary: automation?.lastError ? 'Posting failed' : 'Posted' }
      }
    },

    // ── Social accounts and posting ───────────────────────────────────────
    {
      name: 'list_social_accounts',
      title: 'Checked social accounts',
      description: 'Social accounts connected through Zernio, grouped by profile, and whether each can post. Connecting new accounts is done by the user in the Accounts page.',
      inputSchema: object({}),
      readOnly: true,
      run: async () => {
        if (!loadSettings().zernioApiKey) return { connected: false, note: 'No Zernio key is saved. The user adds it in Settings, then connects accounts in Accounts.' }
        const overview = await getZernioOverview().catch(() => readCachedOverview())
        if (!overview) throw new AssistantToolError('Could not reach Zernio. Try again shortly.')
        return {
          connected: true,
          profiles: overview.profiles.map((profile) => ({ profileId: profile.id, name: profile.name, isDefault: Boolean(profile.isDefault) })),
          accounts: overview.accounts.map((account) => ({
            accountId: account.id,
            platform: account.platform,
            handle: account.username,
            displayName: account.displayName,
            profileId: account.profileId,
            canPost: isPostableAccount(account),
            health: account.health,
            needsReconnect: account.needsReconnect
          }))
        }
      }
    },
    {
      name: 'post_clip',
      title: 'Post a clip',
      description: 'Publish (or schedule) a Library clip to one or more connected accounts. TikTok needs the user to review TikTok\'s settings and consent in the app, so TikTok accounts are refused here: tell the user to post TikTok from the Library\'s Post dialog. The caption defaults to the clip title plus hashtags from its tags.',
      inputSchema: object({
        runId: runIdProperty,
        clipIndex: clipIndexProperty,
        accountIds: { type: 'array', items: { type: 'string', pattern: ID_PATTERN }, minItems: 1, maxItems: 10 },
        caption: { type: 'string', maxLength: 63206 },
        youtubeTitle: { type: 'string', maxLength: 100 },
        youtubeVisibility: { type: 'string', enum: ['public', 'unlisted', 'private'] },
        youtubeMadeForKids: { type: 'boolean', description: 'Default false.' },
        instagramShareToFeed: { type: 'boolean', description: 'Default true.' },
        facebookFormat: { type: 'string', enum: ['feed', 'reel'] },
        threadsTopicTag: { type: 'string', maxLength: 50 },
        scheduleAt: { type: 'string', maxLength: 40, description: 'ISO 8601 date-time to schedule instead of posting now, e.g. 2026-10-02T09:00:00-04:00.' },
        timezone: { type: 'string', maxLength: 64, description: 'IANA time zone for a scheduled post. Default: this computer\'s.' }
      }, ['runId', 'clipIndex', 'accountIds']),
      describe: (input) => input.scheduleAt ? 'Schedule a post' : 'Post a clip',
      confirm: async (input) => {
        const { output } = await runOutput(input.runId)
        const clip = output.clips.find((item) => item.clip_index === input.clipIndex)
        const accounts = await socialAccounts()
        const labels = (input.accountIds as string[]).map((id) => { const account = accounts.find((item) => item.id === id); return account ? accountLabel(account) : id })
        const title = clip?.summary || `Clip ${(input.clipIndex as number) + 1}`
        const caption = (input.caption as string | undefined) ?? defaultCaption(title, clip?.tags ?? [])
        return [
          `${input.scheduleAt ? `Schedule for ${new Date(String(input.scheduleAt)).toLocaleString()}` : 'Publish now'}: “${title}”`,
          `To: ${labels.join(', ')}`,
          `Caption: ${caption.length > 280 ? `${caption.slice(0, 279)}…` : caption}`,
          ...((input.accountIds as string[]).some((id) => accounts.find((item) => item.id === id)?.platform === 'youtube')
            ? [`YouTube: “${(input.youtubeTitle as string | undefined) ?? youtubeTitleFor(title)}”, ${(input.youtubeVisibility as string | undefined) ?? 'public'}`]
            : [])
        ]
      },
      run: async (input) => {
        const { output } = await runOutput(input.runId)
        const clip = output.clips.find((item) => item.clip_index === input.clipIndex)
        if (!clip) throw new AssistantToolError('No clip with that clipIndex in this run.')
        const accounts = await socialAccounts()
        const targets = (input.accountIds as string[]).map((id) => {
          const account = accounts.find((item) => item.id === id)
          if (!account) throw new AssistantToolError(`No connected account ${id}. Call list_social_accounts.`)
          if (account.platform === 'tiktok') throw new AssistantToolError('TikTok posts need the user to confirm TikTok’s settings in the app. Ask them to use Post in the Library for TikTok.')
          if (!isPostableAccount(account)) throw new AssistantToolError(`${accountLabel(account)} can’t post right now (it may need reconnecting in Accounts).`)
          return { platform: account.platform as ZernioPlatform, accountId: id }
        })
        const title = clip.summary || `Clip ${clip.clip_index + 1}`
        const clipPath = clipFile(clip)
        const platforms = new Set(targets.map((target) => target.platform))
        let facebookFormat = input.facebookFormat as 'feed' | 'reel' | undefined
        if (platforms.has('facebook') && !facebookFormat) {
          facebookFormat = await probeClipForPosting(clipPath, clip.duration_ms).then(defaultFacebookFormat, () => 'feed' as const)
        }
        const request: PostClipRequest = {
          attemptId: randomUUID(),
          clipPath,
          clipTitle: title,
          durationMs: clip.duration_ms,
          caption: (input.caption as string | undefined) ?? defaultCaption(title, clip.tags),
          targets,
          timing: input.scheduleAt
            ? { mode: 'schedule', scheduledFor: String(input.scheduleAt), timezone: (input.timezone as string | undefined) ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') }
            : { mode: 'now' },
          options: {
            ...(platforms.has('youtube') ? { youtube: { title: (input.youtubeTitle as string | undefined) ?? (youtubeTitleFor(title) || 'Untitled clip'), visibility: (input.youtubeVisibility as 'public' | 'unlisted' | 'private' | undefined) ?? 'public', madeForKids: input.youtubeMadeForKids === true, ...(clip.tags.length ? { tags: clip.tags.slice(0, 15) } : {}) } } : {}),
            ...(platforms.has('instagram') ? { instagram: { shareToFeed: input.instagramShareToFeed !== false } } : {}),
            ...(platforms.has('facebook') ? { facebook: { format: facebookFormat ?? 'feed' } } : {}),
            ...(platforms.has('threads') ? { threads: typeof input.threadsTopicTag === 'string' && input.threadsTopicTag.trim() ? { topicTag: input.threadsTopicTag.trim() } : {} } : {})
          }
        }
        const result = await publishClip(request, () => {})
        host.dataChanged('posts')
        host.dataChanged('library')
        return { outcome: result.outcome, message: result.message, warnings: result.warnings, post: result.post ? postView(result.post) : null, summary: result.message }
      }
    },
    {
      name: 'list_posts',
      title: 'Checked posts',
      description: 'Recent posts made from BridgeClip with their status on each platform. Set refresh to fetch the latest status from Zernio first.',
      inputSchema: object({ refresh: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 25.' } }),
      readOnly: true,
      run: async (input) => {
        if (input.refresh) {
          await refreshPosts(true).catch(() => null)
          host.dataChanged('posts')
        }
        return { posts: listPosts().slice(0, (input.limit as number | undefined) ?? 25).map(postView) }
      }
    },
    {
      name: 'cancel_scheduled_post',
      title: 'Cancel a scheduled post',
      description: 'Cancel a scheduled post before it publishes.',
      inputSchema: object({ postId: { type: 'string', pattern: ID_PATTERN } }, ['postId']),
      destructive: true,
      confirm: (input) => {
        const post = listPosts().find((item) => item.id === input.postId)
        return [`Cancel the scheduled post “${post?.clipTitle ?? input.postId}”${post?.scheduledFor ? ` (${new Date(post.scheduledFor).toLocaleString()})` : ''}.`]
      },
      run: async (input) => {
        await cancelPost(input.postId)
        host.dataChanged('posts')
        return { cancelled: true, summary: 'Post cancelled' }
      }
    },
    {
      name: 'reschedule_post',
      title: 'Reschedule a post',
      description: 'Move a scheduled post to a new time.',
      inputSchema: object({ postId: { type: 'string', pattern: ID_PATTERN }, scheduleAt: { type: 'string', maxLength: 40 }, timezone: { type: 'string', maxLength: 64 } }, ['postId', 'scheduleAt']),
      confirm: (input) => {
        const post = listPosts().find((item) => item.id === input.postId)
        return [`Reschedule “${post?.clipTitle ?? input.postId}” to ${new Date(String(input.scheduleAt)).toLocaleString()}.`]
      },
      run: async (input) => {
        await reschedulePost(input.postId, input.scheduleAt, (input.timezone as string | undefined) ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'))
        host.dataChanged('posts')
        return { rescheduled: true, summary: 'Post rescheduled' }
      }
    },
    {
      name: 'retry_post',
      title: 'Retry a failed post',
      description: 'Retry a post that failed on one or more platforms.',
      inputSchema: object({ postId: { type: 'string', pattern: ID_PATTERN } }, ['postId']),
      confirm: (input) => {
        const post = listPosts().find((item) => item.id === input.postId)
        return [`Retry publishing “${post?.clipTitle ?? input.postId}” to the platforms where it failed.`]
      },
      run: async (input) => {
        const posts = await retryPost(input.postId)
        host.dataChanged('posts')
        const post = posts.find((item) => item.id === input.postId)
        return { post: post ? postView(post) : null, summary: post ? `Post ${post.status}` : 'Retried' }
      }
    },

    // ── Settings ──────────────────────────────────────────────────────────
    {
      name: 'get_settings',
      title: 'Read settings',
      description: 'BridgeClip settings: whether API keys are saved (never the keys), the Library folder, custom vocabulary for transcription, Jev editorial review and web research switches.',
      inputSchema: object({}),
      readOnly: true,
      run: async () => {
        const settings = publicSettings(loadSettings())
        return {
          openrouterKeySaved: settings.openrouterConfigured,
          zernioKeySaved: settings.zernioConfigured,
          libraryFolder: settings.outputDirectory,
          customVocabulary: settings.customVocabulary,
          jevEditorialReview: settings.jevEnabled === 'on',
          jevVisualContext: settings.jevVisualContext === 'on',
          sourceWebResearch: settings.sourceContextWebResearch === 'on'
        }
      }
    },
    {
      name: 'update_settings',
      title: 'Update settings',
      description: 'Change custom vocabulary (names and terms to help transcription; one per line), Jev editorial review, Jev visual context, or web research for source context. API keys and the Library folder can only be changed by the user in Settings.',
      inputSchema: object({
        customVocabulary: { type: 'string', maxLength: 8000 },
        jevEditorialReview: { type: 'boolean' },
        jevVisualContext: { type: 'boolean' },
        sourceWebResearch: { type: 'boolean' }
      }),
      confirm: (input) => {
        const current = loadSettings()
        const enabling = [
          input.jevEditorialReview === true && current.jevEnabled !== 'on' ? 'Jev editorial review' : null,
          input.jevVisualContext === true && current.jevVisualContext !== 'on' ? 'Jev visual context' : null,
          input.sourceWebResearch === true && current.sourceContextWebResearch !== 'on' ? 'web research for source context' : null
        ].filter(Boolean)
        return enabling.length ? [`Turn on ${enabling.join(', ')}.`, 'These make extra OpenRouter requests on every job, which costs more credit.'] : null
      },
      run: async (input) => {
        const current = loadSettings()
        const flag = (value: unknown, fallback: string): string => typeof value === 'boolean' ? (value ? 'on' : 'off') : fallback
        savePublicSettings({
          ...publicSettings(current),
          outputDirectory: current.outputDirectory,
          pythonPath: current.pythonPath,
          customVocabulary: (input.customVocabulary as string | undefined) ?? current.customVocabulary,
          jevEnabled: flag(input.jevEditorialReview, current.jevEnabled),
          jevVisualContext: flag(input.jevVisualContext, current.jevVisualContext),
          sourceContextWebResearch: flag(input.sourceWebResearch, current.sourceContextWebResearch)
        })
        host.dataChanged('settings')
        return { saved: true, summary: 'Settings saved' }
      }
    }
  ]
  return tools
}
