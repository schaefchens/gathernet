import {
  base58Encode,
  type CreateAccountRequest,
  type EnrollDeviceRequest,
  type LoginRequest,
  SIG_DOMAIN,
} from '@gathernet/shared'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { accounts, devices } from '../../db/schema.ts'
import { ed25519Verify, safeEqual, sigPayload } from '../../lib/crypto.ts'
import { type DeviceCert, verifyDeviceCert } from '../../lib/device-cert.ts'
import { consumeChallenge } from '../auth/challenges.ts'
import { createSession, revokeSessionsForDevice } from '../auth/sessions.ts'

export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

interface EnrollmentInput {
  accountPk: Buffer
  certBytes: Buffer
  certSig: Buffer
  challenge: Buffer
  identitySig: Buffer
  deviceSig: Buffer
}

function decodeEnrollment(body: CreateAccountRequest | EnrollDeviceRequest): EnrollmentInput {
  return {
    accountPk: Buffer.from(body.accountPk, 'base64'),
    certBytes: Buffer.from(body.deviceCert, 'base64'),
    certSig: Buffer.from(body.certSig, 'base64'),
    challenge: Buffer.from(body.challenge, 'base64'),
    identitySig: Buffer.from(body.identitySig, 'base64'),
    deviceSig: Buffer.from(body.deviceSig, 'base64'),
  }
}

/**
 * Common enrollment verification: challenge is fresh and single-use, the
 * device cert chains to the claimed account key, and BOTH the identity key
 * and the device key have signed this exact enrollment.
 */
async function verifyEnrollment(db: Db, input: EnrollmentInput): Promise<DeviceCert> {
  if (!(await consumeChallenge(db, input.challenge, 'enroll'))) {
    throw new ServiceError(401, 'challenge_invalid')
  }

  const certResult = verifyDeviceCert(input.certBytes, input.certSig)
  if (!certResult.ok) throw new ServiceError(400, `cert_${certResult.error}`)
  const cert = certResult.cert

  if (!safeEqual(cert.accountPk, input.accountPk)) {
    throw new ServiceError(400, 'account_pk_mismatch')
  }

  const enrollPayload = sigPayload(SIG_DOMAIN.enroll, input.challenge, input.certBytes)
  if (!ed25519Verify(input.accountPk, enrollPayload, input.identitySig)) {
    throw new ServiceError(401, 'identity_sig_invalid')
  }
  if (!ed25519Verify(cert.devicePk, enrollPayload, input.deviceSig)) {
    throw new ServiceError(401, 'device_sig_invalid')
  }

  return cert
}

export async function createAccount(db: Db, body: CreateAccountRequest) {
  const input = decodeEnrollment(body)
  const cert = await verifyEnrollment(db, input)
  const accountId = base58Encode(input.accountPk)

  try {
    await db.transaction(async (tx) => {
      await tx.insert(accounts).values({
        accountId,
        accountPk: input.accountPk,
        displayName: body.displayName,
      })
      await tx.insert(devices).values({
        deviceId: cert.deviceId,
        accountId,
        devicePk: cert.devicePk,
        cert: input.certBytes,
        certSig: input.certSig,
        name: cert.name,
      })
    })
  } catch (err) {
    if (isUniqueViolation(err)) throw new ServiceError(409, 'already_exists')
    throw err
  }

  const session = await createSession(db, accountId, cert.deviceId)
  return {
    accountId,
    deviceId: cert.deviceId,
    displayName: body.displayName,
    token: session.token,
    expiresAt: session.expiresAt.getTime(),
    groups: [] as { groupId: string; groupInfo: string }[],
  }
}

