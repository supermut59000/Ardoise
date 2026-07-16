import { useRef, type ReactNode } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SwipeableCardProps {
  children: ReactNode
  onSwipeLeft?: () => void
  onSwipeRight?: () => void
  leftLabel?: string
  rightLabel?: string
  className?: string
}

const THRESHOLD = 60
const MAX_SWIPE = 100

/**
 * Mobile swipe actions on a card (ported from VroomVroom):
 *   swipe right -> onSwipeRight (edit), swipe left -> onSwipeLeft (delete).
 * Direction-locks on the first move so vertical scrolling still works, and
 * springs back after release. Action backgrounds show on touch widths only.
 */
export function SwipeableCard({
  children,
  onSwipeLeft,
  onSwipeRight,
  leftLabel = 'Modifier',
  rightLabel = 'Supprimer',
  className,
}: SwipeableCardProps) {
  const foregroundRef = useRef<HTMLDivElement>(null)
  const startX = useRef(0)
  const startY = useRef(0)
  const currentOffset = useRef(0)
  const locked = useRef<'horizontal' | 'vertical' | null>(null)

  function handleTouchStart(e: React.TouchEvent) {
    startX.current = e.touches[0].clientX
    startY.current = e.touches[0].clientY
    currentOffset.current = 0
    locked.current = null
    if (foregroundRef.current) {
      foregroundRef.current.style.transition = 'none'
    }
  }

  function handleTouchMove(e: React.TouchEvent) {
    const deltaX = e.touches[0].clientX - startX.current
    const deltaY = e.touches[0].clientY - startY.current

    if (locked.current === null && (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5)) {
      locked.current = Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical'
    }

    if (locked.current !== 'horizontal') return

    e.preventDefault()

    const clamped = Math.max(-MAX_SWIPE, Math.min(MAX_SWIPE, deltaX))
    currentOffset.current = clamped
    if (foregroundRef.current) {
      foregroundRef.current.style.transform = `translateX(${clamped}px)`
    }
  }

  function springBack() {
    if (foregroundRef.current) {
      foregroundRef.current.style.transition = 'transform 200ms ease-out'
      foregroundRef.current.style.transform = 'translateX(0)'
    }
    currentOffset.current = 0
    locked.current = null
  }

  function handleTouchEnd() {
    const offset = currentOffset.current

    if (offset > THRESHOLD && onSwipeRight) onSwipeRight()
    if (offset < -THRESHOLD && onSwipeLeft) onSwipeLeft()

    springBack()
  }

  // A cancelled touch (incoming call, system gesture) fires touchcancel, not
  // touchend: spring back WITHOUT firing the actions, or the card stays stuck
  // half-swiped (and a past-threshold cancel must never delete).
  function handleTouchCancel() {
    springBack()
  }

  return (
    <div className={cn('relative overflow-hidden rounded-xl', className)}>
      {/* Action backgrounds (touch widths only) */}
      <div className="absolute inset-0 flex sm:hidden">
        <div className="flex w-1/2 items-center gap-2 bg-muted pl-4">
          <Pencil className="size-4 text-foreground" />
          <span className="text-sm font-medium">{leftLabel}</span>
        </div>
        <div className="flex w-1/2 items-center justify-end gap-2 bg-destructive pr-4">
          <span className="text-sm font-medium text-white">{rightLabel}</span>
          <Trash2 className="size-4 text-white" />
        </div>
      </div>

      <div
        ref={foregroundRef}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
        className="relative z-10 bg-card"
      >
        {children}
      </div>
    </div>
  )
}
