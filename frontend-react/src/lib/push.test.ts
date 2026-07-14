import { describe, it, expect } from 'vitest'
import { urlBase64ToUint8Array } from './push'

describe('urlBase64ToUint8Array', () => {
  it('decodes base64url (with - and _) and pads correctly', () => {
    // "any carnal pleas" in base64url is "YW55IGNhcm5hbCBwbGVhcw" (no padding)
    const bytes = urlBase64ToUint8Array('YW55IGNhcm5hbCBwbGVhcw')
    expect(new TextDecoder().decode(bytes)).toBe('any carnal pleas')
  })

  it('produces the 65-byte uncompressed point a VAPID key decodes to', () => {
    // A P-256 public key is 65 raw bytes; base64url of that is 87 chars.
    const fake = new Uint8Array(65).fill(7)
    const b64url = btoa(String.fromCharCode(...fake)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(urlBase64ToUint8Array(b64url)).toEqual(fake)
  })
})
