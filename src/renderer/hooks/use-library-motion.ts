import { useReorderMotion } from './use-reorder-motion'

export function useLibraryMotion(): ReturnType<typeof useReorderMotion> {
  return useReorderMotion('data-library-layout')
}
