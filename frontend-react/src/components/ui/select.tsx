import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Native select, explicitly themed for both modes: the closed control always
 * uses our tokens (never the UA default white), and the options are themed
 * for the browsers that style them (Chrome/Android); `color-scheme` in
 * index.css covers the OS-rendered popup on the rest (iOS, date-style pickers).
 */
function Select({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      data-slot="select"
      className={cn(
        'h-11 w-full cursor-pointer rounded-md border bg-background px-3 text-base text-foreground shadow-xs outline-none transition-[color,box-shadow]',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        '[&>option]:bg-background [&>option]:text-foreground',
        className,
      )}
      {...props}
    />
  )
}

export { Select }
