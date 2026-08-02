/**
 * K_channel — the per-channel content key for group_key channels (large
 * broadcast/discussion channels that MLS cannot scale to). One 32-byte key per
 * channel *epoch*; channel messages are sealed under it with XChaCha20-Poly1305,
 * and every message additionally carries an Ed25519 *sender signature* so a
 * shared content key never lets one member forge a message as another (the
 * authenticity MLS gives intrinsically). K_channel is distributed exactly like
 * K_meta — sealed per-device to an authenticated ECIES receipt key — but minted
 * only by a bounded granter set (channel moderators / community leaders) and
 * NEVER seen by the server.
 *
 * Rotation mints a new epoch; OLD messages stay under their old-epoch key and
 * expire at the channel TTL, so a device keeps a small window of epoch keys.
 *
 * See ADR 0002 (K_meta) for the shared receipt-key trust chain. Complements
 * `community-keys.ts`, whose cert-verification + base64 helpers this reuses.
 */

import {
  type ChannelDevicesResponse,
  type ChannelKeyCommitment,
  type CommunityDevice,
  type CommunityDevicesResponse,
  type DeviceId,
  eciesOpen,
  eciesSeal,
  importEciesPrivateKey,
  type MyChannelKeyGrantResponse,
  SIG_DOMAIN,
} from '@gathernet/shared'
import { ApiError, api } from './api.ts'
import { fromStdB64, toStdB64, verifyDeviceCert, verifyPeerReceiptKey } from './community-keys.ts'
import { loadCrypto } from './mls.ts'
import { channelKeyStore, type DeviceRecord } from './storage.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** AEAD AAD domain for group_key channel messages (binds ct to its context). */
const MSG_AAD_DOMAIN = 'gathernet-channel-msg-aead-v1'

/* -------------------------------- helpers --------------------------------- */

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
  // Copy into a fresh ArrayBuffer-backed view so the DOM BufferSource type is satisfied.
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data)))
}

function toHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/* ---------------------------- key persistence ----------------------------- */

/** In-memory K_channel cache (`channelId:epoch` → key), cleared on session reset. */
const cache = new Map<string, Uint8Array>()
const cacheKey = (channelId: string, epoch: number) => `${channelId}:${epoch}`

/** channelId:epoch:deviceId grants sealed this session (avoid re-sealing). */
const granted = new Set<string>()

export function generateKChannel(): Uint8Array {
  const key = new Uint8Array(32)
  crypto.getRandomValues(key)
  return key
}

export async function rememberKChannel(
  channelId: string,
  epoch: number,
  key: Uint8Array,
): Promise<void> {
  cache.set(cacheKey(channelId, epoch), key)
  await channelKeyStore.put(channelId, epoch, key)
}

export async function getKChannel(channelId: string, epoch: number): Promise<Uint8Array | null> {
  const hit = cache.get(cacheKey(channelId, epoch))
  if (hit) return hit
  const stored = await channelKeyStore.get(channelId, epoch)
  if (stored) cache.set(cacheKey(channelId, epoch), stored)
  return stored
}

/** Clear in-memory caches (session reset / lock). */
export function forgetChannelKeyCache(): void {
  cache.clear()
  granted.clear()
}

/** The newest K_channel epoch this device holds for a channel, or null. */
export async function latestHeldEpoch(channelId: string): Promise<number | null> {
  const epochs = await channelKeyStore.epochs(channelId)
  return epochs.length > 0 ? (epochs[epochs.length - 1] ?? null) : null
}

/**
 * Prune locally-held epoch keys strictly older than `keepFromEpoch`. Old
 * messages under those epochs will already have expired by the channel TTL.
 */
export async function pruneChannelKeys(channelId: string, keepFromEpoch: number): Promise<void> {
  for (const epoch of await channelKeyStore.epochs(channelId)) {
    if (epoch < keepFromEpoch) {
      cache.delete(cacheKey(channelId, epoch))
      await channelKeyStore.delete(channelId, epoch).catch(() => {})
    }
  }
}

/* ------------------------------ commitments ------------------------------- */

/** SHA-256(channelId ‖ u64(epoch) ‖ K_channel) — binds a key to its channel+epoch. */
async function computeKeyCommitment(
  channelId: string,
  epoch: number,
  key: Uint8Array,
): Promise<Uint8Array> {
  return sha256(concat(encoder.encode(channelId), u64le(epoch), key))
}

