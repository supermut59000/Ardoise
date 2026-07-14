import { describe, it, expect } from 'vitest'
import { computeOwed, validateSplit } from './split'
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

  it('shares needs at least one positive part', () => {
    expect(validateSplit('shares', 1000, shares([['a', 0], ['b', 0]]))).not.toBeNull()
    expect(validateSplit('shares', 1000, shares([['a', 1], ['b', 0]]))).toBeNull()
  })
})
