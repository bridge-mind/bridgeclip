// Single source for product identity, shared by the main process (menu,
// window title) and the renderer.
export const APP_NAME = 'BridgeClip'
export const APP_TAGLINE = 'Open-source AI video clipping'

export const REPO_URL = 'https://github.com/bridge-mind/bridgeclip'
export const ISSUES_URL = `${REPO_URL}/issues`
export const RELEASES_URL = `${REPO_URL}/releases`
export const LICENSE_NAME = 'MIT'
export const BRIDGEMIND_URL = 'https://www.bridgemind.ai'
export const DISCORD_URL = 'https://www.bridgemind.ai/discord'

export const PROVIDER_LINKS = {
  openrouter: 'https://openrouter.ai/keys',
  zernio: 'https://zernio.com/dashboard/api-keys'
} as const

export const ZERNIO_LINKS = {
  signup: 'https://zernio.com/signup',
  pricing: 'https://zernio.com/pricing',
  billing: 'https://zernio.com/dashboard/billing'
} as const
