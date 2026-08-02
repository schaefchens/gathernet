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
  type AccountId,
  base58Encode,
  type CapabilityRole,
  type CommunityDetailResponse,
  type CommunityDevice,
  type CommunityDevicesResponse,
  type CommunityId,
  type CommunityRoot,
  type DeviceId,
  eciesOpen,
  eciesSeal,
  importEciesPrivateKey,
  type KeyCommitment,
  type MembershipCapability,
  type MyKeyGrantResponse,
  SIG_DOMAIN,
} from '@gathernet/shared'
import { ApiError, api, apiBytes } from './api.ts'
import { loadCrypto } from './mls.ts'
import { type DeviceRecord, secureStore } from './storage.ts'

/** Domain-separates the metadata AEAD from every other seal() use. */
const META_AAD = new TextEncoder().encode('gathernet:community-meta:v1')
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** In-memory K_meta cache (communityId → {key, epoch}), cleared on session reset. */
const cache = new Map<string, { key: Uint8Array; epoch: number }>()

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

export function toStdB64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function fromStdB64(s: string): Uint8Array {
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

/**
 * Build the shareable invite payload carrying K_meta + its epoch in the
 * fragment: `gathernet:community:<code>#<epoch>.<k_meta_b64url>`. The epoch lets
 * a joiner store the key at the right generation, so a later rotation is
 * detected (stale → fetch a fresh grant) rather than the key being trusted
 * blindly.
 */
export function buildInvitePayload(
  code: string,
  kMeta: Uint8Array,
  epoch: number,
  ownerAccountId?: string,
): string {
  // Fragment: <epoch>.<kMeta_b64url>[.<ownerAccountId>] — the owner accountId is
  // the capability-chain anchor the joiner pins out-of-band (base58, no dots).
  const frag = `${epoch}.${toB64Url(kMeta)}${ownerAccountId ? `.${ownerAccountId}` : ''}`
  return `${COMMUNITY_INVITE_SCHEME}${code}#${frag}`
}

/**
 * Parse a scanned/pasted/typed invite. Accepts a bare code, a
 * `gathernet:community:<code>` string, or the full `…<code>#<epoch>.<k_meta>`
 * payload. `kMeta` is null when no fragment was present (manual code entry) —
 * the join still succeeds; metadata decryption waits for a grant. `epoch`
 * defaults to 0 for legacy fragments that carried only the key.
 */
export function parseInvite(raw: string): {
  code: string
  kMeta: Uint8Array | null
  epoch: number
  ownerAccountId: string | null
} {
  let s = raw.trim()
  if (s.startsWith(COMMUNITY_INVITE_SCHEME)) s = s.slice(COMMUNITY_INVITE_SCHEME.length)
  const hash = s.indexOf('#')
  if (hash === -1) return { code: normalizeCode(s), kMeta: null, epoch: 0, ownerAccountId: null }
  const code = normalizeCode(s.slice(0, hash))
  const parts = s.slice(hash + 1).split('.')
  // <epoch>.<kMeta>[.<owner>], or a legacy single-part fragment = bare kMeta (epoch 0).
  const [epochStr, keyStr, ownerAccountId] =
    parts.length === 1
      ? ['0', parts[0] ?? '', null]
      : [parts[0] ?? '0', parts[1] ?? '', parts[2] ?? null]
  try {
    const epoch = Number.parseInt(epochStr, 10)
    return {
      code,
      kMeta: keyStr ? fromB64Url(keyStr) : null,
      epoch: Number.isFinite(epoch) ? epoch : 0,
      ownerAccountId: ownerAccountId ?? null,
    }
  } catch {
    return { code, kMeta: null, epoch: 0, ownerAccountId: null }
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

/** Persist a K_meta for a community at a given epoch (a newer epoch wins). */
export async function rememberKMeta(
  communityId: string,
  kMeta: Uint8Array,
  epoch: number,
): Promise<void> {
  const existing = cache.get(communityId)
  if (existing && existing.epoch > epoch) return // never regress to an older key
  cache.set(communityId, { key: kMeta, epoch })
  await secureStore.putCommunityKey(communityId, kMeta, epoch)
  for (const listener of kMetaListeners) listener()
}

async function loadEntry(communityId: string): Promise<{ key: Uint8Array; epoch: number } | null> {
  const cached = cache.get(communityId)
  if (cached) return cached
  const stored = await secureStore.getCommunityKey(communityId)
  if (stored) cache.set(communityId, stored)
  return stored
}

export async function getKMeta(communityId: string): Promise<Uint8Array | null> {
  return (await loadEntry(communityId))?.key ?? null
}

/** The epoch of the locally-held K_meta, or -1 if none. */
export async function getKMetaEpoch(communityId: string): Promise<number> {
  return (await loadEntry(communityId))?.epoch ?? -1
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

function u64le(n: number): Uint8Array {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true)
  return b
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data)))
}

