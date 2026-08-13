import { describe, it, expect, afterEach, vi } from 'vitest'
import { dayLabel, limitTwoDecimals, parseAmountToCents, formatCents, todayIso } from './format'

describe('todayIso', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('uses the device timezone, not UTC (late-evening bug)', () => {
    // UTC+14: it is already the 15th locally while UTC still says the 14th.
    // The old toISOString() implementation returned 2026-07-14 here.
    vi.stubEnv('TZ', 'Pacific/Kiritimati')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-14T12:00:00Z'))
    expect(todayIso()).toBe('2026-07-15')
  })

  it('pads month and day to two digits', () => {
    vi.stubEnv('TZ', 'UTC')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-05T10:00:00Z'))
    expect(todayIso()).toBe('2026-03-05')
  })
})

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

  it('rounds two-decimal amounts to the nearest cent (no floating drift)', () => {
    // classic float trap: 35.35 * 100 = 3535.0000000000005 -> Math.round fixes it
    expect(parseAmountToCents('35.35')).toBe(3535)
    expect(parseAmountToCents('0,99')).toBe(99)
  })

  it('rejects more than two decimals instead of mis-rounding them', () => {
    // A third decimal used to round through float math: "1,005" * 100 =
    // 100.49999999999999 -> 100 (1,00 EUR instead of 1,01). Money has cents,
    // not thousandths, so it is blocked outright.
    expect(parseAmountToCents('1,005')).toBeNull()
    expect(parseAmountToCents('12.345')).toBeNull()
    expect(parseAmountToCents('4,005')).toBeNull()
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

describe('limitTwoDecimals', () => {
  it('caps a third decimal while preserving the typed separator', () => {
    expect(limitTwoDecimals('4,005')).toBe('4,00')
    expect(limitTwoDecimals('4.005')).toBe('4.00')
  })

  it('leaves one or two decimals and mid-edit states untouched', () => {
    expect(limitTwoDecimals('12')).toBe('12')
    expect(limitTwoDecimals('12,')).toBe('12,')
    expect(limitTwoDecimals('12,5')).toBe('12,5')
    expect(limitTwoDecimals('12,50')).toBe('12,50')
  })
})

describe('dayLabel', () => {
  const today = '2026-07-14'

  it("labels today and yesterday in words", () => {
    expect(dayLabel('2026-07-14', today)).toBe("Aujourd'hui")
    expect(dayLabel('2026-07-13', today)).toBe('Hier')
  })

  it('always includes the year on full dates', () => {
    expect(dayLabel('2026-07-01', today)).toBe('1 juillet 2026')
    expect(dayLabel('2025-12-31', today)).toBe('31 décembre 2025')
  })

  it('handles the year boundary for "Hier"', () => {
    expect(dayLabel('2025-12-31', '2026-01-01')).toBe('Hier')
  })

  it('falls back to the raw string on invalid input', () => {
    expect(dayLabel('not-a-date', today)).toBe('not-a-date')
  })
})
