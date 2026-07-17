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

import {
  base58Encode,
  type CommunityDevice,
  type CommunityDevicesResponse,
  eciesOpen,
  eciesSeal,
  importEciesPrivateKey,
  type MyKeyGrantResponse,
  SIG_DOMAIN,
} from '@gathernet/shared'
import { api } from './api.ts'
import { loadCrypto } from './mls.ts'
import { type DeviceRecord, secureStore } from './storage.ts'

/** Domain-separates the metadata AEAD from every other seal() use. */
const META_AAD = new TextEncoder().encode('gathernet:community-meta:v1')
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** In-memory K_meta cache (communityId → key), cleared on session reset. */
const cache = new Map<string, Uint8Array>()

/** Subscribers notified when a K_meta becomes available (so views re-decrypt). */
const kMetaListeners = new Set<() => void>()

/** Subscribe to K_meta availability changes; returns an unsubscribe fn. */
export function onKMetaChange(listener: () => void): () => void {
  kMetaListeners.add(listener)
  return () => kMetaListeners.delete(listener)
}

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
  for (const listener of kMetaListeners) listener()
}

export async function getKMeta(communityId: string): Promise<Uint8Array | null> {
  const cached = cache.get(communityId)
  if (cached) return cached
  const stored = await secureStore.getCommunityKey(communityId)
  if (stored) cache.set(communityId, stored)
  return stored
}

/** Clear the in-memory caches (session reset / lock). */
export function forgetKMetaCache(): void {
  cache.clear()
  grantedTo.clear()
}

/* --------------------------------- seal/open ------------------------------ */

/** Seal display metadata → base64 ciphertext for the API's `metaCiphertext`. */
export async function sealMeta(
  kMeta: Uint8Array,
  meta: CommunityMeta | ChannelMeta,
): Promise<string> {
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

/* ---------------------- cross-device K_meta grants ------------------------ */

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/** communityId:deviceId pairs we've already sealed a grant to this session. */
const grantedTo = new Set<string>()

/**
 * Authenticate a peer device's receipt key WITHOUT trusting the server: the
 * DeviceCert must be signed by the claimed account identity (accountId = base58
 * identity pk), and `receiptPk` must be signed by the cert's device key. Returns
 * the verified receipt SPKI (base64) or null.
 */
async function verifyPeerReceiptKey(d: CommunityDevice): Promise<string | null> {
  try {
    const mls = await loadCrypto()
    const cert = fromStdB64(d.deviceCert)
    const { accountPk, devicePk } = mls.decodeDeviceCert(cert)
    if (base58Encode(accountPk) !== d.accountId) return null
    const certOk = mls.ed25519Verify(
      accountPk,
      concat(encoder.encode(SIG_DOMAIN.deviceCert), cert),
      fromStdB64(d.certSig),
    )
    if (!certOk) return null
    const receiptOk = mls.ed25519Verify(
      devicePk,
      concat(encoder.encode(SIG_DOMAIN.receiptKey), fromStdB64(d.receiptPk)),
      fromStdB64(d.receiptPkSig),
    )
    return receiptOk ? d.receiptPk : null
  } catch {
    return null
  }
}

/** Seal our held K_meta to every other active-member device that lacks a grant. */
async function grantToOthers(communityId: string, myDeviceId: string, kMeta: Uint8Array) {
  const { keyEpoch, devices } = await api<CommunityDevicesResponse>(
    'GET',
    `/api/v1/communities/${communityId}/devices`,
  )
  const grants: { granteeDeviceId: string; sealedKMeta: string; senderPkB64: string }[] = []
  for (const d of devices) {
    if (d.deviceId === myDeviceId) continue
    if (grantedTo.has(`${communityId}:${d.deviceId}`)) continue
    const receiptPk = await verifyPeerReceiptKey(d)
    if (!receiptPk) continue
    const sealed = await eciesSeal(receiptPk, kMeta)
    grants.push({
      granteeDeviceId: d.deviceId,
      sealedKMeta: sealed.sealedB64,
      senderPkB64: sealed.senderPkB64,
    })
  }
  if (grants.length === 0) return
  try {
    await api('POST', `/api/v1/communities/${communityId}/key-grants`, { keyEpoch, grants })
    for (const g of grants) grantedTo.add(`${communityId}:${g.granteeDeviceId}`)
  } catch {
    // epoch race / offline — a later sync retries
  }
}

/**
 * FETCH-ONLY: if this device lacks K_meta, try to open a grant sealed to its
 * receipt key. Never seals to others, so it can't cascade — safe to call from
 * WS-event handlers and list views. Returns true iff K_meta was newly obtained.
 */
export async function fetchKMetaGrant(communityId: string, record: DeviceRecord): Promise<boolean> {
  if (await getKMeta(communityId)) return false
  if (!record.receiptPk || !record.receiptPrivPkcs8) return false
  try {
    const res = await api<MyKeyGrantResponse>(
      'GET',
      `/api/v1/communities/${communityId}/key-grants/mine`,
    )
    if (!res.grant) return false
    const priv = await importEciesPrivateKey(toStdB64(record.receiptPrivPkcs8))
    const opened = await eciesOpen(
      priv,
      res.grant.senderPkB64,
      res.grant.sealedKMeta,
      record.receiptPk,
    )
    await rememberKMeta(communityId, opened)
    return true
  } catch {
    return false // no grant yet / offline
  }
}

/**
 * Full sync for one community, driven by an explicit community open (bounded).
 * Fetches this device's grant if it lacks K_meta; if it then holds K_meta,
 * seals it to member devices that don't have it yet. Returns true iff K_meta
 * was newly obtained. `grantToOthers` is the only path that issues grants, and
 * it's rate-friendly: the `grantedTo` cache means no re-seals, and it runs only
 * on navigation — never from WS events (which are fetch-only).
 */
export async function syncKeyGrants(communityId: string, record: DeviceRecord): Promise<boolean> {
  const obtained = await fetchKMetaGrant(communityId, record)
  const kMeta = await getKMeta(communityId)
  if (kMeta) await grantToOthers(communityId, record.deviceId, kMeta).catch(() => {})
  return obtained
}
