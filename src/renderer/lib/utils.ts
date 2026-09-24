import { twitchVodId } from '../../shared/video-source'
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes === 0) return `${remainingSeconds}s`
  return `${minutes}m ${remainingSeconds}s`
}

/** Timecode for a position in a video: 0:07, 12:34, 1:02:03. */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/**
 * Parse "90", "1:30" or "1:02:03" into seconds. Empty input is null (no
 * bound); anything unparseable is NaN so callers can flag it.
 */
export function parseTimecode(input: string): number | null {
  const value = input.trim()
  if (!value) return null
  if (/^\d+(\.\d+)?$/.test(value)) {
    const seconds = Number(value)
    return Number.isFinite(seconds) ? seconds : NaN
  }
  if (!/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(value)) return NaN
  const parts = value.split(':').map(Number)
  if (parts.slice(1).some((part) => part >= 60)) return NaN
  const seconds = parts.reduce((acc, part) => acc * 60 + part, 0)
  return Number.isFinite(seconds) ? seconds : NaN
}

/** URL for a file on disk, served by the main process's local-file:// protocol. */
export function localFileUrl(filePath: string): string {
  return `local-file://${encodeURIComponent(filePath)}`
}

/** Readable message from an IPC rejection (drops Electron's "Error invoking remote method" prefix). */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const cleaned = raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').trim()
  return cleaned || fallback
}

export function formatUsd(amount: number): string {
  if (amount === 0) return '$0.00'
  if (amount < 0.01) return `$${amount.toFixed(4)}`
  return `$${amount.toFixed(2)}`
}

export function formatDate(isoString: string): string {
  const date = new Date(isoString)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** "Today, 3:42 PM", "Yesterday, 9:10 AM", "Sep 12", "Sep 12, 2025". */
export function formatRelativeDate(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  if (days === 0) return `Today, ${time}`
  if (days === 1) return `Yesterday, ${time}`
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== now.getFullYear() && { year: 'numeric' })
  })
}

export function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim())
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** Video id for youtube.com/watch, youtu.be and /shorts links. */
export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\.|^m\./, '')
    if (host === 'youtu.be') return u.pathname.slice(1) || null
    if (host === 'youtube.com' || host === 'music.youtube.com') {
      if (u.searchParams.get('v')) return u.searchParams.get('v')
      const match = u.pathname.match(/^\/(shorts|live|embed)\/([^/?#]+)/)
      return match?.[2] ?? null
    }
  } catch {
    // not a URL
  }
  return null
}

/** Short human label for a clip source: file name, or host + path for links. */
export function sourceLabel(source: string): string {
  const twitchId = twitchVodId(source)
  if (twitchId) return `Twitch VOD · ${twitchId}`
  if (!isUrl(source)) return basename(source)
  try {
    const u = new URL(source)
    return `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}${u.search}`
  } catch {
    return source
  }
}

export const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
export const MOD_KEY = isMac ? '⌘' : 'Ctrl+'
