/**
 * K_meta — the per-community metadata key. Community + channel *display*
 * metadata (name/title/emoji/markdown description) and avatars are sealed under
 * this 32-byte key with XChaCha20-Poly1305; the server only ever stores/serves
 * the ciphertext. K_meta is generated when a community is created and travels
 * out-of-band in the invite payload's URL fragment
 * (`gathernet:community:<code>#<k_meta_b64url>`) — so the `#` fragment never
 * reaches the server, which sees only `<code>`. Each device keeps its copy
 * sealed under the DMK via `secureStore`, keyed by communityId.
 *
 * Documented limitation (see the M2 architecture memory + ADR): K_meta is not
 * rotated on member removal, and a device that only ever saw a bare code (manual
 * entry, no fragment) has no K_meta and renders metadata as placeholders until
 * it obtains K_meta from another device or a fresh invite link. Channel
 * *messages* keep true MLS forward secrecy regardless.
 */

import { loadCrypto } from './mls.ts'
import { secureStore } from './storage.ts'

/** Domain-separates the metadata AEAD from every other seal() use. */
const META_AAD = new TextEncoder().encode('gathernet:community-meta:v1')
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** In-memory K_meta cache (communityId → key), cleared on session reset. */
const cache = new Map<string, Uint8Array>()

export const COMMUNITY_INVITE_SCHEME = 'gathernet:community:'

export interface CommunityMeta {
  name: string
  description?: string
}

export interface ChannelMeta {
  title: string
  emoji?: string
  description?: string
}

export function generateKMeta(): Uint8Array {
  const key = new Uint8Array(32)
  crypto.getRandomValues(key)
  return key
}

/* ------------------------------- base64(url) ------------------------------ */

function toStdB64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromStdB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

function toB64Url(bytes: Uint8Array): string {
  return toStdB64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function fromB64Url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return fromStdB64(s.replaceAll('-', '+').replaceAll('_', '/') + pad)
}

/* --------------------------------- invites -------------------------------- */

/** Build the shareable invite payload carrying K_meta in the fragment. */
export function buildInvitePayload(code: string, kMeta: Uint8Array): string {
  return `${COMMUNITY_INVITE_SCHEME}${code}#${toB64Url(kMeta)}`
}

/**
 * Parse a scanned/pasted/typed invite. Accepts a bare code, a
 * `gathernet:community:<code>` string, or the full `…<code>#<k_meta>` payload.
 * `kMeta` is null when no fragment was present (manual code entry) — the join
 * still succeeds; only metadata decryption is unavailable until K_meta arrives.
 */
export function parseInvite(raw: string): { code: string; kMeta: Uint8Array | null } {
  let s = raw.trim()
  if (s.startsWith(COMMUNITY_INVITE_SCHEME)) s = s.slice(COMMUNITY_INVITE_SCHEME.length)
  const hash = s.indexOf('#')
  if (hash === -1) return { code: normalizeCode(s), kMeta: null }
  const code = normalizeCode(s.slice(0, hash))
  try {
    return { code, kMeta: fromB64Url(s.slice(hash + 1)) }
  } catch {
    return { code, kMeta: null }
  }
}

function normalizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .replaceAll('-', '')
    .replaceAll(' ', '')
    .replaceAll('O', '0')
    .replaceAll('I', '1')
    .replaceAll('L', '1')
}

/* ------------------------------- persistence ------------------------------ */

export async function rememberKMeta(communityId: string, kMeta: Uint8Array): Promise<void> {
  cache.set(communityId, kMeta)
  await secureStore.putCommunityKey(communityId, kMeta)
}

export async function getKMeta(communityId: string): Promise<Uint8Array | null> {
  const cached = cache.get(communityId)
  if (cached) return cached
  const stored = await secureStore.getCommunityKey(communityId)
  if (stored) cache.set(communityId, stored)
  return stored
}

/** Clear the in-memory cache (session reset / lock). */
export function forgetKMetaCache(): void {
  cache.clear()
}

/* --------------------------------- seal/open ------------------------------ */

/** Seal display metadata → base64 ciphertext for the API's `metaCiphertext`. */
export async function sealMeta(kMeta: Uint8Array, meta: CommunityMeta | ChannelMeta): Promise<string> {
  const mls = await loadCrypto()
  return toStdB64(mls.seal(kMeta, encoder.encode(JSON.stringify(meta)), META_AAD))
}

/** Open a base64 `metaCiphertext`; returns null if K_meta is wrong/absent. */
export async function openMeta<T extends CommunityMeta | ChannelMeta>(
  kMeta: Uint8Array | null,
  ciphertextB64: string | null,
): Promise<T | null> {
  if (!kMeta || !ciphertextB64) return null
  try {
    const mls = await loadCrypto()
    return JSON.parse(decoder.decode(mls.open(kMeta, fromStdB64(ciphertextB64), META_AAD))) as T
  } catch {
    return null
  }
}

/** Seal raw avatar bytes for the media upload endpoint (base64 ciphertext). */
export async function sealMedia(kMeta: Uint8Array, bytes: Uint8Array): Promise<string> {
  const mls = await loadCrypto()
  return toStdB64(mls.seal(kMeta, bytes, META_AAD))
}

/** Open avatar ciphertext bytes (raw octet-stream from the media endpoint). */
export async function openMedia(
  kMeta: Uint8Array | null,
  ciphertext: Uint8Array,
): Promise<Uint8Array | null> {
  if (!kMeta) return null
  try {
    const mls = await loadCrypto()
    return mls.open(kMeta, ciphertext, META_AAD)
  } catch {
    return null
  }
}
