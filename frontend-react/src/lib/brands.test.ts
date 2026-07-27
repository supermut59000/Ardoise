import { describe, it, expect } from 'vitest'
import { BRANDS, findBrand, needsDarkInk, searchBrands, suggestBrand } from './brands'

describe('suggestBrand', () => {
  it('recognises a brand written on its own', () => {
    expect(suggestBrand('Burger King')?.id).toBe('burgerking')
    expect(suggestBrand('carrefour')?.id).toBe('carrefour')
  })

  it('recognises a brand inside a sentence, accents and case aside', () => {
    expect(suggestBrand('Courses au Carrefour du coin')?.id).toBe('carrefour')
    expect(suggestBrand('INTERMARCHÉ samedi')?.id).toBe('intermarche')
  })

  it('prefers the longest keyword: Uber Eats is the meal, not the ride', () => {
    expect(suggestBrand('Uber Eats vendredi')?.id).toBe('ubereats')
    expect(suggestBrand('Uber pour rentrer')?.id).toBe('uber')
  })

  it('matches whole words only, so ordinary words never summon a logo', () => {
    // The regression this guards: substring matching would light up Carrefour
    // on "carte", Cora on "corail", Apple on "grappe".
    expect(suggestBrand('Paiement par carte')).toBeNull()
    expect(suggestBrand('Collier de corail')).toBeNull()
    expect(suggestBrand('Grappe de raisin')).toBeNull()
    expect(suggestBrand('Une casserole')).toBeNull()
  })

  it('leaves French words that happen to be brands alone', () => {
    // 'orange' (the fruit) and 'boulanger' (the baker) are deliberately not
    // keywords; a jus d'orange must not be labelled with a telecom logo.
    expect(suggestBrand("Jus d'orange")).toBeNull()
    expect(suggestBrand('Pain chez le boulanger')).toBeNull()
  })

  it('returns null on an empty or unknown description', () => {
    expect(suggestBrand('')).toBeNull()
    expect(suggestBrand('Restaurant du village')).toBeNull()
  })

  it('every brand is reachable through each of its own keywords', () => {
    for (const brand of BRANDS) {
      for (const keyword of brand.keywords) {
        expect(suggestBrand(`Depense ${keyword} du jour`)?.id).toBe(brand.id)
      }
    }
  })
})

describe('searchBrands', () => {
  it('ranks an exact keyword above a mere substring', () => {
    const ids = searchBrands('carrefour').map((b) => b.id)
    expect(ids[0]).toBe('carrefour')
  })

  it('finds brands by prefix', () => {
    expect(searchBrands('mcdo').map((b) => b.id)).toContain('mcdonalds')
    expect(searchBrands('net').map((b) => b.id)).toContain('netflix')
  })

  it('returns nothing for an empty query', () => {
    expect(searchBrands('')).toEqual([])
  })
})

describe('findBrand', () => {
  it('resolves a stored id and tolerates unknown or absent ones', () => {
    expect(findBrand('burgerking')?.name).toBe('Burger King')
    expect(findBrand('disparu')).toBeUndefined()
    expect(findBrand(undefined)).toBeUndefined()
    expect(findBrand('')).toBeUndefined()
  })
})

describe('needsDarkInk', () => {
  it('puts dark ink on light brand colours and white on dark ones', () => {
    expect(needsDarkInk('FBC817')).toBe(true) // McDonald's yellow
    expect(needsDarkInk('000000')).toBe(false) // Uber black
    expect(needsDarkInk('D62300')).toBe(false) // Burger King red
    expect(needsDarkInk('FFFFFF')).toBe(true)
  })
})

describe('brand catalogue', () => {
  it('has unique ids and a fallback emoji everywhere', () => {
    const ids = BRANDS.map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const brand of BRANDS) {
      expect(brand.emoji.length).toBeGreaterThan(0)
      expect(brand.path.length).toBeGreaterThan(0)
      expect(brand.hex).toMatch(/^[0-9A-F]{6}$/)
    }
  })
})
