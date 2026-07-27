/**
 * Brand marks on expenses: "Burger King" shows the Burger King glyph instead of
 * a generic burger emoji. Same idea as the emoji (D24): user content on a
 * depense, an ordinary payload field, so fold, sync and the relay need nothing.
 *
 * Every brand carries a fallback `emoji`, so a brand expense still contributes
 * to the emoji strip on the home cards, and so nothing is lost if a brand is
 * ever dropped from the catalogue.
 *
 * Data (glyph paths and colours) is generated: see brands.generated.ts.
 */
import { BRANDS, type BrandEntry } from './brands.generated'
import { normalize } from './emoji'

export type { BrandEntry }
export { BRANDS }

const BY_ID = new Map(BRANDS.map((b) => [b.id, b]))

/** The brand an expense refers to, or undefined (unknown id, or none set). */
export function findBrand(id: string | undefined | null): BrandEntry | undefined {
  return id ? BY_ID.get(id) : undefined
}

/** Words of a description, normalized: "Courses Carrefour !" -> [courses, carrefour]. */
function words(text: string): string[] {
  return normalize(text).split(/[^a-z0-9]+/).filter(Boolean)
}

/** Does `phrase` (already split) appear as consecutive whole words? */
function containsPhrase(haystack: string[], phrase: string[]): boolean {
  if (phrase.length === 0 || phrase.length > haystack.length) return false
  for (let i = 0; i + phrase.length <= haystack.length; i++) {
    let hit = true
    for (let j = 0; j < phrase.length; j++) {
      if (haystack[i + j] !== phrase[j]) {
        hit = false
        break
      }
    }
    if (hit) return true
  }
  return false
}

/**
 * Brand suggested by a free-text description, or null.
 *
 * Whole words only, so "carte" never triggers Carrefour and a description that
 * merely contains a brand's letters is left alone. The longest keyword wins, so
 * "Uber Eats" is the meal, not the ride.
 */
export function suggestBrand(description: string): BrandEntry | null {
  const haystack = words(description)
  if (haystack.length === 0) return null

  let best: BrandEntry | null = null
  let bestLength = 0
  for (const brand of BRANDS) {
    for (const keyword of brand.keywords) {
      const phrase = keyword.split(' ')
      if (!containsPhrase(haystack, phrase)) continue
      // More words first, then the longer keyword: "uber eats" beats "uber".
      const length = phrase.length * 100 + keyword.length
      if (length > bestLength) {
        bestLength = length
        best = brand
      }
    }
  }
  return best
}

/**
 * Brands matching a picker query: exact keyword or name prefix first, then any
 * substring, so typing "car" offers Carrefour before Castorama.
 */
export function searchBrands(query: string, limit = 8): BrandEntry[] {
  const q = normalize(query.trim())
  if (!q) return []

  const scored: { brand: BrandEntry; score: number; index: number }[] = []
  BRANDS.forEach((brand, index) => {
    const haystacks = [normalize(brand.name), ...brand.keywords]
    let best = 0
    for (const candidate of haystacks) {
      if (candidate === q) best = Math.max(best, 3)
      else if (candidate.startsWith(q)) best = Math.max(best, 2)
      else if (candidate.includes(q)) best = Math.max(best, 1)
    }
    if (best > 0) scored.push({ brand, score: best, index })
  })

  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((s) => s.brand)
}

export interface BrandCompletion {
  brand: BrandEntry
  /** The description with the fragment being typed replaced by the brand name. */
  completed: string
}

/**
 * Trailing fragments of a description, longest first: the 3, 2 and 1 last words
 * with where each starts, so a completion can replace exactly what is being
 * typed and leave "Courses " alone in "Courses carre".
 */
function trailingFragments(description: string): { text: string; start: number }[] {
  const words: { text: string; start: number }[] = []
  const re = /\S+/g
  let match: RegExpExecArray | null
  while ((match = re.exec(description)) !== null) {
    words.push({ text: match[0], start: match.index })
  }
  const out: { text: string; start: number }[] = []
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const first = words[words.length - n]
    out.push({ text: description.slice(first.start).trim(), start: first.start })
  }
  return out
}

/**
 * Brands to offer while the description is being typed: "burg" proposes Burger
 * King, "Courses carre" proposes "Courses Carrefour". Multi-word brands are
 * reachable too, since the last three words are tried before the last one.
 *
 * Completions that would not change the text are dropped: once the name is
 * fully typed the logo is already set, so the list would only be in the way.
 */
export function completeBrand(description: string, limit = 4): BrandCompletion[] {
  const seen = new Set<string>()
  const out: BrandCompletion[] = []

  for (const fragment of trailingFragments(description)) {
    const q = normalize(fragment.text)
    if (q.length < 2) continue

    const scored: { brand: BrandEntry; score: number; index: number }[] = []
    BRANDS.forEach((brand, index) => {
      if (seen.has(brand.id)) return
      const name = normalize(brand.name)
      let score = 0
      if (name.startsWith(q)) score = 2
      else if (brand.keywords.some((k) => k.startsWith(q))) score = 1
      if (score > 0) scored.push({ brand, score, index })
    })

    scored
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .forEach(({ brand }) => {
        const completed = description.slice(0, fragment.start) + brand.name
        // Nothing to complete: the user already typed the whole name.
        if (completed.toLowerCase() === description.toLowerCase()) return
        seen.add(brand.id)
        out.push({ brand, completed })
      })
  }

  return out.slice(0, limit)
}

/**
 * Whether a brand's colour needs dark ink on top. Uses the sRGB luminance the
 * WCAG contrast formula is built on, so McDonald's yellow gets a dark glyph
 * while Uber's black gets a white one.
 */
export function needsDarkInk(hex: string): boolean {
  const value = parseInt(hex, 16)
  const channel = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const r = channel((value >> 16) & 0xff)
  const g = channel((value >> 8) & 0xff)
  const b = channel(value & 0xff)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4
}