/** The authenticated epoch commitment a minter publishes alongside its grants. */
async function buildCommitment(
  channelId: string,
  epoch: number,
  key: Uint8Array,
  record: DeviceRecord,
): Promise<ChannelKeyCommitment> {
  const mls = await loadCrypto()
  const commitment = await computeKeyCommitment(channelId, epoch, key)
  const sig = mls.ed25519Sign(
    record.deviceSecret,
    concat(
      encoder.encode(SIG_DOMAIN.channelKeyCommit),
      encoder.encode(channelId),
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
 * Verify a fetched key against its epoch commitment: (1) the opened key must
 * hash to the published commitment (integrity), and (2) the commitment must be
 * signed by the minter's device — bound to THIS channelId+epoch — which defeats
 * a server substituting another channel's (key, commitment) pair. The minter's
 * cert is resolved from the community member-device list (verifiable by any
 * member) and authenticated under its account identity. Whether the minter is an
 * authorised manager is server-asserted (documented trust boundary, ADR 0002).
 */
async function verifyCommitment(
  communityId: string,
  channelId: string,
  epoch: number,
  key: Uint8Array,
  commitment: ChannelKeyCommitment,
): Promise<boolean> {
  const expect = await computeKeyCommitment(channelId, epoch, key)
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
        encoder.encode(SIG_DOMAIN.channelKeyCommit),
        encoder.encode(channelId),
        u64le(epoch),
        fromStdB64(commitment.keyCommitment),
      ),
      fromStdB64(commitment.minterSig),
    )
  } catch {
    return false
  }
}

/* --------------------------- signed message envelope ---------------------- */

/**
 * The opaque payload of a group_key channel message. Binary fields are base64;
 * the whole object is JSON+base64 for transport as the `ciphertext` string.
 * communityId + channelId are NOT transmitted — the receiver supplies them from
 * context when reconstructing the AAD/signature, so a cross-channel replay is
 * rejected (the signature was over the true channel).
 */
interface ChannelEnvelope {
  epoch: number
  senderDeviceId: string
  senderSeq: number
  prevSenderHash: string
  ts: number
  ct: string
  sig: string
}

function messageAad(
  communityId: string,
  channelId: string,
  epoch: number,
  senderDeviceId: string,
  senderSeq: number,
): Uint8Array {
  return concat(
    encoder.encode(MSG_AAD_DOMAIN),
    encoder.encode(communityId),
    encoder.encode(channelId),
    u64le(epoch),
    encoder.encode(senderDeviceId),
    u64le(senderSeq),
  )
}

async function messageTuple(
  communityId: string,
  channelId: string,
  epoch: number,
  senderDeviceId: string,
  senderSeq: number,
  prevSenderHash: Uint8Array,
  ts: number,
  ct: Uint8Array,
): Promise<Uint8Array> {
  return concat(
    encoder.encode(SIG_DOMAIN.channelMsg),
    encoder.encode(communityId),
    encoder.encode(channelId),
    u64le(epoch),
    encoder.encode(senderDeviceId),
    u64le(senderSeq),
    prevSenderHash,
    u64le(ts),
    await sha256(ct),
  )
}

export interface SealedMessage {
  /** base64(JSON envelope) — goes out as chat.send `ciphertext`. */
  ciphertext: string
  /** SHA-256 of this message's signed tuple — the next message's prevSenderHash. */
  nextHash: Uint8Array
}

/** Seal + sign a group_key channel message from this device. */
export async function sealChannelMessage(params: {
  key: Uint8Array
  communityId: string
  channelId: string
  epoch: number
  senderDeviceId: string
  deviceSecret: Uint8Array
  text: string
  ts: number
  senderSeq: number
  prevSenderHash: Uint8Array
}): Promise<SealedMessage> {
  const mls = await loadCrypto()
  const plaintext = encoder.encode(JSON.stringify({ t: params.text, ts: params.ts }))
  const aad = messageAad(
    params.communityId,
    params.channelId,
    params.epoch,
    params.senderDeviceId,
    params.senderSeq,
  )
  const ct = mls.seal(params.key, plaintext, aad)
  const tuple = await messageTuple(
    params.communityId,
    params.channelId,
    params.epoch,
    params.senderDeviceId,
    params.senderSeq,
    params.prevSenderHash,
    params.ts,
    ct,
  )
  const sig = mls.ed25519Sign(params.deviceSecret, tuple)
  const env: ChannelEnvelope = {
    epoch: params.epoch,
    senderDeviceId: params.senderDeviceId,
    senderSeq: params.senderSeq,
    prevSenderHash: toStdB64(params.prevSenderHash),
    ts: params.ts,
    ct: toStdB64(ct),
    sig: toStdB64(sig),
  }
  return { ciphertext: btoa(JSON.stringify(env)), nextHash: await sha256(tuple) }
}

export interface OpenedMessage {
  senderAccountId: string
  senderDeviceId: string
  senderSeq: number
  text: string
  ts: number
}

/**
 * Verify + open a group_key channel message. Returns null (dropped) unless the
 * sender's DeviceCert validates under its account identity, `senderDeviceId`
 * matches SHA-256(devicePk)[:16], the Ed25519 signature verifies under that
 * devicePk, and the AEAD opens under `key`. `resolveSender` maps a claimed
 * senderDeviceId to its verified device key + accountId (never the server's word).
 */
