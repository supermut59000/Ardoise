import { describe, it, expect } from 'vitest'
import { computeOwed, distributeRemainder, pinnedParts, validateSplit } from './split'
import type { ExpenseShare } from './types'

const shares = (entries: [string, number][]): ExpenseShare[] =>
  entries.map(([memberId, weight]) => ({ memberId, weight }))
const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)

describe('computeOwed', () => {
  it('equal split (default / undefined mode) conserves the total', () => {
    const r = computeOwed(100, undefined, shares([['a', 1], ['b', 1], ['c', 1]]))
    expect(sum(r)).toBe(100)
    expect(r.get('a')).toBe(34)
  })

  it('shares split respects parts (2:1:1)', () => {
    const r = computeOwed(1000, 'shares', shares([['a', 2], ['b', 1], ['c', 1]]))
    expect(sum(r)).toBe(1000)
    expect(r.get('a')).toBe(500)
    expect(r.get('b')).toBe(250)
  })

  it('percent split (50/25/25) conserves the total', () => {
    const r = computeOwed(2000, 'percent', shares([['a', 50], ['b', 25], ['c', 25]]))
    expect(sum(r)).toBe(2000)
    expect(r.get('a')).toBe(1000)
    expect(r.get('b')).toBe(500)
  })

  it('percent split with rounding (33/33/34) still conserves the total', () => {
    const r = computeOwed(1000, 'percent', shares([['a', 33], ['b', 33], ['c', 34]]))
    expect(sum(r)).toBe(1000)
  })

  it('exact split uses the given cents verbatim', () => {
    const r = computeOwed(1000, 'exact', shares([['a', 700], ['b', 300]]))
    expect(r.get('a')).toBe(700)
    expect(r.get('b')).toBe(300)
    expect(sum(r)).toBe(1000)
  })

  it('decimal percent split (20,5 / 79,5) is honored, not floored', () => {
    // Discriminates against the old Math.floor path: 20/79 would neither
    // validate nor produce 205/795.
    const r = computeOwed(1000, 'percent', shares([['a', 20.5], ['b', 79.5]]))
    expect(r.get('a')).toBe(205)
    expect(r.get('b')).toBe(795)
    expect(sum(r)).toBe(1000)
  })

  it('decimal percent thirds (33,33 x2 + 33,34) conserve the total', () => {
    const r = computeOwed(3000, 'percent', shares([['a', 33.33], ['b', 33.33], ['c', 33.34]]))
    expect(sum(r)).toBe(3000)
  })

  it('decimal shares split (1,5 vs 1) splits 3:2, not 1:1', () => {
    // Discriminates against the old Math.floor behavior, which turned 1.5 into
    // 1 and produced a 500/500 split instead of 600/400.
    const r = computeOwed(1000, 'shares', shares([['a', 1.5], ['b', 1]]))
    expect(r.get('a')).toBe(600)
    expect(r.get('b')).toBe(400)
    expect(sum(r)).toBe(1000)
  })
})

describe('distributeRemainder', () => {
  const sumOf = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)

  it('splits evenly when the user typed nothing', () => {
    const r = distributeRemainder(10_000, ['a', 'b', 'c'], new Map())
    expect(sumOf(r)).toBe(10_000) // exactly 100 %
    expect([...r.values()].sort()).toEqual([3333, 3333, 3334])
  })

  it('the untouched members absorb the rest (the whole point)', () => {
    // Bob at 40 %: Alice and Charlie must land on 30/30 without the user
    // computing anything.
    const r = distributeRemainder(10_000, ['a', 'b', 'c'], new Map([['b', 4000]]))
    expect(r.get('b')).toBe(4000)
    expect(r.get('a')).toBe(3000)
    expect(r.get('c')).toBe(3000)
    expect(sumOf(r)).toBe(10_000)
  })

  it('works in cents for the exact mode', () => {
    // 30,00 EUR, Bob pays 12,00: the two others owe 9,00 each.
    const r = distributeRemainder(3000, ['a', 'b', 'c'], new Map([['b', 1200]]))
    expect(r.get('a')).toBe(900)
    expect(r.get('c')).toBe(900)
    expect(sumOf(r)).toBe(3000)
  })

  it('keeps the remainder exact when the rest does not divide evenly', () => {
    const r = distributeRemainder(1000, ['a', 'b', 'c'], new Map([['a', 1]]))
    expect(sumOf(r)).toBe(1000)
    expect([r.get('b'), r.get('c')].sort()).toEqual([499, 500])
  })

  it('returns the typed values untouched when every member is typed', () => {
    const fixed = new Map([['a', 6000], ['b', 4000]])
    expect(distributeRemainder(10_000, ['a', 'b'], fixed)).toEqual(fixed)
  })

  it('gives absorbers 0 when the typed parts already overflow the total', () => {
    // Never negative: validateSplit reports the overflow instead.
    const r = distributeRemainder(10_000, ['a', 'b'], new Map([['a', 12_000]]))
    expect(r.get('a')).toBe(12_000)
    expect(r.get('b')).toBe(0)
  })

  it('ignores fixed values for members who are not selected', () => {
    const r = distributeRemainder(10_000, ['a'], new Map([['a', 2500], ['ghost', 9999]]))
    expect(r.has('ghost')).toBe(false)
    expect(r.get('a')).toBe(2500)
  })
})