/* ----------------------- authenticated K_meta epoch commitment ------------ */

/** SHA-256(communityId ‖ u64(epoch) ‖ K_meta) — binds a key to its community+epoch. */
async function computeKMetaCommitment(
  communityId: string,
  epoch: number,
  kMeta: Uint8Array,
): Promise<Uint8Array> {
  return sha256(concat(encoder.encode(communityId), u64le(epoch), kMeta))
}

/** The authenticated epoch commitment a leader publishes alongside its K_meta grants. */
async function buildKMetaCommitment(
  communityId: string,
  epoch: number,
  kMeta: Uint8Array,
  record: DeviceRecord,
): Promise<KeyCommitment> {
  const mls = await loadCrypto()
  const commitment = await computeKMetaCommitment(communityId, epoch, kMeta)
  const sig = mls.ed25519Sign(
    record.deviceSecret,
    concat(
      encoder.encode(SIG_DOMAIN.communityKeyCommit),
      encoder.encode(communityId),
      u64le(epoch),
      commitment,
    ),
  )
  return {
    keyCommitment: toStdB64(commitment),
    minterDeviceId: record.deviceId as DeviceId,
    minterSig: toStdB64(sig),
  }
}

/**
 * Verify a fetched K_meta against its epoch commitment: the opened key must hash
 * to the published commitment, and the commitment must be signed by the minter's
 * device bound to THIS community+epoch — so a compromised relay can't feed one
 * community's (key, commitment) blob as another's. The minter's cert is resolved
 * from the member-device list and authenticated under its account identity.
 */
async function verifyKMetaCommitment(
  communityId: string,
  epoch: number,
  kMeta: Uint8Array,
  commitment: KeyCommitment,
): Promise<boolean> {
  const expect = await computeKMetaCommitment(communityId, epoch, kMeta)
  if (toStdB64(expect) !== commitment.keyCommitment) return false
  try {
    const { devices } = await api<CommunityDevicesResponse>(
      'GET',
      `/api/v1/communities/${communityId}/devices`,
    )
    const minter = devices.find((d) => d.deviceId === commitment.minterDeviceId)
    if (!minter) return false
    const verified = await verifyDeviceCert(minter)
    if (!verified) return false
    const mls = await loadCrypto()
    return mls.ed25519Verify(
      verified.devicePk,
      concat(
        encoder.encode(SIG_DOMAIN.communityKeyCommit),
        encoder.encode(communityId),
        u64le(epoch),
        fromStdB64(commitment.keyCommitment),
      ),
      fromStdB64(commitment.minterSig),
    )
  } catch {
    return false
  }
}

/* --------------- identity-signed membership/role capabilities ------------- */

/** The COMMUNITY scope literal (channel caps use the channelId as scope). */
export const COMMUNITY_SCOPE = 'community'

function capabilityTuple(
  communityId: string,
  scope: string,
  subjectAccountId: string,
  role: CapabilityRole,
  epoch: number,
): Uint8Array {
  return concat(
    encoder.encode(SIG_DOMAIN.membershipCap),
    encoder.encode(communityId),
    encoder.encode(scope),
    encoder.encode(subjectAccountId),
    encoder.encode(role),
    u64le(epoch),
  )
}

