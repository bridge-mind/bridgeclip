import { Bookmark } from 'lucide-react'
import { useCaptionFavoritesStore } from '../store/use-caption-favorites-store'
import { Button } from './ui/Button'
import { cn } from '../lib/utils'

export function CaptionFavoriteButton({ id, name, disabled, className, onToggle }: {
  id: string; name: string; disabled?: boolean; className?: string; onToggle?: () => void
}): React.JSX.Element {
  const favorite = useCaptionFavoritesStore(state => state.favorites.includes(id))
  return <Button size="sm" variant="ghost" iconOnly disabled={disabled}
    className={cn(favorite && 'text-[#f2c66d] hover:text-[#f2c66d]', className)}
    aria-label={`${favorite ? 'Remove bookmark from' : 'Bookmark'} ${name}`} aria-pressed={favorite}
    title={favorite ? 'Remove from favorites' : 'Add to favorites'}
    icon={<Bookmark size={14} fill={favorite ? 'currentColor' : 'none'} />}
    onClick={() => { useCaptionFavoritesStore.getState().toggle(id); onToggle?.() }} />
}
