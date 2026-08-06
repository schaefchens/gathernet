import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { initMls } from '@gathernet/mls-client'
import type { ChannelArtifact, MembershipCapability } from '@gathernet/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  type ArtifactBody,
  buildApproval,
  buildArtifact,
  openArtifactBody,
  openArtifactRaw,
  resealArtifactBody,
  verifyArtifact,
} from './artifacts.ts'
import {
  buildCapability,
  type CapabilityFetcher,
  COMMUNITY_SCOPE,
  type DeviceResolver,
} from './community-keys.ts'
import { loadCrypto } from './mls.ts'
import type { DeviceRecord } from './storage.ts'

const KMETA = new Uint8Array(32).fill(7)
const OWNER = 'ownerAcct'
const MEMBER = 'memberAcct'
const CHANNEL = 'chan123'

interface TestDevice {
  record: DeviceRecord
  devicePk: Uint8Array
  accountId: string
  deviceId: string
}

async function makeDevice(deviceId: string, accountId: string): Promise<TestDevice> {
  const mls = await loadCrypto()
  const kp = mls.generateDeviceKeypair()
  const record = { deviceId, accountId, deviceSecret: kp.secret } as unknown as DeviceRecord
  return { record, devicePk: kp.publicKey, accountId, deviceId }
}

/** A DeviceResolver over a fixed set of test devices. */
function resolverOf(...devices: TestDevice[]): DeviceResolver {
  const byId = new Map(devices.map((d) => [d.deviceId, d]))
  return async (id) => {
    const d = byId.get(id)
    return d ? { devicePk: d.devicePk, accountId: d.accountId } : null
  }
}

/** Wire a built artifact into a full ChannelArtifact record for verification. */
function record(
  built: Awaited<ReturnType<typeof buildArtifact>>,
  createdBy: string,
): ChannelArtifact {
  return {
    artifactId: built.artifactId,
    channelId: CHANNEL as ChannelArtifact['channelId'],
    kind: built.kind,
    sealEpoch: built.sealEpoch,
    sealedBody: built.sealedBody,
    issuerDeviceId: built.issuerDeviceId as ChannelArtifact['issuerDeviceId'],
    issuerSig: built.issuerSig,
    approverDeviceId: null,
    approvalSig: null,
    createdBy: createdBy as ChannelArtifact['createdBy'],
    createdAt: 1000,
    expiresAt: built.expiresAt,
    ticketCount: 0,
  }
}

/** Decrypt the body (as load() does) then verify — the plaintext feeds the signature. */
async function verify(
  rec: ChannelArtifact,
  policy: 'everyone' | 'moderators',
  owner: string | null,
  resolve: DeviceResolver,
  getCap: CapabilityFetcher,
  epoch: number,
  kMeta = KMETA,
) {
  const raw = await openArtifactRaw(kMeta, rec.sealedBody)
  if (!raw) throw new Error('decrypt failed')
  return verifyArtifact(rec, raw, policy, owner, resolve, getCap, epoch)
}

beforeAll(async () => {
  // The Hub's loadCrypto() calls initMls() with no bytes (URL fetch) — unavailable
  // under node/vitest, so pre-init the WASM from disk (idempotent).
  const wasmPath = fileURLToPath(
    new URL('../../../../packages/mls-client/wasm/mls_wasm_bg.wasm', import.meta.url),
  )
  await initMls({ wasmBytes: await readFile(wasmPath) })
  await loadCrypto()
})