/** Mint a capability: this device (cert-chained to its account) attests the subject's role. */
export async function buildCapability(
  communityId: string,
  scope: string,
  subjectAccountId: string,
  role: CapabilityRole,
  epoch: number,
  record: DeviceRecord,
): Promise<MembershipCapability> {
  const mls = await loadCrypto()
  const sig = mls.ed25519Sign(
    record.deviceSecret,
    capabilityTuple(communityId, scope, subjectAccountId, role, epoch),
  )
  return {
    communityId: communityId as CommunityId,
    scope,
    subjectAccountId: subjectAccountId as AccountId,
    role,
    epoch,
    issuerDeviceId: record.deviceId as DeviceId,
    issuerSig: toStdB64(sig),
  }
}

/** Resolve a capability issuer's device to its authenticated identity, or null. */
export type DeviceResolver = (
  deviceId: string,
) => Promise<{ devicePk: Uint8Array; accountId: string } | null>
/** Fetch an account's own capability at a scope (current epoch), for authority chaining. */
export type CapabilityFetcher = (
  scope: string,
  accountId: string,
) => Promise<MembershipCapability | null>

/**
 * Verify a membership capability against the pinned community owner (server never
 * trusted). Checks the issuer's Ed25519 signature (device cert-chained to its
 * account via `resolveDevice`), then that the issuer is AUTHORISED to mint this
 * (role, scope): the owner may mint anything; a community leader may mint community
 * members + channel members/moderators; a channel moderator may mint members of its
 * own channel. Authority is proven by recursively verifying the issuer's own
 * same-epoch capability. Depth-bounded (member → leader/mod → owner).
 */
export async function verifyCapability(
  cap: MembershipCapability,
  ownerAccountId: string,
  resolveDevice: DeviceResolver,
  getCap: CapabilityFetcher,
  depth = 0,
): Promise<boolean> {
  if (depth > 3) return false
  const mls = await loadCrypto()
  const issuer = await resolveDevice(cap.issuerDeviceId)
  if (!issuer) return false
  const tuple = capabilityTuple(
    cap.communityId,
    cap.scope,
    cap.subjectAccountId,
    cap.role,
    cap.epoch,
  )
  if (!mls.ed25519Verify(issuer.devicePk, tuple, fromStdB64(cap.issuerSig))) return false

  // The owner (pinned out-of-band) is the root — may issue any capability.
  if (issuer.accountId === ownerAccountId) return true

  // A non-owner issuer needs its own authorising same-epoch capability.
  const holds = async (scope: string, role: CapabilityRole): Promise<boolean> => {
    const c = await getCap(scope, issuer.accountId)
    if (
      !c ||
      c.role !== role ||
      c.scope !== scope ||
      c.subjectAccountId !== issuer.accountId ||
      c.communityId !== cap.communityId ||
      c.epoch !== cap.epoch
    ) {
      return false
    }
    return verifyCapability(c, ownerAccountId, resolveDevice, getCap, depth + 1)
  }

  if (cap.scope === COMMUNITY_SCOPE) {
    // owner/leader caps require the owner (handled above); a leader may mint members.
    return cap.role === 'member' && (await holds(COMMUNITY_SCOPE, 'leader'))
  }
  // Channel scope: leaders mint members+moderators; channel moderators mint members.
  if (cap.role === 'member') {
    return (await holds(COMMUNITY_SCOPE, 'leader')) || (await holds(cap.scope, 'moderator'))
  }
  if (cap.role === 'moderator') return holds(COMMUNITY_SCOPE, 'leader')
  return false
}

