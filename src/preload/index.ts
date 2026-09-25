import { contextBridge, ipcRenderer } from 'electron'
import type {
  ZernioConnectOptions,
  ZernioConnectResult,
  ZernioConnectStart,
  ZernioOverview,
  ZernioPendingConnect,
  ZernioPlatform,
  ZernioProfile,
  ZernioSyncResult
} from '../shared/zernio'
import type { ClipMediaInfo, PostClipRequest, PostClipResult, PostProgress, PostRecord, PostsRefreshResult, TikTokCreatorInfo, TikTokLegalLink } from '../shared/zernio-posts'
import type { ClipJobRequest, JobSnapshot } from '../shared/jobs'
import type { Automation, AutomationUpdate, AutomationTikTokReview, AutomationTikTokReviewUpdate } from '../shared/automations'
import type { OpenRouterCatalog } from '../shared/openrouter-models'

export interface ClipSettings {
  openrouterConfigured: boolean
  zernioConfigured: boolean
  outputDirectory: string
  pythonPath: string
  customVocabulary: string
}

export type { ClipJobRequest, JobSnapshot } from '../shared/jobs'

export interface HistoryEntry {
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
  models: { list: (refresh?: boolean) => Promise<OpenRouterCatalog> }
  automations: {
    list: () => Promise<Automation[]>
    create: (name: string) => Promise<Automation[]>
    update: (id: string, update: AutomationUpdate) => Promise<Automation[]>
    delete: (id: string) => Promise<Automation[]>
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
    save: (settings: ClipSettings) => Promise<ClipSettings>
    replaceApiKey: (key: 'openrouterApiKey' | 'zernioApiKey', value: string) => Promise<ClipSettings>
    selectOutputDir: () => Promise<string | null>
  }
  zernio: {
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
    start: (config: ClipJobRequest) => Promise<{ jobId?: string; queued?: boolean; error?: string }>
    cancel: (jobId: string) => Promise<boolean>
    /** Every job the main process knows about this session, newest first. */
    list: () => Promise<JobSnapshot[]>
    /** Forget a finished job for this session; its run folder stays in the library. */
    dismiss: (jobId: string) => Promise<boolean>
    /** A fresh snapshot each time any job changes. */
    onUpdate: (callback: (job: JobSnapshot) => void) => () => void
  }
  history: {
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
    onAvailable: (cb: (info: { version: string; releaseNotes?: string; releaseDate?: string }) => void) => () => void
    onProgress: (cb: (info: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void) => () => void
    onDownloaded: (cb: () => void) => () => void
    onError: (cb: (info: { message: string }) => void) => () => void
    download: () => Promise<void>
    install: () => Promise<void>
    check: () => Promise<void>
  }
}

function subscribe<T>(channel: string, callback: (data: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, data: T): void => callback(data)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: BridgeClipAPI = {
  models: { list: (refresh = false) => ipcRenderer.invoke('models:list', refresh) },
  automations: {
    list: () => ipcRenderer.invoke('automations:list'),
    create: (name) => ipcRenderer.invoke('automations:create', name),
    update: (id, update) => ipcRenderer.invoke('automations:update', id, update),
    delete: (id) => ipcRenderer.invoke('automations:delete', id),
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
    save: (settings) => ipcRenderer.invoke('settings:save', settings),
    replaceApiKey: (key, value) => ipcRenderer.invoke('settings:replaceApiKey', key, value),
    selectOutputDir: () => ipcRenderer.invoke('settings:selectOutputDir')
  },
  zernio: {
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
    onAvailable: (callback) => subscribe('update:available', callback),
    onProgress: (callback) => subscribe('update:progress', callback),
    onDownloaded: (callback) => subscribe('update:downloaded', () => callback()),
    onError: (callback) => subscribe('update:error', callback),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    check: () => ipcRenderer.invoke('update:check')
  }
}

contextBridge.exposeInMainWorld('bridgeclip', api)
