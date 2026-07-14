import { describe, it, expect } from 'vitest'
import { splitCents, splitEqual } from './split'
import type { ExpenseShare } from './types'

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)

describe('splitEqual', () => {
  it('splits an evenly divisible amount exactly', () => {
    const r = splitEqual(6000, ['a', 'b', 'c'])
    expect([...r.values()]).toEqual([2000, 2000, 2000])
    expect(sum(r)).toBe(6000)
  })

  it('distributes the remainder deterministically to the first members', () => {
    // 100 / 3 = 33.33 -> 34, 33, 33
    const r = splitEqual(100, ['a', 'b', 'c'])
    expect(r.get('a')).toBe(34)
    expect(r.get('b')).toBe(33)
    expect(r.get('c')).toBe(33)
    expect(sum(r)).toBe(100)
  })

  it('conserves every cent for 10.00 / 3', () => {
    const r = splitEqual(1000, ['a', 'b', 'c'])
    expect(sum(r)).toBe(1000)
    expect([...r.values()]).toEqual([334, 333, 333])
  })

  it('handles 1 cent among 3 members (only one gets it)', () => {
    const r = splitEqual(1, ['a', 'b', 'c'])
    expect(sum(r)).toBe(1)
    expect([...r.values()].filter((v) => v === 1).length).toBe(1)
  })

  it('gives the whole amount to a single member', () => {
    const r = splitEqual(4237, ['solo'])
    expect(r.get('solo')).toBe(4237)
  })

  it('returns all zeros for a zero amount', () => {
    const r = splitEqual(0, ['a', 'b', 'c'])
    expect([...r.values()]).toEqual([0, 0, 0])
    expect(sum(r)).toBe(0)
  })

  it('returns an empty map for zero members (no crash, no lost cents)', () => {
    const r = splitEqual(500, [])
    expect(r.size).toBe(0)
  })

  it('is deterministic: same input yields identical output', () => {
    const a = splitEqual(10001, ['x', 'y', 'z', 'w'])
    const b = splitEqual(10001, ['x', 'y', 'z', 'w'])
    expect([...a.entries()]).toEqual([...b.entries()])
  })

  it('conserves the total for many random amounts and sizes', () => {
    let seed = 1
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let t = 0; t < 500; t++) {
      const n = 1 + Math.floor(rand() * 8)
      const amount = Math.floor(rand() * 1_000_000)
      const ids = Array.from({ length: n }, (_, i) => `m${i}`)
      const r = splitEqual(amount, ids)
      expect(sum(r)).toBe(amount)
      // no member ever owes a fraction; all integers
      for (const v of r.values()) expect(Number.isInteger(v)).toBe(true)
      // per-member difference is at most 1 cent
      const vals = [...r.values()]
      expect(Math.max(...vals) - Math.min(...vals)).toBeLessThanOrEqual(1)
    }
  })
})

describe('splitCents (weighted / edge)', () => {
  it('respects weights and conserves the total', () => {
    const shares: ExpenseShare[] = [
      { memberId: 'a', weight: 2 },
      { memberId: 'b', weight: 1 },
      { memberId: 'c', weight: 1 },
    ]
    const r = splitCents(1000, shares)
    expect(sum(r)).toBe(1000)
    expect(r.get('a')).toBe(500)
    expect(r.get('b')).toBe(250)
    expect(r.get('c')).toBe(250)
  })

  it('falls back to equal split when all weights are zero', () => {
    const shares: ExpenseShare[] = [
      { memberId: 'a', weight: 0 },
      { memberId: 'b', weight: 0 },
    ]
    const r = splitCents(1000, shares)
    expect(sum(r)).toBe(1000)
    expect(r.get('a')).toBe(500)
    expect(r.get('b')).toBe(500)
  })

  it('splits a negative amount (refund) and conserves the total', () => {
    const r = splitEqual(-100, ['a', 'b', 'c'])
    expect(sum(r)).toBe(-100)
    // mirror image of the positive case
    expect(r.get('a')).toBe(-34)
    expect(r.get('b')).toBe(-33)
    expect(r.get('c')).toBe(-33)
  })
})
