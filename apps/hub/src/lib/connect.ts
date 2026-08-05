/**
 * Directed connect requests — client crypto (seal / sign / open / verify). The intro
 * message is sealed (ECIES) to each of the target's device receipt keys and signed by the
 * requester's device, so only the target can read it and a compromised relay can't
 * fabricate an intro purporting to come from the requester. Mirrors lib/reports.ts.
 *
 * Signature: Ed25519(requesterDeviceKey, SIG_DOMAIN.friendConnect ‖ fromAccountId ‖
 * toAccountId ‖ SHA-256(plaintext)).
 */

import {
  type CommunityDevice,
  eciesOpen,
  eciesSeal,
  type IncomingConnectRequest,
  importEciesPrivateKey,
  SIG_DOMAIN,
} from '@gathernet/shared'
import { fromStdB64, toStdB64, verifyDeviceCert, verifyPeerReceiptKey } from './community-keys.ts'
import { loadCrypto } from './mls.ts'
import type { DeviceRecord } from './storage.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

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

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data)))
}

/** The decrypted intro — sealed to the target, never seen by the server. */
export interface ConnectBody {
  v: 1
  message: string
}

async function connectTuple(
  fromAccountId: string,
  toAccountId: string,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  return concat(
    encoder.encode(SIG_DOMAIN.friendConnect),
    encoder.encode(fromAccountId),
    encoder.encode(toAccountId),
    await sha256(plaintext),
  )
}

export interface BuiltConnectRequest {
  requesterDeviceId: string
  requesterSig: string
  recipients: { recipientDeviceId: string; sealed: string; senderPkB64: string }[]
}

/** Seal a connect intro to each of the target's devices (ECIES) + sign the plaintext hash.
 *  Recipients are authenticated with verifyPeerReceiptKey first. */
export async function buildConnectRequest(
  toAccountId: string,
  message: string,
  recipients: CommunityDevice[],
  record: DeviceRecord,
): Promise<BuiltConnectRequest> {
  const mls = await loadCrypto()
  const body: ConnectBody = { v: 1, message }
  const raw = encoder.encode(JSON.stringify(body))
  const sealed: BuiltConnectRequest['recipients'] = []
  for (const d of recipients) {
    const receiptPk = await verifyPeerReceiptKey(d)
    if (!receiptPk) continue
    const env = await eciesSeal(receiptPk, raw)
    sealed.push({
      recipientDeviceId: d.deviceId,
      sealed: env.sealedB64,
      senderPkB64: env.senderPkB64,
    })
  }
  const sig = mls.ed25519Sign(
    record.deviceSecret,
    await connectTuple(record.accountId, toAccountId, raw),
  )
  return { requesterDeviceId: record.deviceId, requesterSig: toStdB64(sig), recipients: sealed }
}

/** Open + verify an incoming connect request (this device is the target). The requester's
 *  device cert travels with the entry, so verification is self-contained (no community
 *  device lookup). Returns the intro and whether the requester's signature verified. */
export async function openConnectRequest(
  entry: IncomingConnectRequest,
  myAccountId: string,
  record: DeviceRecord,
): Promise<{ message: string; verified: boolean } | null> {
  if (!record.receiptPk || !record.receiptPrivPkcs8) return null
  try {
    const mls = await loadCrypto()
    const priv = await importEciesPrivateKey(toStdB64(record.receiptPrivPkcs8))
    const raw = await eciesOpen(priv, entry.senderPkB64, entry.sealed, record.receiptPk)
    const dev = await verifyDeviceCert({
      accountId: entry.fromAccountId,
      deviceCert: entry.requesterDeviceCert,
      certSig: entry.requesterCertSig,
    })
    const verified =
      !!dev &&
      mls.ed25519Verify(
        dev.devicePk,
        await connectTuple(entry.fromAccountId, myAccountId, raw),
        fromStdB64(entry.requesterSig),
      )
    const body = JSON.parse(decoder.decode(raw)) as ConnectBody
    if (body.v !== 1) return null
    return { message: body.message, verified }
  } catch {
    return null
  }
}
