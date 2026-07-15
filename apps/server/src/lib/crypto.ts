import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto'

/** SPKI DER prefix for a raw 32-byte Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export function ed25519Verify(publicKeyRaw: Buffer, message: Buffer, signature: Buffer): boolean {
  if (publicKeyRaw.length !== 32 || signature.length !== 64) return false
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyRaw]),
      format: 'der',
      type: 'spki',
    })
    return verify(null, message, key, signature)
  } catch {
    return false
  }
}

export function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest()
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

const TOKEN_BODY_RE = /^[A-Za-z0-9_-]{43}$/

/**
 * Opaque bearer tokens: `<prefix>.` + base64url(32 random bytes).
 * `gn` = device session, `gna` = app session.
 */
export function newPrefixedToken(prefix: 'gn' | 'gna'): { token: string; tokenHash: Buffer } {
  const secret = randomBytes(32)
  return { token: `${prefix}.${secret.toString('base64url')}`, tokenHash: sha256(secret) }
}

/** Strict: exact prefix, exact base64url body length, round-trip check. */
export function hashPrefixedToken(token: string, prefix: 'gn' | 'gna'): Buffer | null {
  const full = `${prefix}.`
  if (!token.startsWith(full)) return null
  const body = token.slice(full.length)
  if (!TOKEN_BODY_RE.test(body)) return null
  const secret = Buffer.from(body, 'base64url')
  if (secret.length !== 32) return null
  return sha256(secret)
}

export function newSessionToken(): { token: string; tokenHash: Buffer } {
  return newPrefixedToken('gn')
}

export function hashToken(token: string): Buffer | null {
  return hashPrefixedToken(token, 'gn')
}

export function newChallenge(): Buffer {
  return randomBytes(32)
}

/** `utf8(domain) || parts...` — the only signature payload shape in the system. */
export function sigPayload(domain: string, ...parts: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from(domain, 'utf8'), ...parts])
}