describe('pinnedParts', () => {
  it('pins nothing when the user has typed nothing and no expense is being edited', () => {
    expect(pinnedParts(['a', 'b'], {}, null).size).toBe(0)
  })

  it('shows an edited expense with its saved parts until something is typed', () => {
    const saved = { a: 6000, b: 4000 }
    const pinned = pinnedParts(['a', 'b'], {}, saved)
    expect(pinned.get('a')).toBe(6000)
    expect(pinned.get('b')).toBe(4000)
  })

  it('frees the saved parts as soon as one part is typed', () => {
    // The core rule: editing a saved 60/40 and typing 30 for b must leave a
    // free to absorb 70, not keep a pinned at 60 (which forced the user to do
    // the arithmetic that this whole feature removes).
    const pinned = pinnedParts(['a', 'b'], { b: 3000 }, { a: 6000, b: 4000 })
    expect(pinned.has('a')).toBe(false)
    expect(pinned.get('b')).toBe(3000)
  })

  it('treats a cleared or half-typed field as not pinned', () => {
    const pinned = pinnedParts(['a', 'b'], { b: null }, { a: 6000, b: 4000 })
    expect(pinned.size).toBe(0) // b is mid-edit, a was freed by the takeover
  })

  it('ignores members who are not selected', () => {
    const pinned = pinnedParts(['a'], { a: 2500, gone: 7500 }, null)
    expect([...pinned.keys()]).toEqual(['a'])
  })
})

describe('split editor chain (what the form actually computes)', () => {
  /** The form's derivation: pin what was typed, let the rest absorb, convert to
   *  share weights (percent parts are centi-percent, exact parts are cents). */
  function editorShares(
    mode: 'percent' | 'exact',
    amountCents: number,
    selected: string[],
    typedParts: Record<string, number | null>,
    saved: Record<string, number> | null = null,
  ): ExpenseShare[] {
    const total = mode === 'exact' ? amountCents : 10_000
    const balanced = distributeRemainder(total, selected, pinnedParts(selected, typedParts, saved))
    return selected.map((memberId) => {
      const value = balanced.get(memberId) ?? 0
      return { memberId, weight: mode === 'exact' ? value : value / 100 }
    })
  }

  it('40 % for Bob makes Alice 60 % on her own, in euros', () => {
    // 50,00 EUR: the exact complaint this feature answers.
    const s = editorShares('percent', 5000, ['alice', 'bob'], { bob: 4000 })
    expect(s).toEqual([{ memberId: 'alice', weight: 60 }, { memberId: 'bob', weight: 40 }])
    expect(validateSplit('percent', 5000, s)).toBeNull()
    const owed = computeOwed(5000, 'percent', s)
    expect(owed.get('alice')).toBe(3000)
    expect(owed.get('bob')).toBe(2000)
  })

  it('with three people, the two untouched ones share the rest', () => {
    const s = editorShares('percent', 6000, ['a', 'b', 'c'], { b: 5000 })
    expect(s.map((x) => x.weight)).toEqual([25, 50, 25])
    const owed = computeOwed(6000, 'percent', s)
    expect([...owed.values()].reduce((x, y) => x + y, 0)).toBe(6000)
  })

  it('exact mode: pinning one amount covers the rest automatically', () => {
    const s = editorShares('exact', 3000, ['a', 'b', 'c'], { b: 1200 })
    expect(s.map((x) => x.weight)).toEqual([900, 1200, 900])
    expect(validateSplit('exact', 3000, s)).toBeNull()
  })

  it('editing a saved 60/40 and typing 30 gives the other 70, not an error', () => {
    const s = editorShares('percent', 1000, ['a', 'b'], { b: 3000 }, { a: 6000, b: 4000 })
    expect(s).toEqual([{ memberId: 'a', weight: 70 }, { memberId: 'b', weight: 30 }])
    expect(validateSplit('percent', 1000, s)).toBeNull()
  })

  it('deselecting a member hands their part to the others', () => {
    const s = editorShares('exact', 3000, ['a', 'c'], {})
    expect(s.map((x) => x.weight)).toEqual([1500, 1500])
  })
})

describe('validateSplit', () => {
  it('rejects an empty participant list in any mode', () => {
    expect(validateSplit('equal', 100, [])).not.toBeNull()
    expect(validateSplit('exact', 100, [])).not.toBeNull()
  })

  it('accepts a valid equal split', () => {
    expect(validateSplit('equal', 100, shares([['a', 1], ['b', 1]]))).toBeNull()
  })

  it('exact must sum to the total', () => {
    expect(validateSplit('exact', 1000, shares([['a', 700], ['b', 300]]))).toBeNull()
    expect(validateSplit('exact', 1000, shares([['a', 700], ['b', 200]]))).not.toBeNull()
  })

  it('percent must total 100', () => {
    expect(validateSplit('percent', 1000, shares([['a', 60], ['b', 40]]))).toBeNull()
    expect(validateSplit('percent', 1000, shares([['a', 60], ['b', 30]]))).not.toBeNull()
  })

  it('decimal percents totalling 100 are accepted despite float error', () => {
    // 33.33 + 33.33 + 33.34 !== 100 in IEEE floats; the strict !== 100 check
    // used to reject what the user correctly typed.
    expect(validateSplit('percent', 1000, shares([['a', 33.33], ['b', 33.33], ['c', 33.34]]))).toBeNull()
    // A real off-by-a-tenth still fails.
    expect(validateSplit('percent', 1000, shares([['a', 33.33], ['b', 33.33], ['c', 33.24]]))).not.toBeNull()
  })

  it('shares needs at least one positive part', () => {
    expect(validateSplit('shares', 1000, shares([['a', 0], ['b', 0]]))).not.toBeNull()
    expect(validateSplit('shares', 1000, shares([['a', 1], ['b', 0]]))).toBeNull()
  })
})
