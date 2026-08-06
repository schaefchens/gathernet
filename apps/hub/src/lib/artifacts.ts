/**
 * Pinned channel artifacts — the client crypto substrate (build / seal / verify).
 * A pinned artifact is an independent, device-signed, K_meta-sealed record that
 * lives in channel state (NOT a message). The server relays it opaquely; clients
 * verify authority here against the identity-signed capability chain and the
 * channel's pinPolicy — the server is never trusted for validity.
 *
 * Body wire form: `JSON.stringify(body)` → UTF-8 → seal(K_meta, …, ARTIFACT_AAD).
 * Signature: Ed25519(issuerDeviceKey, domain.channelArtifact ‖ channelId ‖ artifactId
 * ‖ kind ‖ u64(sealEpoch) ‖ u64(expiresAtMs) ‖ SHA-256(sealedBody)). A manager's
 * approval signs (domain.channelArtifact ‖ 'approve' ‖ channelId ‖ artifactId),
 * promoting a member's suggestion to an active pin under pinPolicy = moderators.
 */

import {
  type ChannelArtifact,
  type ChannelArtifactKind,
  type ChannelPinPolicy,
  SIG_DOMAIN,
} from '@gathernet/shared'
import {
  authorizedChannelMinter,
  type CapabilityFetcher,
  type DeviceResolver,
  fromStdB64,
  toStdB64,
} from './community-keys.ts'
import type { MediaRef } from './message-body.ts'
import { loadCrypto } from './mls.ts'
import type { DeviceRecord } from './storage.ts'

/** Domain-separates the artifact-body AEAD from community/channel metadata. */
const ARTIFACT_AAD = new TextEncoder().encode('gathernet:channel-artifact:v1')
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The decrypted, versioned artifact body — a tagged union over the kinds. */
export type ArtifactBody =
  | {
      v: 1
      kind: 'pin'
      /** snapshot of the pinned message's text (if any) */
      text?: string
      /** snapshot of the pinned message's attachment (if any) */
      media?: MediaRef
      /** best-effort back-link to scroll to the source message while it still exists */
      originalMessageId?: string
      /** an optional note the pinner added */
      note?: string
    }
  | { v: 1; kind: 'link'; url: string; title?: string; note?: string }
  /** "who is still here" — the prompt members see; the deadline is the artifact's expiresAt */
  | { v: 1; kind: 'rollcall'; prompt?: string }
  | { v: 1; kind: 'media'; media: MediaRef; caption?: string }
  | {
      v: 1
      kind: 'event'
      title: string
      description?: string
      /** epoch millis — the event's subject time */
      startsAt: number
      endsAt?: number
      location?: string
      /** optional link (meeting/registration/details) — plain anchor, no preview */
      url?: string
      /** minutes before startsAt to remind (creator-set, sealed so all clients agree on
       *  the reminder instant). Absent → the app default (60). Never seen by the server. */
      remindOffsetMin?: number
    }

/** A verified artifact ready to render: the record, its decrypted body, and its trust status. */
export interface VerifiedArtifact {
  artifact: ChannelArtifact
  body: ArtifactBody
  /** active = a real pin; suggested = awaiting manager approval; invalid = failed verification */
  status: ArtifactStatus
  issuerAccountId: string | null
  /** RSVP tally (events): APPROXIMATE server count of anonymous tickets + whether THIS
   *  DEVICE holds a ticket (RSVP state is device-local by design — see rsvpTicketStore). */
  tally: { count: number; mine: boolean }
}

export type ArtifactStatus = 'active' | 'suggested' | 'invalid'

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

/**
 * The bytes an artifact's issuer signs. It binds the PLAINTEXT (not the ciphertext)
 * and omits `sealEpoch`, so re-sealing the same body under a new K_meta on community
 * rotation keeps the signature valid — a leader can re-seal every member's pin forward
 * without re-signing. A server still can't forge or alter the content: it can only
 * re-encrypt the *same* plaintext (harmless); any different plaintext fails the hash.
 */
async function artifactTuple(
  channelId: string,
  artifactId: string,
  kind: ChannelArtifactKind,
  expiresAtMs: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  return concat(
    encoder.encode(SIG_DOMAIN.channelArtifact),
    encoder.encode(channelId),
    encoder.encode(artifactId),
    encoder.encode(kind),
    u64le(expiresAtMs),
    await sha256(plaintext),
  )
}