/** Additional device via recovery phrase: account must already exist. */
export async function enrollDevice(db: Db, body: EnrollDeviceRequest) {
  const input = decodeEnrollment(body)
  const cert = await verifyEnrollment(db, input)

  const account = await db.query.accounts.findFirst({
    where: eq(accounts.accountId, base58Encode(input.accountPk)),
  })
  if (!account) throw new ServiceError(404, 'account_not_found')

  try {
    await db.insert(devices).values({
      deviceId: cert.deviceId,
      accountId: account.accountId,
      devicePk: cert.devicePk,
      cert: input.certBytes,
      certSig: input.certSig,
      name: cert.name,
    })
  } catch (err) {
    if (isUniqueViolation(err)) throw new ServiceError(409, 'device_exists')
    throw err
  }

  const session = await createSession(db, account.accountId, cert.deviceId)
  return {
    accountId: account.accountId,
    deviceId: cert.deviceId,
    displayName: account.displayName,
    token: session.token,
    expiresAt: session.expiresAt.getTime(),
    // Stage 6 fills this with {groupId, groupInfo} for external joins.
    groups: [] as { groupId: string; groupInfo: string }[],
  }
}

export async function login(db: Db, body: LoginRequest) {
  const challenge = Buffer.from(body.challenge, 'base64')

  const device = await db.query.devices.findFirst({
    where: and(eq(devices.deviceId, body.deviceId), eq(devices.status, 'active')),
  })
  // Consume the challenge regardless, then fail — avoids oracle behavior.
  const challengeOk = await consumeChallenge(db, challenge, 'login')
  if (!device || !challengeOk) throw new ServiceError(401, 'unauthorized')

  const payload = sigPayload(SIG_DOMAIN.auth, challenge, Buffer.from(body.deviceId, 'utf8'))
  if (!ed25519Verify(device.devicePk, payload, Buffer.from(body.sig, 'base64'))) {
    throw new ServiceError(401, 'unauthorized')
  }

  const account = await db.query.accounts.findFirst({
    where: eq(accounts.accountId, device.accountId),
  })
  if (!account) throw new ServiceError(401, 'unauthorized')

  await db
    .update(devices)
    .set({ lastSeenAt: new Date() })
    .where(eq(devices.deviceId, device.deviceId))

  const session = await createSession(db, device.accountId, device.deviceId)
  return {
    accountId: device.accountId,
    deviceId: device.deviceId,
    displayName: account.displayName,
    token: session.token,
    expiresAt: session.expiresAt.getTime(),
  }
}

export async function listDevices(db: Db, accountId: string, currentDeviceId: string) {
  const rows = await db.query.devices.findMany({
    where: eq(devices.accountId, accountId),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  })
  return rows.map((d) => ({
    deviceId: d.deviceId,
    name: d.name,
    status: d.status,
    isCurrent: d.deviceId === currentDeviceId,
    createdAt: d.createdAt.getTime(),
    lastSeenAt: d.lastSeenAt?.getTime() ?? null,
  }))
}

export async function revokeDevice(
  db: Db,
  accountId: string,
  targetDeviceId: string,
): Promise<void> {
  const updated = await db
    .update(devices)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(
      and(
        eq(devices.deviceId, targetDeviceId),
        eq(devices.accountId, accountId),
        eq(devices.status, 'active'),
      ),
    )
    .returning({ deviceId: devices.deviceId })
  if (updated.length === 0) throw new ServiceError(404, 'device_not_found')
  await revokeSessionsForDevice(db, targetDeviceId)
}

export async function getMe(db: Db, accountId: string) {
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.accountId, accountId),
  })
  if (!account) throw new ServiceError(404, 'account_not_found')
  return {
    accountId: account.accountId,
    displayName: account.displayName,
    presencePref: account.presencePref,
    createdAt: account.createdAt.getTime(),
  }
}

export async function updateMe(
  db: Db,
  accountId: string,
  patch: {
    displayName?: string | undefined
    presencePref?: 'online' | 'away' | 'invisible' | undefined
  },
) {
  const set: Record<string, string> = {}
  if (patch.displayName !== undefined) set.displayName = patch.displayName
  if (patch.presencePref !== undefined) set.presencePref = patch.presencePref
  if (Object.keys(set).length > 0) {
    await db.update(accounts).set(set).where(eq(accounts.accountId, accountId))
  }
  return getMe(db, accountId)
}

function isUniqueViolation(err: unknown): boolean {
  // pg reports 23505; drizzle may surface it directly or wrapped in `cause`.
  let current: unknown = err
  for (let depth = 0; depth < 3 && typeof current === 'object' && current !== null; depth++) {
    if ((current as { code?: unknown }).code === '23505') return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}
