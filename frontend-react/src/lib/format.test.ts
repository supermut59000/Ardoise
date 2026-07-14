import { describe, it, expect } from 'vitest'
import { parseAmountToCents, formatCents } from './format'

describe('parseAmountToCents', () => {
  it('parses integers and decimals', () => {
    expect(parseAmountToCents('12')).toBe(1200)
    expect(parseAmountToCents('12.5')).toBe(1250)
    expect(parseAmountToCents('0.99')).toBe(99)
  })

  it('accepts the French comma decimal separator', () => {
    expect(parseAmountToCents('12,50')).toBe(1250)
    expect(parseAmountToCents('0,05')).toBe(5)
  })

  it('trims surrounding and inner whitespace', () => {
    expect(parseAmountToCents('  10 ')).toBe(1000)
    expect(parseAmountToCents('1 000')).toBe(100000)
  })

  it('rounds to the nearest cent (no floating drift)', () => {
    // 12.345 -> 1234.5 -> rounds to 1235
    expect(parseAmountToCents('12.345')).toBe(1235)
    // classic float trap: 0.1 + 0.2; here just 35.35
    expect(parseAmountToCents('35.35')).toBe(3535)
  })

  it('rejects empty, negative, and non-numeric input', () => {
    expect(parseAmountToCents('')).toBeNull()
    expect(parseAmountToCents('   ')).toBeNull()
    expect(parseAmountToCents('-5')).toBeNull()
    expect(parseAmountToCents('abc')).toBeNull()
    expect(parseAmountToCents('1.2.3')).toBeNull()
    expect(parseAmountToCents('12€')).toBeNull()
  })

  it('round-trips through formatCents for a typical value', () => {
    const cents = parseAmountToCents('42,00')!
    expect(cents).toBe(4200)
    expect(formatCents(cents)).toContain('42,00')
  })
})
