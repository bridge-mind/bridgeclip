import { lookup } from 'dns/promises'
import { isIP } from 'net'
import { isWebUrl } from './security'

/** Expand an IPv6 literal to its eight 16-bit groups, or null for IPv4-mapped forms. */
function ipv6Groups(address: string): number[] | null {
  if (address.includes('.')) return null
  const [head, tail = ''] = address.split('::')
  const left = head ? head.split(':').map((group) => parseInt(group, 16)) : []
  const right = tail ? tail.split(':').map((group) => parseInt(group, 16)) : []
  if (left.length + right.length > 8) return null
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right]
}

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
    const groups = ipv6Groups(address)
    if (!groups) return false
    const [g0, g1] = groups
    // Global unicast (2000::/3) minus 6to4, IETF protocol assignments
    // (2001::/23), and documentation (2001:db8::/32, 3fff::/20).
    // Other 2001::/16 addresses include ordinary public space.
    if (g0 < 0x2000 || g0 > 0x3fff || g0 === 0x2002 || (g0 === 0x3fff && g1 < 0x1000)) return false
    if (g0 === 0x2001) {
      return g1 >= 0x200 && g1 !== 0xdb8
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