describe('pinned artifacts — crypto + verification', () => {
  it('build → open round-trips the sealed body under K_meta', async () => {
    const owner = await makeDevice('devOwner', OWNER)
    const body: ArtifactBody = { v: 1, kind: 'pin', text: 'hold fast', originalMessageId: 'm1' }
    const built = await buildArtifact(CHANNEL, body, KMETA, 0, owner.record)
    expect(await openArtifactBody(KMETA, built.sealedBody)).toEqual(body)
    // A wrong key can't open it.
    expect(await openArtifactBody(new Uint8Array(32).fill(9), built.sealedBody)).toBeNull()
  })

  it("the owner's pin is active under either policy", async () => {
    const owner = await makeDevice('devOwner', OWNER)
    const resolve = resolverOf(owner)
    const getCap: CapabilityFetcher = async () => null
    const rec = record(
      await buildArtifact(CHANNEL, { v: 1, kind: 'pin', text: 'hi' }, KMETA, 0, owner.record),
      OWNER,
    )
    for (const policy of ['everyone', 'moderators'] as const) {
      const v = await verify(rec, policy, OWNER, resolve, getCap, 0)
      expect(v.status).toBe('active')
      expect(v.issuerAccountId).toBe(OWNER)
    }
  })

  it('a tampered signature is rejected as invalid', async () => {
    const owner = await makeDevice('devOwner', OWNER)
    const impostorPk = (await makeDevice('x', OWNER)).devicePk
    // The resolver returns the WRONG pubkey for the issuer device → signature fails.
    const resolve: DeviceResolver = async (id) =>
      id === owner.deviceId ? { devicePk: impostorPk, accountId: OWNER } : null
    const getCap: CapabilityFetcher = async () => null
    const rec = record(
      await buildArtifact(CHANNEL, { v: 1, kind: 'pin', text: 'x' }, KMETA, 0, owner.record),
      OWNER,
    )
    expect((await verify(rec, 'everyone', OWNER, resolve, getCap, 0)).status).toBe('invalid')
  })

  it('under moderators policy a member is a suggestion until a manager approves', async () => {
    const owner = await makeDevice('devOwner', OWNER)
    const member = await makeDevice('devMember', MEMBER)
    const resolve = resolverOf(owner, member)
    // The owner mints a real community-member cap for the member (root-signed).
    const memberCap = await buildCapability(
      'cm_x',
      COMMUNITY_SCOPE,
      MEMBER,
      'member',
      0,
      owner.record,
    )
    const getCap: CapabilityFetcher = async (scope, account) =>
      scope === COMMUNITY_SCOPE && account === MEMBER ? (memberCap as MembershipCapability) : null

    const built = await buildArtifact(
      CHANNEL,
      { v: 1, kind: 'pin', text: 'please pin' },
      KMETA,
      0,
      member.record,
    )
    const rec = record(built, MEMBER)

    // A member holding a valid cap → a suggestion (awaiting approval).
    expect((await verify(rec, 'moderators', OWNER, resolve, getCap, 0)).status).toBe('suggested')
    // Under 'everyone' the same member's pin is immediately active.
    expect((await verify(rec, 'everyone', OWNER, resolve, getCap, 0)).status).toBe('active')

    // A manager (owner) approves → active under 'moderators'.
    const approval = await buildApproval(CHANNEL, built.artifactId, owner.record)
    rec.approverDeviceId = approval.approverDeviceId as ChannelArtifact['approverDeviceId']
    rec.approvalSig = approval.approvalSig
    expect((await verify(rec, 'moderators', OWNER, resolve, getCap, 0)).status).toBe('active')
  })

  it('fails open to member-level when the cap chain cannot be walked (feature-phase)', async () => {
    // A signature-valid, resolvable member with no issued cap: not dropped — the
    // server already gates posting to active members. Suggestion under moderators,
    // active under everyone. (Strict cap authority is deferred crypto-phase hardening.)
    const owner = await makeDevice('devOwner', OWNER)
    const member = await makeDevice('devMember', MEMBER)
    const resolve = resolverOf(owner, member)
    const getCap: CapabilityFetcher = async () => null // no caps issued yet
    const rec = record(
      await buildArtifact(CHANNEL, { v: 1, kind: 'pin', text: 'x' }, KMETA, 0, member.record),
      MEMBER,
    )
    expect((await verify(rec, 'moderators', OWNER, resolve, getCap, 0)).status).toBe('suggested')
    expect((await verify(rec, 'everyone', OWNER, resolve, getCap, 0)).status).toBe('active')
  })

  it('survives a K_meta rotation: re-sealed body still verifies + decrypts', async () => {
    const owner = await makeDevice('devOwner', OWNER)
    const resolve = resolverOf(owner)
    const getCap: CapabilityFetcher = async () => null
    const body: ArtifactBody = { v: 1, kind: 'pin', text: 'hold fast' }
    const rec = record(await buildArtifact(CHANNEL, body, KMETA, 0, owner.record), OWNER)

    // Rotate: re-seal the same body under a NEW K_meta (as rotateCommunity does).
    const newKMeta = new Uint8Array(32).fill(42)
    const resealed = await resealArtifactBody(KMETA, newKMeta, rec.sealedBody)
    expect(resealed).not.toBeNull()
    rec.sealedBody = resealed as string
    rec.sealEpoch = 1

    // The old key can no longer open it; the new key does; and the ORIGINAL issuer
    // signature (which binds the plaintext, not the ciphertext) still verifies.
    expect(await openArtifactBody(KMETA, rec.sealedBody)).toBeNull()
    expect(await openArtifactBody(newKMeta, rec.sealedBody)).toEqual(body)
    expect((await verify(rec, 'everyone', OWNER, resolve, getCap, 1, newKMeta)).status).toBe(
      'active',
    )
  })
})