export async function openChannelMessage(params: {
  payloadB64: string
  key: Uint8Array
  communityId: string
  channelId: string
  resolveSender: (deviceId: string) => Promise<{ devicePk: Uint8Array; accountId: string } | null>
}): Promise<OpenedMessage | null> {
  try {
    const env = JSON.parse(atob(params.payloadB64)) as ChannelEnvelope
    const sender = await params.resolveSender(env.senderDeviceId)
    if (!sender) return null
    // Bind the claimed deviceId to the cert's device key (P0-1: never trust the
    // server's sender field).
    const derivedId = toHex((await sha256(sender.devicePk)).subarray(0, 16))
    if (derivedId !== env.senderDeviceId) return null

    const mls = await loadCrypto()
    const ct = fromStdB64(env.ct)
    const tuple = await messageTuple(
      params.communityId,
      params.channelId,
      env.epoch,
      env.senderDeviceId,
      env.senderSeq,
      fromStdB64(env.prevSenderHash),
      env.ts,
      ct,
    )
    if (!mls.ed25519Verify(sender.devicePk, tuple, fromStdB64(env.sig))) return null
    const aad = messageAad(
      params.communityId,
      params.channelId,
      env.epoch,
      env.senderDeviceId,
      env.senderSeq,
    )
    const plain = mls.open(params.key, ct, aad)
    const body = JSON.parse(decoder.decode(plain)) as { t: string; ts: number }
    return {
      senderAccountId: sender.accountId,
      senderDeviceId: env.senderDeviceId,
      senderSeq: env.senderSeq,
      text: body.t,
      ts: body.ts,
    }
  } catch {
    return null
  }
}

/** The K_channel epoch an incoming envelope was sealed under (to pick the key). */
export function envelopeEpoch(payloadB64: string): number | null {
  try {
    return (JSON.parse(atob(payloadB64)) as ChannelEnvelope).epoch
  } catch {
    return null
  }
}

/* ------------------------------- key grants ------------------------------- */

/**
 * FETCH-ONLY: obtain this device's K_channel grant for the channel's current
 * epoch and verify it against the published epoch commitment. Returns true iff a
 * new key was stored. Never seals to others, so it can't cascade.
 */
export async function fetchChannelKeyGrant(
  communityId: string,
  channelId: string,
  record: DeviceRecord,
): Promise<boolean> {
  if (!record.receiptPk || !record.receiptPrivPkcs8) return false
  try {
    const res = await api<MyChannelKeyGrantResponse>(
      'GET',
      `/api/v1/communities/${communityId}/channels/${channelId}/key-grants/mine`,
    )
    if (!res.grant) return false
    if (await getKChannel(channelId, res.keyEpoch)) return false // already held
    // A commitment is REQUIRED to trust the key. An ECIES seal to a *public*
    // receipt key carries no authenticity over WHICH key was sealed — anyone
    // (incl. a compromised server) can seal an arbitrary key to it. Without the
    // authenticated epoch commitment this would be a silent key-substitution
    // hole (the victim would then send under a server-chosen key). A grant is
    // always published together with its commitment, so absence ⇒ untrusted.
    if (!res.commitment) return false
    const priv = await importEciesPrivateKey(toStdB64(record.receiptPrivPkcs8))
    const opened = await eciesOpen(
      priv,
      res.grant.senderPkB64,
      res.grant.sealedKey,
      record.receiptPk,
    )
    // Integrity + anti-partition + anti-substitution (see verifyCommitment).
    if (!(await verifyCommitment(communityId, channelId, res.keyEpoch, opened, res.commitment))) {
      return false
    }
    await rememberKChannel(channelId, res.keyEpoch, opened)
    return true
  } catch {
    return false
  }
}

/**
 * Seal a held K_channel to every active-member device of the channel (a bounded
 * granter set — managers only, server-enforced) and publish the epoch
 * commitment. Pages the device list and posts grants in bounded batches;
 * idempotent per (channel, epoch, device) via the `granted` set.
 */
