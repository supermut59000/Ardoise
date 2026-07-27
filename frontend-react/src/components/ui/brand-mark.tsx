import { needsDarkInk, type BrandEntry } from '@/lib/brands'
import { cn } from '@/lib/utils'

interface Props {
  brand: BrandEntry
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const SIZES = {
  sm: 'size-8',
  md: 'size-10',
  lg: 'size-11',
} as const

/**
 * A brand's glyph on its own colour, in the same rounded tile the emoji uses on
 * an expense row. The ink flips to dark on light brand colours (McDonald's
 * yellow) and the ring keeps near-black marks (Uber) visible in dark mode.
 */
export function BrandMark({ brand, size = 'md', className }: Props) {
  const dark = needsDarkInk(brand.hex)
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full ring-1 ring-black/10 dark:ring-white/20',
        SIZES[size],
        className,
      )}
      style={{ backgroundColor: `#${brand.hex}` }}
      role="img"
      aria-label={brand.name}
      title={brand.name}
    >
      <svg
        viewBox="0 0 24 24"
        className="size-1/2"
        fill={dark ? '#111111' : '#ffffff'}
        aria-hidden="true"
      >
        <path d={brand.path} />
      </svg>
    </span>
  )
}
