import { JEV_DOCS_URL, JEV_CONFIDENCE_URL } from '../shared/jev-settings'
import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { constants, realpathSync, statSync } from 'fs'
import { open, type FileHandle } from 'fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'path'
import { BRIDGEMIND_URL, DISCORD_URL, ISSUES_URL, PROVIDER_LINKS, RELEASES_URL, REPO_URL, ZERNIO_LINKS } from '../shared/brand'

export function assertTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow | null): void {
  if (!window || window.isDestroyed() || event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Unauthorized application request')
  }
}

export function isWebUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
  } catch { return false }
}

const externalLinks = new Set([JEV_DOCS_URL, JEV_CONFIDENCE_URL, BRIDGEMIND_URL, DISCORD_URL, ISSUES_URL, RELEASES_URL, REPO_URL, ...Object.values(PROVIDER_LINKS), ...Object.values(ZERNIO_LINKS)])
export function isTrustedExternalUrl(value: unknown): value is string {
  return isWebUrl(value) && (externalLinks.has(value) || /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/.test(value))
}

export function isWithinDirectory(path: string, directory: string): boolean {
  try {
    const rel = relative(realpathSync(directory), realpathSync(path))
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  } catch { return false }
}

const mediaExtensions = new Set(['.mp4', '.m4v', '.mkv', '.webm', '.avi', '.mov', '.flv', '.jpg', '.jpeg', '.png', '.webp'])
const selectedMedia = new Map<string, { dev: number; ino: number }>()
export function authorizeMedia(path: string): string {
  const canonical = realpathSync(path)
  const file = statSync(canonical)
  if (!mediaExtensions.has(extname(canonical).toLowerCase()) || !file.isFile()) {
    throw new Error('Choose a supported media file')
  }
  selectedMedia.set(canonical, { dev: file.dev, ino: file.ino })
  return canonical
}
export function assertMediaPath(path: unknown, outputDirectory: string): asserts path is string {
  if (typeof path !== 'string' || !isAbsolute(path) || !mediaExtensions.has(extname(path).toLowerCase())) {
    throw new Error('Invalid media path')
  }
  const canonical = realpathSync(path)
  const file = statSync(canonical)
  const selected = selectedMedia.get(canonical)
  const isSelectedFile = selected?.dev === file.dev && selected.ino === file.ino
  if (!mediaExtensions.has(extname(canonical).toLowerCase()) || !file.isFile() || (!isSelectedFile && !isWithinDirectory(canonical, outputDirectory))) {
    throw new Error('Media file is outside the library')
  }
}

/** Open the authorized inode once so a later path replacement cannot change the bytes we read. */
export async function openAuthorizedMedia(path: string, outputDirectory: string): Promise<{ handle: FileHandle; size: number; canonical: string }> {
  assertMediaPath(path, outputDirectory)
  const canonical = realpathSync(path)
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    const currentPath = realpathSync(canonical)
    const current = statSync(currentPath)
    assertMediaPath(currentPath, outputDirectory)
    if (!opened.isFile() || currentPath !== canonical || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error('Media changed while opening')
    }
    return { handle, size: opened.size, canonical }
  } catch (error) {
    await handle.close()
    throw error
  }
}
export function assertAbsolutePath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !isAbsolute(resolve(value)) || !isAbsolute(value)) {
    throw new Error('An absolute path is required')
  }
}