export async function grantChannelKey(
  communityId: string,
  channelId: string,
  record: DeviceRecord,
  key: Uint8Array,
  epoch: number,
): Promise<void> {
  const commitment = await buildCommitment(channelId, epoch, key, record)
  let commitmentPosted = false
  let after: string | undefined
  // Page the (possibly 100k) device list (server caps a page at DEVICE_PAGE);
  // each page yields ≤DEVICE_PAGE grants, well under CHANNEL_KEY_GRANT_BATCH_MAX.
  const DEVICE_PAGE = 500
  do {
    const query = `limit=${DEVICE_PAGE}${after ? `&after=${encodeURIComponent(after)}` : ''}`
    let page: ChannelDevicesResponse
    try {
      page = await api<ChannelDevicesResponse>(
        'GET',
        `/api/v1/communities/${communityId}/channels/${channelId}/devices?${query}`,
      )
    } catch {
      return // offline / not a manager — a later sync retries
    }
    const grants = await buildChannelGrants(page.devices, key, (id) =>
      granted.has(`${channelId}:${epoch}:${id}`),
    )
    if (grants.length > 0) {
      try {
        await api('POST', `/api/v1/communities/${communityId}/channels/${channelId}/key-grants`, {
          keyEpoch: epoch,
          ...(commitmentPosted ? {} : { commitment }),
          grants,
        })
        commitmentPosted = true
        for (const g of grants) granted.add(`${channelId}:${epoch}:${g.granteeDeviceId}`)
      } catch {
        return // epoch race / offline — retry later
      }
    }
    // Guard against a buggy/malicious server returning a non-advancing cursor
    // (which would spin this loop hammering the endpoint indefinitely).
    const next = page.nextCursor ?? undefined
    if (next !== undefined && next === after) return
    after = next
  } while (after)
}

/** Verify + seal K_channel to member devices (incl. our own other devices). */
async function buildChannelGrants(
  devices: CommunityDevice[],
  key: Uint8Array,
  skip: (deviceId: string) => boolean,
): Promise<{ granteeDeviceId: string; sealedKey: string; senderPkB64: string }[]> {
  const grants: { granteeDeviceId: string; sealedKey: string; senderPkB64: string }[] = []
  for (const d of devices) {
    if (skip(d.deviceId)) continue
    const receiptPk = await verifyPeerReceiptKey(d)
    if (!receiptPk) continue
    const sealed = await eciesSeal(receiptPk, key)
    grants.push({
      granteeDeviceId: d.deviceId,
      sealedKey: sealed.sealedB64,
      senderPkB64: sealed.senderPkB64,
    })
  }
  return grants
}

/**
 * Establish a brand-new group_key channel's epoch-0 key: generate K_channel,
 * store it locally, publish the commitment, and seal it to every current member
 * device (including our own, so a restored device can recover it). The creator's
 * first act after the channel row exists (the group_key counterpart to
 * bootstrapping an MLS channel's GroupInfo).
 */
export async function bootstrapGroupKeyChannel(
  communityId: string,
  channelId: string,
  record: DeviceRecord,
): Promise<void> {
  const key = generateKChannel()
  await rememberKChannel(channelId, 0, key)
  await grantChannelKey(communityId, channelId, record, key, 0)
}

/**
 * Rotate a group_key channel to a fresh K_channel epoch (a member was
 * removed/left, flagged `rotationPending`; or a periodic PCS refresh). Mints a
 * new key, establishes the new epoch server-side with a compare-and-set (an
 * initial self-grant + signed commitment), then re-grants the remaining member
 * devices. Old-epoch keys are kept locally so un-expired history stays readable.
 * Returns true iff this client performed the rotation. Manager-only (server-
 * enforced); a non-manager's POST 403s and this returns false.
 */
export async function rotateChannelKey(
  communityId: string,
  channelId: string,
  record: DeviceRecord,
  fromEpoch: number,
): Promise<boolean> {
  if (!record.receiptPk) return false // can't self-grant without a receipt key
  const newEpoch = fromEpoch + 1
  const key = generateKChannel()
  const commitment = await buildCommitment(channelId, newEpoch, key, record)
  const selfSeal = await eciesSeal(record.receiptPk, key)
  try {
    await api('POST', `/api/v1/communities/${communityId}/channels/${channelId}/rotate`, {
      fromEpoch,
      commitment,
      grants: [
        {
          granteeDeviceId: record.deviceId,
          sealedKey: selfSeal.sealedB64,
          senderPkB64: selfSeal.senderPkB64,
        },
      ],
    })
  } catch (err) {
    // Another manager rotated first — adopt their new key.
    if (err instanceof ApiError && err.status === 409) {
      await fetchChannelKeyGrant(communityId, channelId, record).catch(() => {})
    }
    return false
  }
  await rememberKChannel(channelId, newEpoch, key)
  granted.add(`${channelId}:${newEpoch}:${record.deviceId}`)
  // Top up the remaining member devices at the new epoch.
  await grantChannelKey(communityId, channelId, record, key, newEpoch)
  return true
}

/**
 * Verify a claimed sender device's cert (under its account identity) → its
 * device public key. Used by the receiver to authenticate a message's sender
 * without trusting the server. Reuses the K_meta cert-chain verifier.
 */
export async function verifyChannelSender(
  d: Pick<CommunityDevice, 'accountId' | 'deviceCert' | 'certSig'>,
): Promise<{ devicePk: Uint8Array; accountId: string } | null> {
  return verifyDeviceCert(d)
}
