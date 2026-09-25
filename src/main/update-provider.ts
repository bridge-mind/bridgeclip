import type { AppUpdater } from 'electron-updater'
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider'
import { parseUpdateInfo, type ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider'

/** Where releases are published (electron-builder.yml `publish`). */
export const UPDATE_REPOSITORY = { owner: 'bridge-mind', repo: 'bridgeclip' } as const

/** How many recent releases to look through for one that ships this platform. */
const RELEASE_SCAN_LIMIT = 30

interface ReleaseListing {
  tag_name?: unknown
  draft?: unknown
  prerelease?: unknown
  assets?: { name?: unknown }[]
}

/**
 * The newest published, non-prerelease release whose assets include `channelFile`.
 * GitHub lists releases newest first.
 */
export function newestReleaseWith(releases: unknown, channelFile: string): string | null {
  if (!Array.isArray(releases)) return null
  for (const release of releases as ReleaseListing[]) {
    if (release.draft !== false || release.prerelease !== false) continue
    if (typeof release.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) continue
    if (Array.isArray(release.assets) && release.assets.some((asset) => asset.name === channelFile)) return release.tag_name
  }
  return null
}

/**
 * electron-updater's GitHub provider, for releases that don't all ship every platform.
 *
 * The stock provider only reads the release GitHub marks as latest. A release
 * can package a single platform, so a macOS-only release would leave Windows
 * and Linux with no `latest.yml` / `latest-linux.yml` to read (and a later
 * Windows-only release would do the same to macOS). When the latest release
 * has no update feed for this platform, this looks back for the newest release
 * that does. Everything else, including file resolution, SHA-512 checks and
 * code-signature checks, stays with electron-updater.
 */
export class PlatformGitHubProvider extends GitHubProvider {
  /** Installed as `{ provider: 'custom', updateProvider }`; always reads BridgeClip's releases. */
  constructor(_options: unknown, updater: AppUpdater, runtimeOptions: ProviderRuntimeOptions) {
    super({ provider: 'github', ...UPDATE_REPOSITORY }, updater, runtimeOptions)
  }

  async getLatestVersion(): ReturnType<GitHubProvider['getLatestVersion']> {
    try {
      return await super.getLatestVersion()
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') throw error
      const channelFile = `${this.getDefaultChannelName()}.yml`
      const { owner, repo } = this.options
      const listing = await this.httpRequest(
        new URL(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=${RELEASE_SCAN_LIMIT}`),
        { accept: 'application/vnd.github+json' }
      )
      const tag = newestReleaseWith(listing ? JSON.parse(listing) : null, channelFile)
      if (!tag) throw error
      const channelFileUrl = new URL(`https://github.com/${owner}/${repo}/releases/download/${tag}/${channelFile}`)
      const info = parseUpdateInfo(await this.httpRequest(channelFileUrl), channelFile, channelFileUrl)
      return { tag, ...info }
    }
  }
}
