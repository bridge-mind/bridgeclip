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
