import { CalendarDays } from 'lucide-react'
import { dayLabel } from '@/lib/format'

interface Props {
  id?: string
  /** ISO date (YYYY-MM-DD). */
  value: string
  onChange: (iso: string) => void
}

/**
 * Date picker that always reads in French. A native `<input type=date>`
 * renders in the browser locale (e.g. "03/25/2026" on an English phone), so
 * the real input sits invisible on top (native picker keeps working, focus
 * and keyboard included) while the visible layer shows "Aujourd'hui",
 * "Hier" or "25 mars".
 */
export function DateField({ id, value, onChange }: Props) {
  return (
    <div className="relative">
      <input
        type="date"
        id={id}
        value={value}
        onChange={(e) => {
          // Ignore the empty value while the user is mid-edit in the picker.
          if (e.target.value) onChange(e.target.value)
        }}
        aria-label="Date"
        className="peer absolute inset-0 size-full cursor-pointer opacity-0"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none flex h-11 w-full items-center justify-between rounded-md border bg-transparent px-3 text-base shadow-xs peer-focus-visible:border-ring peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50"
      >
        <span>{dayLabel(value)}</span>
        <CalendarDays className="size-4 text-muted-foreground" />
      </div>
    </div>
  )
}
