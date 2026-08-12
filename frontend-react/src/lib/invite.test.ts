import { describe, expect, it } from 'vitest'
import { buildAutomaticInvite, parseAutomaticInvite } from './invite'

describe('automatic QR invites', () => {
  it('keeps the group code and password in the URL fragment', () => {
    const link = buildAutomaticInvite('https://ardoise.example.com', 'ABCD2345', 'a key/+?')
    const url = new URL(link)
    expect(url.search).toBe('')
    expect(parseAutomaticInvite(url.hash)).toEqual({ joinCode: 'ABCD2345', apiKey: 'a key/+?' })
  })

  it('rejects a fragment without a join code', () => {
    expect(parseAutomaticInvite('#key=secret')).toBeNull()
  })
})
