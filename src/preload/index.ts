import type { JevThresholdSettings } from '../shared/jev-settings'
import type { LibraryClipTarget } from '../shared/library-posting'
import type { AutomationReviewResult } from '../shared/automations'
import type { CandidateEdit, EditorProgressSummary, EditorSession } from '../shared/clip-editor'
import type { JobOutput } from '../shared/job-output'
import type { EditAudit } from '../shared/editorial'
import { contextBridge, ipcRenderer } from 'electron'
import type {
  ZernioConnectOptions,
  ZernioConnectResult,
  ZernioConnectStart,
  ZernioOverview,
  ZernioPendingConnect,
  ZernioPlatform,
  ZernioProfile,
  ZernioSyncResult,
  ZernioStatusCheck
} from '../shared/zernio'
import type { ClipMediaInfo, PostClipRequest, PostClipResult, PostProgress, PostRecord, PostsRefreshResult, TikTokCreatorInfo, TikTokLegalLink } from '../shared/zernio-posts'
import type { ClipJobRequest, JobSnapshot } from '../shared/jobs'
import type { MetadataEnhancement, AutomationSourceGroup, AutomationBatchResult, AutomationSourceContext, Automation, AutomationUpdate, AutomationTikTokReview, AutomationTikTokReviewUpdate } from '../shared/automations'
import type { LibraryClipPostingStatus, LibraryEnhancementOptions, LibraryRunPostingCounts } from '../shared/library-posting'
import type { OpenRouterCatalog } from '../shared/openrouter-models'
import type { UpdateState } from '../shared/updates'
import type { OutputStorageUsage } from '../shared/output-storage'
import type { YouTubePreview } from '../shared/youtube-preview'

export interface ClipSettings extends JevThresholdSettings {
  openrouterConfigured: boolean
  zernioConfigured: boolean
  jevEnabled: string
  jevVisualContext: string
  sourceContextWebResearch: string
  outputDirectory: string
  pythonPath: string
  customVocabulary: string
}

export type { ClipJobRequest, JobSnapshot } from '../shared/jobs'

export interface HistoryEntry {
  editorProject?: boolean
  candidateCount?: number
  favorite?: boolean
  jobId: string
  date: string
  videoTitle: string
  clipCount: number
  status: 'completed' | 'failed' | 'cancelled' | 'running' | 'interrupted' | 'incomplete'
  outputDir: string
  totalCostUsd: number | null
  finishedAt: string | null
  durationMs: number | null
  errorMessage: string | null
}

export interface ToolStatus {
  python: boolean
  pythonDeps: boolean
  pythonPath: string
  pythonError: string | null
  pythonHint?: string | null
  pythonRepairCommand?: string | null
  ffmpeg: boolean
  ffmpegCaptions: boolean
  ffprobe: boolean
  ytdlp: boolean
  engine: boolean
  enginePath: string
  bridgeRunner: boolean
  bridgePath: string
}

