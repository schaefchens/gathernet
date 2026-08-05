/**
 * Message reports — the client crypto substrate (seal / sign / open / verify). A report is
 * sealed (ECIES) to each of the channel's moderator devices' receipt keys and signed by the
 * reporter's device; the server stores opaque envelopes + minimal routing metadata only and
 * never learns the reported content, author, or reason. Recipients are authenticated with
 * verifyPeerReceiptKey first, so a compromised relay can't redirect a report to a device it
 * controls. A moderator opens their own envelope and re-verifies the reporter's signature.
 *
 * Signature: Ed25519(reporterDeviceKey, domain.channelReport ‖ channelId ‖ reportId ‖
 * SHA-256(plaintext)) — binds the report plaintext to its channel + id.
 */

import {
  type CommunityDevice,
  eciesOpen,
  eciesSeal,
  importEciesPrivateKey,
  type ReportEntry,
  SIG_DOMAIN,
} from '@gathernet/shared'
import {
  type DeviceResolver,
  fromStdB64,
  toStdB64,
  verifyPeerReceiptKey,
} from './community-keys.ts'
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

export type ReportReason = 'spam' | 'abuse' | 'inappropriate' | 'safety' | 'other'

/** The decrypted report payload — sealed to mods, never seen by the server. Carries a
 *  SNAPSHOT of the reported message so mods can review even after it's removed. */
export interface ReportBody {
  v: 1
  channelId: string
  /** server message identity of the reported message (mls_messages PK) */
  seq: number
  authorAccountId: string
  authorName?: string
  reason: ReportReason
  note?: string
  /** snapshot of the reported content */
  content: { text?: string; mediaName?: string }
}

async function reportTuple(
  channelId: string,
  reportId: string,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  return concat(
    encoder.encode(SIG_DOMAIN.channelReport),
    encoder.encode(channelId),
    encoder.encode(reportId),
    await sha256(plaintext),
  )
}

export interface BuiltReport {
  reportId: string
  reporterDeviceId: string
  reporterSig: string
  recipients: { recipientDeviceId: string; sealedReport: string; senderPkB64: string }[]
}

/** Seal a report to each moderator device (ECIES) + sign the plaintext hash. Recipients
 *  are verified with verifyPeerReceiptKey first (server can't redirect to a device it controls). */
export async function buildReport(
  channelId: string,
  body: ReportBody,
  recipients: CommunityDevice[],
  record: DeviceRecord,
): Promise<BuiltReport> {
  const mls = await loadCrypto()
  const reportId = crypto.randomUUID()
  const raw = encoder.encode(JSON.stringify(body))
  const sealed: BuiltReport['recipients'] = []
  for (const d of recipients) {
    const receiptPk = await verifyPeerReceiptKey(d)
    if (!receiptPk) continue
    const env = await eciesSeal(receiptPk, raw)
    sealed.push({
      recipientDeviceId: d.deviceId,
      sealedReport: env.sealedB64,
      senderPkB64: env.senderPkB64,
    })
  }
  const sig = mls.ed25519Sign(record.deviceSecret, await reportTuple(channelId, reportId, raw))
  return {
    reportId,
    reporterDeviceId: record.deviceId,
    reporterSig: toStdB64(sig),
    recipients: sealed,
  }
}

/** Open + verify a report the current device received (a moderator). Returns the body and
 *  whether the reporter's signature verified. */
export async function openReport(
  entry: ReportEntry,
  record: DeviceRecord,
  resolve: DeviceResolver,
): Promise<{ body: ReportBody; reporterAccountId: string | null; verified: boolean } | null> {
  if (!record.receiptPk || !record.receiptPrivPkcs8) return null
  try {
    const mls = await loadCrypto()
    const priv = await importEciesPrivateKey(toStdB64(record.receiptPrivPkcs8))
    const raw = await eciesOpen(priv, entry.senderPkB64, entry.sealedReport, record.receiptPk)
    const dev = await resolve(entry.reporterDeviceId)
    const verified =
      !!dev &&
      mls.ed25519Verify(
        dev.devicePk,
        await reportTuple(entry.channelId, entry.reportId, raw),
        fromStdB64(entry.reporterSig),
      )
    const body = JSON.parse(decoder.decode(raw)) as ReportBody
    if (body.v !== 1) return null
    return { body, reporterAccountId: dev?.accountId ?? null, verified }
  } catch {
    return null
  }
}
