import { CROCKFORD_ALPHABET } from './constants.ts'

/**
 * Minimal ULID: 48-bit timestamp + 80 random bits, crockford base32.
 * Dependency-free; works in browsers and Node >= 20.
 */
export function ulid(now: number = Date.now()): string {
  let ts = ''
  let t = now
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD_ALPHABET[t % 32] + ts
    t = Math.floor(t / 32)
  }
  const rand = new Uint8Array(16)
  crypto.getRandomValues(rand)
  let rs = ''
  for (let i = 0; i < 16; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index is always in [0, 32)
    rs += CROCKFORD_ALPHABET[rand[i]! % 32]!
  }
  return ts + rs
}