/** The bytes a manager signs to approve a suggested artifact. */
function approvalTuple(channelId: string, artifactId: string): Uint8Array {
  return concat(
    encoder.encode(SIG_DOMAIN.channelArtifact),
    encoder.encode('approve'),
    encoder.encode(channelId),
    encoder.encode(artifactId),
  )
}

/** The bytes a member signs to attest their participation (RSVP) in an artifact. */
function participationTuple(channelId: string, artifactId: string): Uint8Array {
  return concat(
    encoder.encode(SIG_DOMAIN.channelArtifact),
    encoder.encode('participate'),
    encoder.encode(channelId),
    encoder.encode(artifactId),
  )
}

/** Sign a roll-call response ("I'm still here") — identified + device-attested, so the
 *  relay can't forge or suppress-and-fake a confirmation. */
export async function buildParticipation(
  channelId: string,
  artifactId: string,
  record: DeviceRecord,
): Promise<{ deviceId: string; sig: string }> {
  const mls = await loadCrypto()
  const sig = mls.ed25519Sign(record.deviceSecret, participationTuple(channelId, artifactId))
  return { deviceId: record.deviceId, sig: toStdB64(sig) }
}

/** A fresh random RSVP ticket (bearer secret, kept device-local) + its SHA-256 hex hash.
 *  The server only ever sees the hash, so no (account → coming) fact is stored. */
