import type { AccountId, DeviceId } from '@gathernet/shared'
import { and, eq, gt } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { devices, sessions } from '../../db/schema.ts'
import { hashToken, newSessionToken } from '../../lib/crypto.ts'

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Sliding expiry writes are throttled to at most one per hour per session. */
const SLIDE_THROTTLE_MS = 60 * 60 * 1000

export interface SessionIdentity {
  sessionId: string
  accountId: AccountId
  deviceId: DeviceId
}

export async function createSession(
  db: Db,
  accountId: string,
  deviceId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const { token, tokenHash } = newSessionToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  await db.insert(sessions).values({ accountId, deviceId, tokenHash, expiresAt })
  return { token, expiresAt }
}

/**
 * Bearer token → identity. Joins on devices so a revoked device's sessions
 * die instantly regardless of session expiry.
 */
export async function verifySessionToken(db: Db, token: string): Promise<SessionIdentity | null> {
  const tokenHash = hashToken(token)
  if (!tokenHash) return null

  const rows = await db
    .select({
      sessionId: sessions.id,
      accountId: sessions.accountId,
      deviceId: sessions.deviceId,
      lastUsedAt: sessions.lastUsedAt,
      deviceStatus: devices.status,
    })
    .from(sessions)
    .innerJoin(devices, eq(sessions.deviceId, devices.deviceId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
    .limit(1)

  const row = rows[0]
  if (row?.deviceStatus !== 'active') return null

  const now = Date.now()
  if (now - row.lastUsedAt.getTime() > SLIDE_THROTTLE_MS) {
    await db
      .update(sessions)
      .set({ lastUsedAt: new Date(now), expiresAt: new Date(now + SESSION_TTL_MS) })
      .where(eq(sessions.id, row.sessionId))
  }

  return {
    sessionId: row.sessionId,
    accountId: row.accountId as AccountId,
    deviceId: row.deviceId as DeviceId,
  }
}

export async function revokeSessionsForDevice(db: Db, deviceId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.deviceId, deviceId))
}
