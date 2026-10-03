export interface OutputStorageUsage {
  outputDirectory: string
  bytes: number
  fileCount: number
  exists: boolean
  unreadableCount: number
  /** Counting stopped at the scan limits; the total is a lower bound. */
  truncated?: boolean
}

export interface LibraryDeletionPreview {
  outputDirectory: string
  bytes: number
  fileCount: number
  clipCount: number
  /** Unreadable files or scan limits make the estimate incomplete. */
  partial: boolean
}

export type StorageCleanupKind = 'published' | 'sources'
export interface SourceStorageSummary {
  outputDirectory: string
  sourceBytes: number
  previewBytes: number
  projects: number
  readyProjects: number
  readyBytes: number
  unfinishedProjects: number
  unavailableProjects: number
}
export interface StorageCleanupItem {
  id: string
  title: string
  kind: 'run' | 'clips' | 'source'
  bytes: number
  clipCount: number
  partial: boolean
  /** Nonempty when this project must be kept. */
  keepReason?: string
}
export interface StorageCleanupPreview {
  token: string
  outputDirectory: string
  kind: StorageCleanupKind
  items: StorageCleanupItem[]
  unavailableProjects: number
}
export interface StorageCleanupResult {
  cleaned: number
  skipped: number
  failed: number
}
