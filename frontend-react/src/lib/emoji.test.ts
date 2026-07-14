import { describe, expect, it } from 'vitest'
import { EXPENSE_EMOJIS, normalize, searchEmojis, suggestEmoji } from './emoji'

describe('normalize', () => {
  it('lowercases and strips accents', () => {
    expect(normalize('Électricité')).toBe('electricite')
    expect(normalize('PÉAGE')).toBe('peage')
    expect(normalize('déjà-vu')).toBe('deja-vu')
  })
})

describe('searchEmojis', () => {
  it('returns the whole catalogue for an empty query', () => {
    expect(searchEmojis('', 999)).toHaveLength(EXPENSE_EMOJIS.length)
  })

  it('finds by exact keyword', () => {
    expect(searchEmojis('courses')[0].emoji).toBe('🛒')
    expect(searchEmojis('essence')[0].emoji).toBe('⛽')
  })

  it('finds by prefix (fuzzy typing)', () => {
    expect(searchEmojis('appart')[0].emoji).toBe('🏢')
    expect(searchEmojis('resto')[0].emoji).toBe('🍽️')
    expect(searchEmojis('boul').map((e) => e.emoji)).toContain('🥖')
  })

  it('is accent-insensitive', () => {
    expect(searchEmojis('électricité')[0].emoji).toBe('⚡')
    expect(searchEmojis('péage')[0].emoji).toBe('🛣️')
  })

  it('ranks exact keyword above substring matches', () => {
    // "bar" is an exact keyword of the beer emoji and a substring elsewhere.
    expect(searchEmojis('bar')[0].emoji).toBe('🍺')
  })

  it('matches word starts inside multi-word keywords', () => {
    expect(searchEmojis('ski').map((e) => e.emoji)).toContain('🎿')
  })

  it('has no duplicate emojis in the catalogue', () => {
    const all = EXPENSE_EMOJIS.map((e) => e.emoji)
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('suggestEmoji', () => {
  it('suggests from a whole word in the description', () => {
    expect(suggestEmoji('Courses Carrefour')).toBe('🛒')
    expect(suggestEmoji('essence sur la route')).toBe('⛽')
    expect(suggestEmoji('Restaurant vendredi soir')).toBe('🍽️')
  })

  it('is accent- and case-insensitive', () => {
    expect(suggestEmoji('Péage A26')).toBe('🛣️')
  })

  it('matches brand names', () => {
    expect(suggestEmoji('mcdo du midi')).toBe('🍔')
    expect(suggestEmoji('Uber retour')).toBe('🚕')
  })

  it('returns null when nothing matches', () => {
    expect(suggestEmoji('xyzzy blorp')).toBeNull()
    expect(suggestEmoji('')).toBeNull()
  })

  it('ignores words shorter than 3 letters so noise never triggers', () => {
    expect(suggestEmoji('le la du')).toBeNull()
  })
})