export interface BridgeClipAPI {
  source: { youtubePreview: (url: string, details?: boolean) => Promise<YouTubePreview> }
  editor: {
    open: (path: string) => Promise<EditorSession>
    save: (path: string, revision: number, edits: CandidateEdit[]) => Promise<EditorSession>
    run: (path: string, revision: number, id: string, action: 'review' | 'export' | 'export-all' | 'scan-cameras') => Promise<EditorSession>
    cancel: (path: string) => Promise<void>
    replaceSource: (path: string, revision: number, replacement: string) => Promise<EditorSession>
    /** Status counts only; cheap enough for list rows and polling. */
    progress: (path: string) => Promise<EditorProgressSummary>
    freeMedia: (path: string, revision: number) => Promise<EditorSession>
    /** Main asks the open editor to save before a close or quit continues. */
    onSaveBeforeClose: (callback: () => void) => () => void
    closeReady: (saved: boolean) => Promise<void>
  }
  edits: { inspect: (outputDir: string) => Promise<EditAudit> }
  models: { list: (refresh?: boolean) => Promise<OpenRouterCatalog> }
  automations: {
    reviewContent: (id: string, contentId: string, returnToQueue: boolean) => Promise<AutomationReviewResult>
    acknowledgeWarnings: (id: string | null, contentId?: string) => Promise<Automation[]>
    dismissMetadataError: (id: string, contentId: string) => Promise<Automation[]>
    libraryClip: (id: string, contentId: string) => Promise<LibraryClipTarget | null>
    showInFolder: (id: string, contentId: string) => Promise<boolean>
    reorder: (id: string, contentId: string, beforeId: string | null) => Promise<Automation[]>
    enhancementGroups: (id: string) => Promise<AutomationSourceGroup[]>
    enhanceBatch: (id: string, contentIds: string[], key: string, guidance?: string) => Promise<AutomationBatchResult>
    source: (id: string, contentId: string) => Promise<AutomationSourceContext | null>
    enhance: (id: string, contentId: string, options: { source?: AutomationSourceContext | null; research: boolean }) => Promise<Automation[]>
    resolveDraft: (id: string, contentId: string, draftId: string, apply: boolean) => Promise<Automation[]>
    list: () => Promise<Automation[]>
    create: (name: string) => Promise<Automation[]>
    update: (id: string, update: AutomationUpdate) => Promise<Automation[]>
    delete: (id: string) => Promise<Automation[]>
    retryContent: (id: string, contentId: string) => Promise<Automation[]>
    run: (id: string) => Promise<Automation[]>
    addContent: (id: string) => Promise<Automation[]>
    addLibraryClips: (id: string, outputDir: string, clipIndices: number[]) => Promise<Automation[]>
    updateContent: (id: string, contentId: string, update: { title: string; caption: string; returnToQueue?: boolean }) => Promise<Automation[]>
    prepareTikTokReview: (id: string, contentId: string) => Promise<AutomationTikTokReview>
    approveTikTokReview: (id: string, contentId: string, update: AutomationTikTokReviewUpdate) => Promise<Automation[]>
    removeContent: (id: string, contentId: string) => Promise<Automation[]>
  }
  settings: {
    load: () => Promise<ClipSettings>
    /** Pass true to count again instead of reusing a result from the last few seconds. */
    storageUsage: (fresh?: boolean) => Promise<OutputStorageUsage>
    save: (settings: ClipSettings) => Promise<ClipSettings>
    replaceApiKey: (key: 'openrouterApiKey' | 'zernioApiKey', value: string) => Promise<ClipSettings>
    selectOutputDir: () => Promise<string | null>
  }
  zernio: {
    checkStatus: () => Promise<ZernioStatusCheck>
    overview: () => Promise<ZernioOverview>
    createProfile: (name: string) => Promise<ZernioProfile>
    /** Live accounts from Zernio, or the cached copy with the reason Zernio couldn't be read. Never rejects for Zernio failures. */
    sync: () => Promise<ZernioSyncResult>
    /** The last synced accounts, from disk (no network). */
    cachedOverview: () => Promise<ZernioOverview | null>
    /** A sign-in still waiting for the browser, e.g. after the window reloaded. */
    pendingConnect: () => Promise<ZernioPendingConnect | null>
    /**
     * Opens the platform's sign-in in the browser; the outcome arrives via onConnectResult when the
     * result is `pending`. `profileId` null uses the default profile (creating one if needed).
     */
    connect: (platform: ZernioPlatform, profileId: string | null, options?: ZernioConnectOptions) => Promise<ZernioConnectStart>
    cancelConnect: () => Promise<void>
    disconnect: (accountId: string) => Promise<void>
    onConnectResult: (callback: (result: ZernioConnectResult) => void) => () => void
    /** The Zernio key was added, replaced or removed; drop anything from the previous workspace. */
    onReset: (callback: (state: { configured: boolean }) => void) => () => void
    /** Posting clips. Uploads, post creation and links run in the main process. */
    posts: {
      probe: (clipPath: string, durationMs: number | null) => Promise<ClipMediaInfo>
      tiktokCreatorInfo: (accountId: string) => Promise<TikTokCreatorInfo>
      /** Uploads the clip and creates the post; progress arrives via onProgress. */
      publish: (request: PostClipRequest) => Promise<PostClipResult>
      cancelUpload: (attemptId: string) => Promise<void>
      onProgress: (callback: (progress: PostProgress) => void) => () => void
      list: () => Promise<PostRecord[]>
      /** Re-reads posts whose status can still change, a few per call. `force` includes ones refreshed recently. */
      refresh: (force: boolean) => Promise<PostsRefreshResult>
      cancel: (postId: string) => Promise<PostRecord[]>
      reschedule: (postId: string, scheduledFor: string, timezone: string) => Promise<PostRecord[]>
      retry: (postId: string) => Promise<PostRecord[]>
      dismiss: (postId: string) => Promise<PostRecord[]>
      open: (postId: string, targetIndex: number) => Promise<void>
      openTikTokLegal: (key: TikTokLegalLink) => Promise<void>
    }
  }
  job: {
    /** Queues a clipping run; it starts right away when a slot is free (`queued: false`). */
    start: (config: ClipJobRequest) => Promise<{ jobId?: string; queued?: boolean; job?: JobSnapshot; error?: string }>
    cancel: (jobId: string) => Promise<boolean>
    /** Every job the main process knows about this session, newest first. */
    list: () => Promise<JobSnapshot[]>
    /** Forget a finished job for this session; its run folder stays in the library. */
    dismiss: (jobId: string) => Promise<boolean>
    /** A fresh snapshot each time any job changes. */
    onUpdate: (callback: (job: JobSnapshot) => void) => () => void
  }
  history: {
    setFavorite: (outputDir: string, favorite: boolean) => Promise<boolean>
    delete: (outputDir: string) => Promise<void>
    deleteClips: (outputDir: string, indices: number[]) => Promise<JobOutput>
    postingStatus: (outputDir: string) => Promise<LibraryClipPostingStatus[]>
    /** Posted counts for many runs at once, for the Library list. */
    postingSummary: (outputDirs: string[]) => Promise<LibraryRunPostingCounts[]>
    setPosted: (outputDir: string, clipIndex: number, posted: boolean) => Promise<boolean>
    metadataSource: (outputDir: string, clipIndex: number) => Promise<AutomationSourceContext | null>
    enhanceMetadata: (outputDir: string, clipIndex: number, options: LibraryEnhancementOptions) => Promise<MetadataEnhancement>
    list: () => Promise<HistoryEntry[]>
    getJob: (outputDir: string) => Promise<Record<string, unknown> | null>
  }
  thumbnails: {
    generate: (videoPath: string, seekSeconds?: number) => Promise<string | null>
  }
  shell: {
    /** Opens a local path with its default app, or an http(s) URL in the browser. */
    openPath: (path: string) => Promise<boolean>
    showItemInFolder: (path: string) => Promise<boolean>
  }
  dialog: {
    selectVideo: () => Promise<string | null>
  }
  clips: {
    bulkExport: (clips: { path: string; name: string }[]) => Promise<{ success: boolean; count: number; failedCount: number; destDir?: string }>
  }
  system: {
    isPackaged: () => Promise<boolean>
    checkTools: () => Promise<ToolStatus>
  }
  diagnostics: {
    getLogPath: () => Promise<string>
    openLogFolder: () => Promise<boolean>
  }
  update: {
    getState: () => Promise<UpdateState>
    /** Every change to the update state, from background checks too. */
    onState: (cb: (state: UpdateState) => void) => () => void
    /** Help → Check for Updates… asks the window to show the Updates row. */
    onShow: (cb: () => void) => () => void
    /** Check now; resolves with the state once the check finishes. */
    check: () => Promise<UpdateState>
    /** Quit and install the downloaded update, then reopen BridgeClip. */
    install: () => Promise<boolean>
    /** macOS: move the app out of the disk image or Downloads so it can update. */
    moveToApplications: () => Promise<boolean>
    /** The GitHub release page for the new version (or this one). */
    openReleaseNotes: () => Promise<boolean>
  }
  changelog: {
    /** Help → Changelog asks the window to show the changelog. */
    onShow: (cb: () => void) => () => void
  }
}

