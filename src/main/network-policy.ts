import { lookup } from 'dns/promises'
import { isIP } from 'net'
import { isWebUrl } from './security'

/** Only publicly routable destinations are valid download/banner sources. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113))
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase()
    // Global unicast only; exclude IETF special-purpose (2001::/23, incl. Teredo),
    // documentation (2001:db8::/32) and 6to4 (2002::/16). The rest of 2001::/16
    // is ordinary public space (e.g. Google's 2001:4860::/32).
    if (!/^[23][0-9a-f]{3}:/.test(normalized) || normalized.startsWith('2002:')) return false
    if (normalized.startsWith('2001:')) {
      const second = parseInt(normalized.split(':')[1] || '0', 16)
      return second >= 0x200 && second !== 0xdb8
    }
    return true
  }
  return false
}

export async function assertPublicWebUrl(value: string): Promise<void> {
  if (!isWebUrl(value)) throw new Error('A public HTTP(S) URL is required')
  const hostname = new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) throw new Error('Local network sources are not allowed')
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new Error('Local network sources are not allowed')
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const addresses = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Source hostname lookup timed out')), 5000) })
    ])
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('Source must resolve to a public network address')
  } finally { if (timer) clearTimeout(timer) }
}
