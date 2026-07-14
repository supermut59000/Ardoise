// Stable per-member color + initials, so you recognize people at a glance
// (the clarity win Tricount gets from its coloured avatars).
//
// Hues avoid the emerald/rose used for balance +/- so identity never reads as
// "owed/owes". All chosen for >= 4.5:1 contrast against white text.
const AVATAR_COLORS = [
  '#4f46e5', // indigo
  '#0891b2', // cyan
  '#7c3aed', // violet
  '#db2777', // pink
  '#ea580c', // orange
  '#0d9488', // teal
  '#2563eb', // blue
  '#9333ea', // purple
  '#c2410c', // burnt orange
  '#0369a1', // deep blue
]

function hash(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = (h << 5) - h + seed.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h)
}

/** Deterministic colour for a member; pass a stable seed (the member id). */
export function avatarColor(seed: string): string {
  return AVATAR_COLORS[hash(seed) % AVATAR_COLORS.length]
}

/** 1-2 letter initials from a display name. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}
