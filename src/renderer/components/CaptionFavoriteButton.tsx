import { Bookmark } from 'lucide-react'
import { useCaptionFavoritesStore } from '../store/use-caption-favorites-store'
import { Button } from './ui/Button'
import { cn } from '../lib/utils'

export function CaptionFavoriteButton({ id, name, disabled, className, onToggle, beforeToggle }: {
  id: string; name: string; disabled?: boolean; className?: string; onToggle?: () => void; beforeToggle?: () => void
}): React.JSX.Element {
  const favorite = useCaptionFavoritesStore(state => state.favorites.includes(id))
  const loaded = useCaptionFavoritesStore(state => state.loaded)
  return <Button size="sm" variant="ghost" iconOnly disabled={disabled || !loaded}
    className={cn('caption-bookmark', favorite && 'text-[#f2c66d] hover:text-[#f2c66d]', className)}
    aria-label={`${favorite ? 'Remove bookmark from' : 'Bookmark'} ${name}`} aria-pressed={favorite}
    title={favorite ? 'Remove from favorites' : 'Add to favorites'}
    icon={<Bookmark size={14} fill={favorite ? 'currentColor' : 'none'} />}
    onClick={() => { beforeToggle?.(); useCaptionFavoritesStore.getState().toggle(id); onToggle?.() }} />
}