/** The owner's device signs the community root (capability-chain anchor). */
export async function buildCommunityRoot(
  communityId: string,
  ownerAccountId: string,
  record: DeviceRecord,
): Promise<CommunityRoot> {
  const mls = await loadCrypto()
  const sig = mls.ed25519Sign(
    record.deviceSecret,
    concat(
      encoder.encode(SIG_DOMAIN.communityRoot),
      encoder.encode(communityId),
      encoder.encode(ownerAccountId),
    ),
  )
  return {
    communityId: communityId as CommunityId,
    ownerAccountId: ownerAccountId as AccountId,
    ownerDeviceId: record.deviceId as DeviceId,
    ownerSig: toStdB64(sig),
  }
}

/**
 * Verify a community root: its signer device must belong to `ownerAccountId` (the
 * value pinned from the out-of-band invite) and have signed the ownership tuple.
 * This authenticates that the pinned owner's own device attested ownership — not
 * the server. Returns false if the signer isn't the owner or the sig is bad.
 */
export async function verifyCommunityRoot(
  root: CommunityRoot,
  resolveDevice: DeviceResolver,
): Promise<boolean> {
  const mls = await loadCrypto()
  const signer = await resolveDevice(root.ownerDeviceId)
  if (!signer || signer.accountId !== root.ownerAccountId) return false
  return mls.ed25519Verify(
    signer.devicePk,
    concat(
      encoder.encode(SIG_DOMAIN.communityRoot),
      encoder.encode(root.communityId),
      encoder.encode(root.ownerAccountId),
    ),
    fromStdB64(root.ownerSig),
  )
}

/** TOFU-pin the community owner (first-seen wins), learned out-of-band from the invite. */
export async function pinCommunityOwner(
  communityId: string,
  ownerAccountId: string,
): Promise<void> {
  const existing = await secureStore.getCommunityOwner(communityId)
  if (!existing) await secureStore.putCommunityOwner(communityId, ownerAccountId)
}

export async function getPinnedOwner(communityId: string): Promise<string | null> {
  return secureStore.getCommunityOwner(communityId)
}

/**
 * The owner's first act after creating a community: sign the ownership root, pin
 * itself as owner, and publish the root so joiners can verify the capability chain.
 */
export async function publishCommunityRoot(
  communityId: string,
  record: DeviceRecord,
): Promise<void> {
  const root = await buildCommunityRoot(communityId, record.accountId, record)
  await pinCommunityOwner(communityId, record.accountId)
  try {
    await api('POST', `/api/v1/communities/${communityId}/root`, {
      ownerDeviceId: root.ownerDeviceId,
      ownerSig: root.ownerSig,
    })
  } catch {
    // offline — a later create-sweep retries (Stage 6)
  }
}

/** communityId:deviceId pairs we've already sealed a grant to this session. */
const grantedTo = new Set<string>()

/**
 * Authenticate a peer device's DeviceCert WITHOUT trusting the server: the cert
 * must be signed by the claimed account identity (accountId = base58 identity
 * pk). Returns the cert's device public key + accountId, or null. This is the
 * root of client-side sender authentication — a group_key channel message's
 * Ed25519 signature is verified under the returned `devicePk`.
 */
export async function verifyDeviceCert(
  d: Pick<CommunityDevice, 'accountId' | 'deviceCert' | 'certSig'>,
): Promise<{ devicePk: Uint8Array; accountId: string } | null> {
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
    return certOk ? { devicePk, accountId: d.accountId } : null
  } catch {
    return null
  }
}

/**
 * Authenticate a peer device's receipt key WITHOUT trusting the server: the
 * DeviceCert must be signed by the claimed account identity, and `receiptPk`
 * must be signed by the cert's device key. Returns the verified receipt SPKI
 * (base64) or null.
 */
export async function verifyPeerReceiptKey(d: CommunityDevice): Promise<string | null> {
  const verified = await verifyDeviceCert(d)
  if (!verified) return null
  try {
    const mls = await loadCrypto()
    const receiptOk = mls.ed25519Verify(
      verified.devicePk,
      concat(encoder.encode(SIG_DOMAIN.receiptKey), fromStdB64(d.receiptPk)),
      fromStdB64(d.receiptPkSig),
    )
    return receiptOk ? d.receiptPk : null
  } catch {
    return null
  }
}