function subscribe<T>(channel: string, callback: (data: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, data: T): void => callback(data)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: BridgeClipAPI = {
  source: { youtubePreview: (url, details = false) => ipcRenderer.invoke('source:youtubePreview', url, details) },
  editor: {
    open: (path) => ipcRenderer.invoke('editor:open', path),
    save: (path, revision, edits) => ipcRenderer.invoke('editor:save', path, revision, edits),
    run: (path, revision, id, action) => ipcRenderer.invoke('editor:run', path, revision, id, action),
    cancel: (path) => ipcRenderer.invoke('editor:cancel', path),
    replaceSource: (path, revision, replacement) => ipcRenderer.invoke('editor:replaceSource', path, revision, replacement),
    progress: (path) => ipcRenderer.invoke('editor:progress', path),
    freeMedia: (path, revision) => ipcRenderer.invoke('editor:freeMedia', path, revision),
    onSaveBeforeClose: (callback) => subscribe<void>('editor:saveBeforeClose', () => callback()),
    closeReady: (saved) => ipcRenderer.invoke('editor:closeReady', saved)
  },
  edits: { inspect: (outputDir) => ipcRenderer.invoke('edits:inspect', outputDir) },
  models: { list: (refresh = false) => ipcRenderer.invoke('models:list', refresh) },
  automations: {
    reviewContent: (id, contentId, returnToQueue) => ipcRenderer.invoke('automations:reviewContent', id, contentId, returnToQueue),
    acknowledgeWarnings: (id, contentId) => ipcRenderer.invoke('automations:acknowledgeWarnings', id, contentId),
    dismissMetadataError: (id, contentId) => ipcRenderer.invoke('automations:dismissMetadataError', id, contentId),
    libraryClip: (id, contentId) => ipcRenderer.invoke('automations:libraryClip', id, contentId),
    showInFolder: (id, contentId) => ipcRenderer.invoke('automations:showInFolder', id, contentId),
    reorder: (id, contentId, beforeId) => ipcRenderer.invoke('automations:reorder', id, contentId, beforeId),
    enhancementGroups: (id) => ipcRenderer.invoke('automations:enhancementGroups', id),
    enhanceBatch: (id, contentIds, key, guidance) => ipcRenderer.invoke('automations:enhanceBatch', id, contentIds, key, guidance),
    source: (id, contentId) => ipcRenderer.invoke('automations:source', id, contentId),
    enhance: (id, contentId, options) => ipcRenderer.invoke('automations:enhance', id, contentId, options),
    resolveDraft: (id, contentId, draftId, apply) => ipcRenderer.invoke('automations:resolveDraft', id, contentId, draftId, apply),
    list: () => ipcRenderer.invoke('automations:list'),
    create: (name) => ipcRenderer.invoke('automations:create', name),
    update: (id, update) => ipcRenderer.invoke('automations:update', id, update),
    delete: (id) => ipcRenderer.invoke('automations:delete', id),
    retryContent: (id, contentId) => ipcRenderer.invoke('automations:retryContent', id, contentId),
    run: (id) => ipcRenderer.invoke('automations:run', id),
    addContent: (id) => ipcRenderer.invoke('automations:addContent', id),
    addLibraryClips: (id, outputDir, clipIndices) => ipcRenderer.invoke('automations:addLibraryClips', id, outputDir, clipIndices),
    updateContent: (id, contentId, update) => ipcRenderer.invoke('automations:updateContent', id, contentId, update),
    prepareTikTokReview: (id, contentId) => ipcRenderer.invoke('automations:prepareTikTokReview', id, contentId),
    approveTikTokReview: (id, contentId, update) => ipcRenderer.invoke('automations:approveTikTokReview', id, contentId, update),
    removeContent: (id, contentId) => ipcRenderer.invoke('automations:removeContent', id, contentId)
  },
  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    storageUsage: (fresh) => ipcRenderer.invoke('settings:storageUsage', fresh === true),
    save: (settings) => ipcRenderer.invoke('settings:save', settings),
    replaceApiKey: (key, value) => ipcRenderer.invoke('settings:replaceApiKey', key, value),
    selectOutputDir: () => ipcRenderer.invoke('settings:selectOutputDir')
  },
  zernio: {
    checkStatus: () => ipcRenderer.invoke('zernio:checkStatus'),
    overview: () => ipcRenderer.invoke('zernio:overview'),
    createProfile: (name) => ipcRenderer.invoke('zernio:profiles:create', name),
    sync: () => ipcRenderer.invoke('zernio:sync'),
    cachedOverview: () => ipcRenderer.invoke('zernio:cachedOverview'),
    pendingConnect: () => ipcRenderer.invoke('zernio:pendingConnect'),
    connect: (platform, profileId, options) => ipcRenderer.invoke('zernio:connect', platform, profileId, options),
    cancelConnect: () => ipcRenderer.invoke('zernio:cancelConnect'),
    disconnect: (accountId) => ipcRenderer.invoke('zernio:disconnect', accountId),
    onConnectResult: (callback) => subscribe('zernio:connectResult', callback),
    onReset: (callback) => subscribe('zernio:reset', callback),
    posts: {
      probe: (clipPath, durationMs) => ipcRenderer.invoke('zernio:posts:probe', clipPath, durationMs),
      tiktokCreatorInfo: (accountId) => ipcRenderer.invoke('zernio:posts:tiktokCreatorInfo', accountId),
      publish: (request) => ipcRenderer.invoke('zernio:posts:publish', request),
      cancelUpload: (attemptId) => ipcRenderer.invoke('zernio:posts:cancelUpload', attemptId),
      onProgress: (callback) => subscribe('zernio:postProgress', callback),
      list: () => ipcRenderer.invoke('zernio:posts:list'),
      refresh: (force) => ipcRenderer.invoke('zernio:posts:refresh', force),
      cancel: (postId) => ipcRenderer.invoke('zernio:posts:cancel', postId),
      reschedule: (postId, scheduledFor, timezone) => ipcRenderer.invoke('zernio:posts:reschedule', postId, scheduledFor, timezone),
      retry: (postId) => ipcRenderer.invoke('zernio:posts:retry', postId),
      dismiss: (postId) => ipcRenderer.invoke('zernio:posts:dismiss', postId),
      open: (postId, targetIndex) => ipcRenderer.invoke('zernio:posts:open', postId, targetIndex),
      openTikTokLegal: (key) => ipcRenderer.invoke('zernio:posts:openTikTokLegal', key)
    }
  },
  job: {
    start: (config) => ipcRenderer.invoke('job:start', config),
    cancel: (jobId) => ipcRenderer.invoke('job:cancel', jobId),
    list: () => ipcRenderer.invoke('jobs:list'),
    dismiss: (jobId) => ipcRenderer.invoke('jobs:dismiss', jobId),
    onUpdate: (callback) => subscribe('jobs:update', callback)
  },
  history: {
    setFavorite: (outputDir, favorite) => ipcRenderer.invoke('history:setFavorite', outputDir, favorite),
    delete: (outputDir) => ipcRenderer.invoke('history:delete', outputDir),
    deleteClips: (outputDir, indices) => ipcRenderer.invoke('history:deleteClips', outputDir, indices),
    postingStatus: (outputDir) => ipcRenderer.invoke('history:postingStatus', outputDir),
    postingSummary: (outputDirs) => ipcRenderer.invoke('history:postingSummary', outputDirs),
    setPosted: (outputDir, clipIndex, posted) => ipcRenderer.invoke('history:setPosted', outputDir, clipIndex, posted),
    metadataSource: (outputDir, clipIndex) => ipcRenderer.invoke('history:metadataSource', outputDir, clipIndex),
    enhanceMetadata: (outputDir, clipIndex, options) => ipcRenderer.invoke('history:enhanceMetadata', outputDir, clipIndex, options),
    list: () => ipcRenderer.invoke('history:list'),
    getJob: (outputDir) => ipcRenderer.invoke('history:getJob', outputDir)
  },
  thumbnails: {
    generate: (videoPath, seekSeconds) => ipcRenderer.invoke('thumbnails:generate', videoPath, seekSeconds)
  },
  shell: {
    openPath: (path) => ipcRenderer.invoke('shell:openPath', path),
    showItemInFolder: (path) => ipcRenderer.invoke('shell:showItemInFolder', path)
  },
  dialog: {
    selectVideo: () => ipcRenderer.invoke('dialog:selectVideo')
  },
  clips: {
    bulkExport: (clips) => ipcRenderer.invoke('clips:bulkExport', clips)
  },
  system: {
    isPackaged: () => ipcRenderer.invoke('system:isPackaged'),
    checkTools: () => ipcRenderer.invoke('system:checkTools')
  },
  diagnostics: {
    getLogPath: () => ipcRenderer.invoke('diagnostics:getLogPath'),
    openLogFolder: () => ipcRenderer.invoke('diagnostics:openLogFolder')
  },
  update: {
    getState: () => ipcRenderer.invoke('update:getState'),
    onState: (callback) => subscribe('update:state', callback),
    onShow: (callback) => subscribe('update:show', () => callback()),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    moveToApplications: () => ipcRenderer.invoke('update:moveToApplications'),
    openReleaseNotes: () => ipcRenderer.invoke('update:openReleaseNotes')
  },
  changelog: {
    onShow: (callback) => subscribe('changelog:show', () => callback())
  }
}

contextBridge.exposeInMainWorld('bridgeclip', api)
