import { authorizeAppRequestSchema } from '@gathernet/shared'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../../db/index.ts'
import { appSessions } from '../../db/schema.ts'
import { hashPrefixedToken } from '../../lib/crypto.ts'
import { getMe, ServiceError } from '../accounts/service.ts'
import { getAppConfig, getPublicationCard } from '../publications/service.ts'
import { grantAndMintSession, listGrants, revokeGrant } from './sessions.ts'

export interface AppRoutesOptions {
  db: Db
  /** device-session auth (Hub) */
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
  /** app-session auth factory (per-scope) */
  appAuthenticate: (
    scope?: 'identity' | 'storage' | 'rooms',
  ) => (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
}

function requireSession(request: FastifyRequest) {
  const session = request.session
  if (!session) throw new ServiceError(401, 'unauthorized')
  return session
}

function requireAppSession(request: FastifyRequest) {
  const session = request.appSession
  if (!session) throw new ServiceError(401, 'unauthorized')
  return session
}

export function registerAppRoutes(
  app: FastifyInstance,
  { db, authenticate, appAuthenticate }: AppRoutesOptions,
): void {
  /**
   * Popup flow: the unlocked Hub mints an app session after user consent.
   * The echoed, server-validated origin is the popup's postMessage target.
   */
  app.post<{ Params: { appId: string } }>(
    '/api/v1/apps/:appId/authorize',
    { preHandler: authenticate },
    async (request) => {
      const session = requireSession(request)
      const body = authorizeAppRequestSchema.parse(request.body)
      const config = await getAppConfig(db, request.params.appId)
      if (!config.origins.includes(body.origin)) {
        throw new ServiceError(403, 'origin_not_registered')
      }
      for (const scope of body.scopes) {
        if (!config.allowedScopes.includes(scope)) {
          throw new ServiceError(403, 'scope_not_allowed')
        }
      }
      const me = await getMe(db, session.accountId)
      const minted = await grantAndMintSession(
        db,
        request.params.appId,
        session.accountId,
        body.scopes,
      )
      return {
        token: minted.token,
        appUserId: minted.appUserId,
        displayName: me.displayName,
        scopes: body.scopes,
        expiresAt: minted.expiresAt.getTime(),
        origin: body.origin,
      }
    },
  )

  app.get('/api/v1/apps/grants', { preHandler: authenticate }, async (request) => {
    const session = requireSession(request)
    return { grants: await listGrants(db, session.accountId) }
  })

  app.delete<{ Params: { appId: string } }>(
    '/api/v1/apps/grants/:appId',
    { preHandler: authenticate },
    async (request) => {
      const session = requireSession(request)
      await revokeGrant(db, session.accountId, request.params.appId)
      return { ok: true }
    },
  )

  /* ---------- app-token surface (/api/v1/app/*) ---------- */

  app.get('/api/v1/app/me', { preHandler: appAuthenticate('identity') }, async (request) => {
    const session = requireAppSession(request)
    const card = await getPublicationCard(db, session.appId)
    return {
      appUserId: session.appUserId,
      displayName: session.displayName,
      scopes: session.scopes,
      app: { appId: session.appId, name: card.name },
    }
  })

  app.post('/api/v1/app/logout', { preHandler: appAuthenticate() }, async (request) => {
    const session = requireAppSession(request)
    // Delete only this session (grant remains — logout is not revocation).
    const header = request.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null
    const hash = token ? hashPrefixedToken(token, 'gna') : null
    if (hash) {
      await db
        .delete(appSessions)
        .where(and(eq(appSessions.tokenHash, hash), eq(appSessions.accountId, session.accountId)))
    }
    return { ok: true }
  })
}
