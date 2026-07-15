import { randomBytes } from 'node:crypto'
import { CROCKFORD_ALPHABET, ROOM_CODE_ALPHABET } from '@gathernet/shared'

/** Crockford alphabet has 32 chars — 256/32 divides evenly, no modulo bias. */
export function newCrockfordCode(length: number): string {
  const bytes = randomBytes(length)
  let code = ''
  for (const b of bytes) code += CROCKFORD_ALPHABET[b % 32]
  return code
}

/** 4-char room code from the unambiguous 28-char alphabet (rejection sampling). */
export function newRoomCode(): string {
  let code = ''
  while (code.length < 4) {
    const [b] = randomBytes(1)
    if (b !== undefined && b < 224) code += ROOM_CODE_ALPHABET[b % 28]
  }
  return code
}

export function newHexId(prefix: string, bytes = 8): string {
  return `${prefix}_${randomBytes(bytes).toString('hex')}`
}
