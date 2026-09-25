import lockupUrl from '../../../../resources/bridgeclip-logo.svg'
import iconUrl from '../../../../resources/bridgeclip-icon-small.svg'
import markUrl from '../../../../resources/bridgemind-mark.svg'
import { cn } from '../../lib/utils'

interface BridgeClipLogoProps {
  /**
   * lockup: BridgeMind mark + "BridgeClip" wordmark (artwork is for dark surfaces).
   * icon:   the app icon tile, a clip/play emblem in BridgeMind gold and cyan.
   * mark:   the mark alone, for tight spaces such as the collapsed sidebar.
   */
  variant?: 'lockup' | 'icon' | 'mark'
  /** Size by height (e.g. "h-6"); width follows the artwork. */
  className?: string
  alt?: string
}

/**
 * BridgeClip brand artwork. Regenerate the exports with
 * scripts/icon/build-logo.py (lockup) and scripts/icon/build-icons.sh (icon).
 */
export function BridgeClipLogo({ variant = 'lockup', className, alt = 'BridgeClip' }: BridgeClipLogoProps): React.JSX.Element {
  return (
    <img
      src={variant === 'icon' ? iconUrl : variant === 'mark' ? markUrl : lockupUrl}
      alt={alt}
      draggable={false}
      className={cn('w-auto shrink-0 select-none', className)}
    />
  )
}
