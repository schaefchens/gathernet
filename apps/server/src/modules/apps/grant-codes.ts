import { GRANT_CODE_TTL_MS, GRANT_QR_PREFIX } from '@gathernet/shared'
import { and, eq, lt } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { accounts, appGrantCodes } from '../../db/schema.ts'
import { newCrockfordCode } from '../../lib/codes.ts'
import { newChallenge, sha256 } from '../../lib/crypto.ts'
import { ServiceError } from '../accounts/service.ts'
import { getAppConfig, getPublicationCard } from '../publications/service.ts'
import { grantAndMintSession } from './sessions.ts'

/**
 * Device-code grant flow (QR / manual entry): the app displays a short code,
 * the user approves it in the Hub, the app polls until the token is released.
 * Single-use: approved → consumed happens atomically at the releasing poll.
 */

export async function createGrantCode(
  db: Db,
  appId: string,
  scopes: string[],
  origin: string | undefined,
  ephemeralPkB64: string | undefined,
) {
  const config = await getAppConfig(db, appId)
  if (!origin || !config.origins.includes(origin)) {
    throw new ServiceError(403, 'origin_not_registered')
  }
  for (const scope of scopes) {
    if (!config.allowedScopes.includes(scope)) throw new ServiceError(403, 'scope_not_allowed')
  }

  const userCode = newCrockfordCode(8)
  const pollSecret = newChallenge().toString('base64url')
  const expiresAt = new Date(Date.now() + GRANT_CODE_TTL_MS)
  await db.insert(appGrantCodes).values({
    pubId: appId,
    userCode,
    pollSecretHash: sha256(Buffer.from(pollSecret, 'base64url')),
    requestedScopes: scopes,
    appEphemeralPk: ephemeralPkB64 ? Buffer.from(ephemeralPkB64, 'base64') : null,
    expiresAt,
  })
  return {
    userCode,
    qrPayload: `${GRANT_QR_PREFIX}${userCode}`,
    pollSecret,
    expiresAt: expiresAt.getTime(),
    intervalSeconds: 2,
  }
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'denied' }
  | { status: 'gone' }
  | {
      status: 'granted'
      token: string
      appUserId: string
      displayName: string
      scopes: string[]
      expiresAt: number
      sealedStorageKey: string | null
      hubEphemeralPk: string | null
    }

export async function pollGrantCode(db: Db, pollSecret: string): Promise<PollResult> {
  const secret = Buffer.from(pollSecret, 'base64url')
  if (secret.length !== 32) return { status: 'gone' }
  const hash = sha256(secret)

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(appGrantCodes)
      .where(eq(appGrantCodes.pollSecretHash, hash))
      .for('update')
    if (!row || row.status === 'consumed' || row.expiresAt <= new Date()) {
      return { status: 'gone' }
    }
    if (row.status === 'denied') return { status: 'denied' }
    if (row.status === 'pending') return { status: 'pending' }

    // approved → mint now and consume atomically (single use).
    if (!row.accountId || !row.grantedScopes) return { status: 'gone' }
    await tx.update(appGrantCodes).set({ status: 'consumed' }).where(eq(appGrantCodes.id, row.id))
    const minted = await grantAndMintSession(
      tx as unknown as Db,
      row.pubId,
      row.accountId,
      row.grantedScopes,
    )
    const account = await tx.query.accounts.findFirst({
      where: eq(accounts.accountId, row.accountId),
    })
    return {
      status: 'granted',
      token: minted.token,
      appUserId: minted.appUserId,
      displayName: account?.displayName ?? '',
      scopes: row.grantedScopes,
      expiresAt: Date.now() + 14 * 24 * 3600 * 1000,
      sealedStorageKey: row.sealedStorageKey?.toString('base64') ?? null,
      hubEphemeralPk: row.hubEphemeralPk?.toString('base64') ?? null,
    }
  })
}

export async function previewGrantCode(db: Db, userCode: string) {
  const row = await db.query.appGrantCodes.findFirst({
    where: eq(appGrantCodes.userCode, userCode),
  })
  if (!row || row.status !== 'pending' || row.expiresAt <= new Date()) {
    throw new ServiceError(404, 'code_invalid')
  }
  const card = await getPublicationCard(db, row.pubId)
  return {
    userCode: row.userCode,
    app: card,
    requestedScopes: row.requestedScopes,
    appEphemeralPk: row.appEphemeralPk?.toString('base64') ?? null,
    expiresAt: row.expiresAt.getTime(),
  }
}

export async function resolveGrantCode(
  db: Db,
  accountId: string,
  userCode: string,
  action: 'approve' | 'deny',
  approval?: {
    scopes: string[]
    sealedStorageKey?: string | undefined
    hubEphemeralPk?: string | undefined
  },
): Promise<void> {
  const row = await db.query.appGrantCodes.findFirst({
    where: eq(appGrantCodes.userCode, userCode),
  })
  if (!row || row.status !== 'pending' || row.expiresAt <= new Date()) {
    throw new ServiceError(404, 'code_invalid')
  }

  if (action === 'deny') {
    await db
      .update(appGrantCodes)
      .set({ status: 'denied', accountId })
      .where(and(eq(appGrantCodes.id, row.id), eq(appGrantCodes.status, 'pending')))
    return
  }

  if (!approval) throw new ServiceError(400, 'invalid_body')
  const config = await getAppConfig(db, row.pubId)
  for (const scope of approval.scopes) {
    if (!row.requestedScopes.includes(scope) || !config.allowedScopes.includes(scope)) {
      throw new ServiceError(403, 'scope_not_allowed')
    }
  }
  const updated = await db
    .update(appGrantCodes)
    .set({
      status: 'approved',
      accountId,
      grantedScopes: approval.scopes,
      sealedStorageKey: approval.sealedStorageKey
        ? Buffer.from(approval.sealedStorageKey, 'base64')
        : null,
      hubEphemeralPk: approval.hubEphemeralPk
        ? Buffer.from(approval.hubEphemeralPk, 'base64')
        : null,
    })
    .where(and(eq(appGrantCodes.id, row.id), eq(appGrantCodes.status, 'pending')))
    .returning({ id: appGrantCodes.id })
  if (updated.length === 0) throw new ServiceError(404, 'code_invalid')
}

export async function pruneGrantCodes(db: Db): Promise<void> {
  await db.delete(appGrantCodes).where(lt(appGrantCodes.expiresAt, new Date()))
}
