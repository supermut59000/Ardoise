import { avatarColor, initials } from '@/lib/avatar'
import { cn } from '@/lib/utils'

interface Props {
  name: string
  /** Stable seed for the colour (member id). Falls back to the name. */
  seed?: string
  size?: 'xs' | 'sm' | 'md'
  className?: string
}

const SIZES = {
  xs: 'size-6 text-[10px]',
  sm: 'size-8 text-xs',
  md: 'size-10 text-sm',
} as const

export function MemberAvatar({ name, seed, size = 'sm', className }: Props) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-2 ring-background',
        SIZES[size],
        className,
      )}
      style={{ backgroundColor: avatarColor(seed ?? name) }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  )
}