/** Verify + seal K_meta to a set of member devices, returning grant entries. */
async function buildGrants(
  devices: CommunityDevice[],
  myDeviceId: string,
  kMeta: Uint8Array,
  skipGranted: ((deviceId: string) => boolean) | null,
): Promise<{ granteeDeviceId: string; sealedKMeta: string; senderPkB64: string }[]> {
  const grants: { granteeDeviceId: string; sealedKMeta: string; senderPkB64: string }[] = []
  for (const d of devices) {
    if (d.deviceId === myDeviceId) continue
    if (skipGranted?.(d.deviceId)) continue
    const receiptPk = await verifyPeerReceiptKey(d)
    if (!receiptPk) continue
    const sealed = await eciesSeal(receiptPk, kMeta)
    grants.push({
      granteeDeviceId: d.deviceId,
      sealedKMeta: sealed.sealedB64,
      senderPkB64: sealed.senderPkB64,
    })
  }
  return grants
}

/** Seal our held K_meta to every other active-member device that lacks a grant. */
async function grantToOthers(communityId: string, record: DeviceRecord): Promise<void> {
  const kMeta = await getKMeta(communityId)
  const localEpoch = await getKMetaEpoch(communityId)
  if (!kMeta) return
  const { keyEpoch, devices } = await api<CommunityDevicesResponse>(
    'GET',
    `/api/v1/communities/${communityId}/devices`,
  )
  // Only grant the CURRENT-epoch key — never seal a stale key to others.
  if (localEpoch !== keyEpoch) return
  const grants = await buildGrants(devices, record.deviceId, kMeta, (id) =>
    grantedTo.has(`${communityId}:${keyEpoch}:${id}`),
  )
  if (grants.length === 0) return
  const commitment = await buildKMetaCommitment(communityId, keyEpoch, kMeta, record)
  try {
    await api('POST', `/api/v1/communities/${communityId}/key-grants`, {
      keyEpoch,
      commitment,
      grants,
    })
    for (const g of grants) grantedTo.add(`${communityId}:${keyEpoch}:${g.granteeDeviceId}`)
  } catch {
    // epoch race / offline — a later sync retries
  }
}

/**
 * FETCH-ONLY: obtain a grant for this device if the server's key epoch is newer
 * than ours (initial fetch, or after a rotation). Never seals to others, so it
 * can't cascade — safe from WS-event handlers and list views. `knownEpoch` (the
 * community's current epoch, if the caller already has it) skips the network
 * round-trip when we're already current. Returns true iff K_meta advanced.
 */
export async function fetchKMetaGrant(
  communityId: string,
  record: DeviceRecord,
  knownEpoch?: number,
): Promise<boolean> {
  if (!record.receiptPk || !record.receiptPrivPkcs8) return false
  const localEpoch = await getKMetaEpoch(communityId)
  if (knownEpoch !== undefined && localEpoch >= knownEpoch) return false
  try {
    const res = await api<MyKeyGrantResponse>(
      'GET',
      `/api/v1/communities/${communityId}/key-grants/mine`,
    )
    if (localEpoch >= res.keyEpoch || !res.grant) return false
    // The commitment is REQUIRED to trust the key — an ECIES seal to a public
    // receipt key gives no authenticity over WHICH key was sealed, so without it
    // a compromised server could substitute one community's grant for another's.
    if (!res.commitment) return false
    const priv = await importEciesPrivateKey(toStdB64(record.receiptPrivPkcs8))
    const opened = await eciesOpen(
      priv,
      res.grant.senderPkB64,
      res.grant.sealedKMeta,
      record.receiptPk,
    )
    if (!(await verifyKMetaCommitment(communityId, res.keyEpoch, opened, res.commitment))) {
      return false
    }
    await rememberKMeta(communityId, opened, res.keyEpoch)
    return true
  } catch {
    return false // no grant yet / offline
  }
}

