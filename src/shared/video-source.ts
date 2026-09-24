/** Twitch pages require the VOD extractor; other links retain direct-video support. */
export const TWITCH_VOD_HINT = 'Choose a public, completed Twitch VOD using its video link. Live channels, collections and Twitch clips are not supported.'
const TWITCH_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'go.twitch.tv'])

export function twitchVodId(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (!TWITCH_HOSTS.has(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null
    return url.pathname.match(/^\/videos\/([0-9]+)\/?$/)?.[1] ?? null
  } catch { return null }
}

export function twitchSourceError(value: string): string | null {
  try {
    const url = new URL(value.trim())
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    return (host === 'twitch.tv' || host.endsWith('.twitch.tv')) && !twitchVodId(value) ? TWITCH_VOD_HINT : null
  } catch { return null }
}

export function normalizeVideoSource(value: string): string {
  const id = twitchVodId(value)
  return id ? `https://www.twitch.tv/videos/${id}` : value.trim()
}
