import { lstat, readdir, stat } from 'fs/promises'
import { join } from 'path'
import type { OutputStorageUsage } from '../shared/output-storage'

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** A huge or deeply nested folder stops counting here instead of scanning forever. */
export const STORAGE_SCAN_LIMITS = { maxEntries: 250_000, maxDepth: 32 }
/** A finished scan is reused briefly, so reopening Settings does not walk the folder again. */
const REUSE_MS = 10_000
/** lstat calls in flight per directory. */
const PARALLEL = 32

/** Sum file sizes asynchronously, without following links inside the output folder. */
export async function scanOutputStorage(outputDirectory: string, limits = STORAGE_SCAN_LIMITS, { reclaimable = false }: { reclaimable?: boolean } = {}): Promise<OutputStorageUsage> {
  const usage: OutputStorageUsage = { outputDirectory, bytes: 0, fileCount: 0, exists: true, unreadableCount: 0 }
  const linkedFiles = new Map<string, { bytes: number; links: number; seen: number }>()
  try {
    if (!(await stat(outputDirectory)).isDirectory()) throw new Error('The output folder is not a directory.')
  } catch (error) {
    if (!missing(error)) throw error
    return { ...usage, exists: false }
  }

  const directories: [string, number][] = [[outputDirectory, 0]]
  let entries = 0
  while (directories.length) {
    const [directory, depth] = directories.pop()!
    let names: string[]
    try {
      names = await readdir(directory)
    } catch (error) {
      if (!missing(error)) usage.unreadableCount++
      continue
    }
    if (entries + names.length > limits.maxEntries) {
      names = names.slice(0, Math.max(0, limits.maxEntries - entries))
      usage.truncated = true
    }
    entries += names.length
    for (let offset = 0; offset < names.length; offset += PARALLEL) {
      await Promise.all(names.slice(offset, offset + PARALLEL).map(async (name) => {
        const path = join(directory, name)
        try {
          const info = await lstat(path)
          if (info.isDirectory()) {
            if (depth < limits.maxDepth) directories.push([path, depth + 1])
            else usage.truncated = true
          } else if (info.isFile()) {
            if (reclaimable && info.nlink > 1) {
              const key = `${info.dev}:${info.ino}`
              const linked = linkedFiles.get(key)
              if (linked) linked.seen++
              else linkedFiles.set(key, { bytes: info.size, links: info.nlink, seen: 1 })
            } else usage.bytes += info.size
            usage.fileCount++
          }
        } catch (error) {
          // Files may disappear while a run is being cleaned up.
          if (!missing(error)) usage.unreadableCount++
        }
      }))
    }
    if (usage.truncated && entries >= limits.maxEntries) break
  }
  // A hard-linked file frees space only when all its links are removed.
  // Count it once, and exclude files with links outside this run folder.
  for (const file of linkedFiles.values()) if (file.seen >= file.links) usage.bytes += file.bytes
  return usage
}

const running = new Map<string, Promise<OutputStorageUsage>>()
let recent: { outputDirectory: string; at: number; usage: OutputStorageUsage } | null = null

/**
 * Usage for the Settings page. Concurrent requests share one walk, and a
 * finished result is reused for a few seconds unless a fresh count is asked
 * for (the Refresh button); a fresh request still joins a walk in progress.
 */
export function measureOutputStorage(outputDirectory: string, { fresh = false }: { fresh?: boolean } = {}): Promise<OutputStorageUsage> {
  const active = running.get(outputDirectory)
  if (active) return active
  if (!fresh && recent?.outputDirectory === outputDirectory && Date.now() - recent.at < REUSE_MS) return Promise.resolve(recent.usage)
  const walk = scanOutputStorage(outputDirectory)
    .then((usage) => { recent = { outputDirectory, at: Date.now(), usage }; return usage })
    .finally(() => running.delete(outputDirectory))
  running.set(outputDirectory, walk)
  return walk
}