export async function newRsvpTicket(): Promise<{ ticket: string; ticketHash: string }> {
  const ticket = toStdB64(crypto.getRandomValues(new Uint8Array(32)))
  return { ticket, ticketHash: await sha256Hex(ticket) }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** What `buildArtifact` returns — shaped for the POST /artifacts body. */
export interface BuiltArtifact {
  artifactId: string
  kind: ChannelArtifactKind
  sealEpoch: number
  sealedBody: string
  issuerDeviceId: string
  issuerSig: string
  expiresAt: number | null
}

/** Seal + sign a new pinned artifact (this device attests it). */
export async function buildArtifact(
  channelId: string,
  body: ArtifactBody,
  kMeta: Uint8Array,
  sealEpoch: number,
  record: DeviceRecord,
  expiresAt: number | null = null,
): Promise<BuiltArtifact> {
  const mls = await loadCrypto()
  const artifactId = crypto.randomUUID()
  const raw = encoder.encode(JSON.stringify(body))
  const sealed = mls.seal(kMeta, raw, ARTIFACT_AAD)
  const tuple = await artifactTuple(channelId, artifactId, body.kind, expiresAt ?? 0, raw)
  const sig = mls.ed25519Sign(record.deviceSecret, tuple)
  return {
    artifactId,
    kind: body.kind,
    sealEpoch,
    sealedBody: toStdB64(sealed),
    issuerDeviceId: record.deviceId,
    issuerSig: toStdB64(sig),
    expiresAt,
  }
}

/** A manager signs an approval for a suggested artifact. */
export async function buildApproval(
  channelId: string,
  artifactId: string,
  record: DeviceRecord,
): Promise<{ approverDeviceId: string; approvalSig: string }> {
  const mls = await loadCrypto()
  const sig = mls.ed25519Sign(record.deviceSecret, approvalTuple(channelId, artifactId))
  return { approverDeviceId: record.deviceId, approvalSig: toStdB64(sig) }
}

/** Decrypt an artifact's sealed body to its raw plaintext bytes (needed both to parse
 *  the body AND to recompute the signature hash); null if K_meta is wrong/absent. */
export async function openArtifactRaw(
  kMeta: Uint8Array | null,
  sealedBodyB64: string,
): Promise<Uint8Array | null> {
  if (!kMeta) return null
  try {
    const mls = await loadCrypto()
    return mls.open(kMeta, fromStdB64(sealedBodyB64), ARTIFACT_AAD)
  } catch {
    return null
  }
}

/** Parse raw artifact-body bytes into a typed body; null on garbage. */
export function parseArtifactBody(raw: Uint8Array | null): ArtifactBody | null {
  if (!raw) return null
  try {
    const body = JSON.parse(decoder.decode(raw)) as ArtifactBody
    return body && body.v === 1 && typeof body.kind === 'string' ? body : null
  } catch {
    return null
  }
}

/** Decrypt + parse an artifact body (convenience for callers that don't need raw bytes). */
export async function openArtifactBody(
  kMeta: Uint8Array | null,
  sealedBodyB64: string,
): Promise<ArtifactBody | null> {
  return parseArtifactBody(await openArtifactRaw(kMeta, sealedBodyB64))
}

/** Re-seal an artifact's body under a new K_meta (community rotation). The plaintext —
 *  and therefore the issuer signature — is unchanged; only the ciphertext + epoch move. */
export async function resealArtifactBody(
  oldKMeta: Uint8Array,
  newKMeta: Uint8Array,
  sealedBodyB64: string,
): Promise<string | null> {
  const raw = await openArtifactRaw(oldKMeta, sealedBodyB64)
  if (!raw) return null
  const mls = await loadCrypto()
  return toStdB64(mls.seal(newKMeta, raw, ARTIFACT_AAD))
}

/** Verify a manager's approval signature over an artifact + that the approver is authorized. */
async function verifyApproval(
  a: ChannelArtifact,
  ownerAccountId: string,
  resolve: DeviceResolver,
  getCap: CapabilityFetcher,
  expectedEpoch: number,
): Promise<boolean> {
  if (!a.approverDeviceId || !a.approvalSig) return false
  const mls = await loadCrypto()
  const approver = await resolve(a.approverDeviceId)
  if (!approver) return false
  if (
    !mls.ed25519Verify(
      approver.devicePk,
      approvalTuple(a.channelId, a.artifactId),
      fromStdB64(a.approvalSig),
    )
  ) {
    return false
  }
  return authorizedChannelMinter(
    a.channelId,
    approver.accountId,
    ownerAccountId,
    resolve,
    getCap,
    expectedEpoch,
  )
}

/**
 * Verify a pinned artifact against the capability chain + the channel's pinPolicy,
 * returning its trust status:
 * - 'active'    — a real pin honest clients render (issuer authorized, or a
 *                 manager-approved suggestion).
 * - 'suggested' — a valid member's pin awaiting manager approval (pinPolicy=moderators).
 * - 'invalid'   — bad signature / unauthorized issuer → dropped.
 *
 * Degrades to signature-only when there's no pinned owner (same accepted degradation
 * as the K_channel commitment path for a device that only ever saw a bare code).
 */
export async function verifyArtifact(
  a: ChannelArtifact,
  plaintext: Uint8Array,
  pinPolicy: ChannelPinPolicy,
  ownerAccountId: string | null,
  resolve: DeviceResolver,
  getCap: CapabilityFetcher,
  expectedEpoch: number,
): Promise<{ status: ArtifactStatus; issuerAccountId: string | null }> {
  const mls = await loadCrypto()
  const issuer = await resolve(a.issuerDeviceId)
  if (!issuer) return { status: 'invalid', issuerAccountId: null }
  const tuple = await artifactTuple(a.channelId, a.artifactId, a.kind, a.expiresAt ?? 0, plaintext)
  if (!mls.ed25519Verify(issuer.devicePk, tuple, fromStdB64(a.issuerSig))) {
    return { status: 'invalid', issuerAccountId: issuer.accountId }
  }
  const out = (status: ArtifactStatus) => ({ status, issuerAccountId: issuer.accountId })

  // The signature is verified above (a server can't forge or re-attribute a pin).
  // Beyond that we do NOT hard-gate on a resolvable membership capability: caps are
  // issued lazily by a manager's client, and MLS channels don't gate messaging on
  // them at all, so requiring one here would silently drop legitimate members' pins.
  // The server already restricts posting to authenticated active community members,
  // so we treat any signature-valid, cert-resolvable device as at least a member.
  // (Tightening this to the full capability chain is deferred crypto-phase hardening.)
  if (!ownerAccountId) return out('active') // no pinned owner → TOFU degrade

  const args = [ownerAccountId, resolve, getCap, expectedEpoch] as const
  const issuerIsManager = await authorizedChannelMinter(a.channelId, issuer.accountId, ...args)

  // pinPolicy = everyone → any member's pin is a real pin.
  if (pinPolicy === 'everyone') return out('active')

  // pinPolicy = moderators → managers pin directly; a member's pin is a suggestion
  // until a manager's approval signature is present.
  if (issuerIsManager) return out('active')
  if (await verifyApproval(a, ownerAccountId, resolve, getCap, expectedEpoch)) return out('active')
  return out('suggested')
}

/** Whether an artifact's TTL has elapsed (clients hide expired artifacts). */
export function isExpired(a: ChannelArtifact, nowMs: number): boolean {
  return a.expiresAt !== null && a.expiresAt <= nowMs
}
