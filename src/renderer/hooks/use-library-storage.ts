import { useEffect, useState } from 'react'
import type { OutputStorageUsage } from '../../shared/output-storage'
import { getApi } from '../lib/ipc'

/** Load sizes independently of cards and thumbnails, with only three scans in flight. */
export function useLibraryStorage(pathsKey: string, revision: number): Record<string, OutputStorageUsage | null | undefined> {
  const [sizes, setSizes] = useState<Record<string, OutputStorageUsage | null | undefined>>({})
  useEffect(() => {
    const paths = JSON.parse(pathsKey) as string[]
    let active = true
    let next = 0
    // Keep settled sizes while refreshing; forget runs that left this Library.
    setSizes(previous => Object.fromEntries(paths.map(path => [path, previous[path]])))
    const measure = async (): Promise<void> => {
      while (active && next < paths.length) {
        const path = paths[next++]
        let result: OutputStorageUsage | null = null
        try {
          const usage = await getApi().history.storageUsage(path)
          if (usage.outputDirectory === path && usage.exists) result = usage
        } catch { /* An unavailable folder must never look like zero bytes. */ }
        if (active) setSizes(previous => ({ ...previous, [path]: result }))
      }
    }
    for (let i = 0; i < Math.min(3, paths.length); i++) void measure()
    return () => { active = false }
  }, [pathsKey, revision])
  return sizes
}
