import type { AppId, AppScope, AppUserId } from '@gathernet/shared'
import { APP_SESSION_TTL_DAYS } from '@gathernet/shared'
import { and, eq, gt, sql } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { accounts, appAccounts, appGrants, appSessions, publications } from '../../db/schema.ts'
import { newHexId } from '../../lib/codes.ts'
import { hashPrefixedToken, newPrefixedToken } from '../../lib/crypto.ts'

export const APP_SESSION_TTL_MS = APP_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000
const SLIDE_THROTTLE_MS = 60 * 60 * 1000

export interface AppSessionIdentity {
  appId: AppId
  accountId: string
  appUserId: AppUserId
  displayName: string
  scopes: AppScope[]
}

/** Get-or-create the pseudonymous per-(app, account) user id. Never deleted. */
export async function ensureAppAccount(db: Db, pubId: string, accountId: string): Promise<string> {
  const existing = await db.query.appAccounts.findFirst({
    where: and(eq(appAccounts.pubId, pubId), eq(appAccounts.accountId, accountId)),
  })
  if (existing) return existing.appUserId
  const appUserId = newHexId('au', 16)
  await db.insert(appAccounts).values({ pubId, accountId, appUserId }).onConflictDoNothing()
  const row = await db.query.appAccounts.findFirst({
    where: and(eq(appAccounts.pubId, pubId), eq(appAccounts.accountId, accountId)),
  })
  if (!row) throw new Error('app account upsert failed')
  return row.appUserId
}

/** Upsert consent (scopes accumulate) and mint an app session token. */
export async function grantAndMintSession(
  db: Db,
  pubId: string,
  accountId: string,
  scopes: string[],
): Promise<{ token: string; appUserId: string; expiresAt: Date }> {
  const appUserId = await ensureAppAccount(db, pubId, accountId)
  await db
    .insert(appGrants)
    .values({ pubId, accountId, scopes })
    .onConflictDoUpdate({
      target: [appGrants.pubId, appGrants.accountId],
      set: {
        scopes: sql`(
          SELECT array_agg(DISTINCT s) FROM unnest(${appGrants.scopes} || ${sql.param(scopes)}::text[]) AS s
        )`,
        lastUsedAt: new Date(),
      },
    })

  const { token, tokenHash } = newPrefixedToken('gna')
  const expiresAt = new Date(Date.now() + APP_SESSION_TTL_MS)
  await db.insert(appSessions).values({ pubId, accountId, scopes, tokenHash, expiresAt })
  return { token, appUserId, expiresAt }
}

/**
 * `gna.` token → identity. Joins app_grants (grant deletion = instant revoke)
 * and publications (must remain active kind app|game).
 */
export async function verifyAppSessionToken(
  db: Db,
  token: string,
): Promise<AppSessionIdentity | null> {
  const tokenHash = hashPrefixedToken(token, 'gna')
  if (!tokenHash) return null

  const rows = await db
    .select({
      sessionId: appSessions.id,
      pubId: appSessions.pubId,
      accountId: appSessions.accountId,
      scopes: appSessions.scopes,
      lastUsedAt: appSessions.lastUsedAt,
      appUserId: appAccounts.appUserId,
      displayName: accounts.displayName,
    })
    .from(appSessions)
    .innerJoin(
      appGrants,
      and(eq(appGrants.pubId, appSessions.pubId), eq(appGrants.accountId, appSessions.accountId)),
    )
    .innerJoin(publications, eq(publications.pubId, appSessions.pubId))
    .innerJoin(
      appAccounts,
      and(
        eq(appAccounts.pubId, appSessions.pubId),
        eq(appAccounts.accountId, appSessions.accountId),
      ),
    )
    .innerJoin(accounts, eq(accounts.accountId, appSessions.accountId))
    .where(and(eq(appSessions.tokenHash, tokenHash), gt(appSessions.expiresAt, new Date())))
    .limit(1)

  const row = rows[0]
  if (!row) return null

  const now = Date.now()
  if (now - row.lastUsedAt.getTime() > SLIDE_THROTTLE_MS) {
    await db
      .update(appSessions)
      .set({ lastUsedAt: new Date(now), expiresAt: new Date(now + APP_SESSION_TTL_MS) })
      .where(eq(appSessions.id, row.sessionId))
    await db
      .update(appGrants)
      .set({ lastUsedAt: new Date(now) })
      .where(and(eq(appGrants.pubId, row.pubId), eq(appGrants.accountId, row.accountId)))
  }

  return {
    appId: row.pubId as AppId,
    accountId: row.accountId,
    appUserId: row.appUserId as AppUserId,
    displayName: row.displayName,
    scopes: row.scopes as AppScope[],
  }
}

export async function revokeGrant(db: Db, accountId: string, pubId: string): Promise<void> {
  await db
    .delete(appSessions)
    .where(and(eq(appSessions.pubId, pubId), eq(appSessions.accountId, accountId)))
  await db
    .delete(appGrants)
    .where(and(eq(appGrants.pubId, pubId), eq(appGrants.accountId, accountId)))
}

export async function listGrants(db: Db, accountId: string) {
  const rows = await db
    .select({
      pubId: appGrants.pubId,
      scopes: appGrants.scopes,
      createdAt: appGrants.createdAt,
      lastUsedAt: appGrants.lastUsedAt,
      name: publications.name,
      iconUrl: publications.iconUrl,
    })
    .from(appGrants)
    .innerJoin(publications, eq(publications.pubId, appGrants.pubId))
    .where(eq(appGrants.accountId, accountId))
    .orderBy(appGrants.lastUsedAt)
  return rows.map((r) => ({
    appId: r.pubId,
    name: r.name,
    iconUrl: r.iconUrl,
    scopes: r.scopes,
    createdAt: r.createdAt.getTime(),
    lastUsedAt: r.lastUsedAt.getTime(),
  }))
}
