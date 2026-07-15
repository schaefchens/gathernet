import { describe, expect, it } from 'vitest'
import { b64, bytesToHex, fromB64, hexToBytes } from '../src/index.ts'

describe('codec', () => {
  it('round-trips hex', () => {
    const bytes = Uint8Array.from([0, 1, 15, 16, 127, 128, 255])
    expect(bytesToHex(bytes)).toBe('00010f107f80ff')
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes)
  })

  it('round-trips base64', () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 37) % 256)
    expect(fromB64(b64(bytes))).toEqual(bytes)
  })

  it('handles empty inputs', () => {
    expect(bytesToHex(new Uint8Array())).toBe('')
    expect(hexToBytes('')).toEqual(new Uint8Array())
    expect(b64(new Uint8Array())).toBe('')
    expect(fromB64('')).toEqual(new Uint8Array())
  })
})