/**
 * Full sync for one community, driven by an explicit community open (bounded).
 * Fetches this device's grant if its key is stale/missing; if it then holds the
 * current key, seals it to member devices that don't have it yet. `grantToOthers`
 * is the only proactive grant path and runs only on navigation (never from WS
 * events), so it can't cascade.
 */
export async function syncKeyGrants(
  communityId: string,
  record: DeviceRecord,
  knownEpoch?: number,
): Promise<boolean> {
  const obtained = await fetchKMetaGrant(communityId, record, knownEpoch)
  await grantToOthers(communityId, record).catch(() => {})
  return obtained
}

/**
 * K_meta rotation (forward secrecy after a member leaves). A leader's client
 * mints a new key, re-encrypts all metadata + avatars under it, and posts it in
 * one shot; the server applies it with a compare-and-set on the epoch. Returns
 * true iff this client performed the rotation. Safe no-op for non-leaders, when
 * nothing is pending, or when this device doesn't hold the current key.
 */
export async function rotateCommunity(communityId: string, record: DeviceRecord): Promise<boolean> {
  const detail = await api<CommunityDetailResponse>('GET', `/api/v1/communities/${communityId}`)
  if (!detail.community.rotationPending) return false
  if (detail.myRole !== 'owner' && detail.myRole !== 'leader') return false

  const fromEpoch = detail.community.keyEpoch
  const oldKMeta = await getKMeta(communityId)
  if (!oldKMeta || (await getKMetaEpoch(communityId)) !== fromEpoch) {
    // We don't hold the current key — fetch it; a later trigger rotates.
    await fetchKMetaGrant(communityId, record, fromEpoch)
    return false
  }
  const newEpoch = fromEpoch + 1
  const newKMeta = generateKMeta()

  let communityMeta: string | null = null
  if (detail.community.metaCiphertext) {
    const obj = await openMeta<CommunityMeta>(oldKMeta, detail.community.metaCiphertext)
    communityMeta = obj ? await sealMeta(newKMeta, obj) : detail.community.metaCiphertext
  }
  const channels: { channelId: string; metaCiphertext: string | null }[] = []
  for (const ch of detail.channels) {
    if (!ch.metaCiphertext) {
      channels.push({ channelId: ch.channelId, metaCiphertext: null })
      continue
    }
    const obj = await openMeta<ChannelMeta>(oldKMeta, ch.metaCiphertext)
    channels.push({
      channelId: ch.channelId,
      metaCiphertext: obj ? await sealMeta(newKMeta, obj) : ch.metaCiphertext,
    })
  }

  const mediaIds = new Set<string>()
  if (detail.community.avatarMediaId) mediaIds.add(detail.community.avatarMediaId)
  for (const ch of detail.channels) if (ch.avatarMediaId) mediaIds.add(ch.avatarMediaId)
  const media: { mediaId: string; ciphertext: string }[] = []
  for (const mediaId of mediaIds) {
    try {
      const plain = await openMedia(
        oldKMeta,
        await apiBytes(`/api/v1/communities/media/${mediaId}`),
      )
      if (plain) media.push({ mediaId, ciphertext: await sealMedia(newKMeta, plain) })
    } catch {
      // media unreadable — leave it (a stale avatar is cosmetic)
    }
  }

  const { devices } = await api<CommunityDevicesResponse>(
    'GET',
    `/api/v1/communities/${communityId}/devices`,
  )
  const grants = await buildGrants(devices, record.deviceId, newKMeta, null)
  const commitment = await buildKMetaCommitment(communityId, newEpoch, newKMeta, record)

  try {
    await api('POST', `/api/v1/communities/${communityId}/rotate`, {
      fromEpoch,
      commitment,
      community: { metaCiphertext: communityMeta },
      channels,
      media,
      grants,
    })
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      // Another leader rotated first — just pick up the new key.
      await fetchKMetaGrant(communityId, record, newEpoch)
    }
    return false
  }
  await rememberKMeta(communityId, newKMeta, newEpoch)
  for (const g of grants) grantedTo.add(`${communityId}:${newEpoch}:${g.granteeDeviceId}`)
  return true
}
