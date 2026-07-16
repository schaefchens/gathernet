import {
  approveGrantCodeRequestSchema,
  authorizeAppRequestSchema,
  createGrantCodeRequestSchema,
  grantUserCodeSchema,
  pollGrantCodeRequestSchema,
} from '@gathernet/shared'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db } from '../../db/index.ts'
import { appSessions } from '../../db/schema.ts'
import { hashPrefixedToken } from '../../lib/crypto.ts'
import type { ConnectionRegistry } from '../../ws/registry.ts'
import { getMe, ServiceError } from '../accounts/service.ts'
import { getAppConfig, getPublicationCard } from '../publications/service.ts'
import {
  createGrantCode,
  pollGrantCode,
  previewGrantCode,
  resolveGrantCode,
} from './grant-codes.ts'
import { grantAndMintSession, listGrants, revokeGrant } from './sessions.ts'
import { deleteStorage, getStorage, listStorage, putStorage } from './storage.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const pollBodySchema = pollGrantCodeRequestSchema.extend({
  waitSeconds: z.number().int().min(0).max(25).default(20),
})

export interface AppRoutesOptions {
  db: Db
  /** live-socket registry, so grant revocation can drop app WS sessions */
  registry: ConnectionRegistry
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
  { db, registry, authenticate, appAuthenticate }: AppRoutesOptions,
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
      // Disclose the real display name only when 'identity' was granted —
      // otherwise a storage/rooms-only app could deanonymize users by name.
      return {
        token: minted.token,
        appUserId: minted.appUserId,
        displayName: body.scopes.includes('identity') ? me.displayName : '',
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
      // Drop any live app WebSocket immediately — like device revocation does.
      // (gna. sockets authenticate once at connect and aren't re-checked per
      // frame, so without this a revoked app keeps relaying room ciphertext.)
      registry.closeAppAccount(request.params.appId, session.accountId, {
        type: 'session.revoked',
        payload: {},
      })
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

  /* ---------- device-code grant flow ---------- */

  // App-side (no auth; the browser Origin header must be registered).
  app.post('/api/v1/app/grant-codes', async (request, reply) => {
    const body = createGrantCodeRequestSchema.parse(request.body)
    reply.status(201)
    return createGrantCode(db, body.appId, body.scopes, request.headers.origin, body.ephemeralPk)
  })

  // App-side long-poll for the outcome.
  app.post('/api/v1/app/grant-codes/poll', async (request, reply) => {
    const body = pollBodySchema.parse(request.body)
    const deadline = Date.now() + body.waitSeconds * 1000
    for (;;) {
      const result = await pollGrantCode(db, body.pollSecret)
      if (result.status === 'granted') return result
      if (result.status === 'denied') return reply.status(410).send({ error: 'denied' })
      if (result.status === 'gone') return reply.status(410).send({ error: 'gone' })
      if (Date.now() >= deadline) return reply.status(202).send({ status: 'pending' })
      await sleep(1500)
    }
  })

  // Hub-side: preview + approve/deny (guess surface — tightly rate limited).
  app.get<{ Params: { userCode: string } }>(
    '/api/v1/apps/grant-codes/:userCode',
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    },
    async (request) => {
      requireSession(request)
      const userCode = grantUserCodeSchema.parse(request.params.userCode)
      return previewGrantCode(db, userCode)
    },
  )

  app.post<{ Params: { userCode: string } }>(
    '/api/v1/apps/grant-codes/:userCode/approve',
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    },
    async (request) => {
      const session = requireSession(request)
      const userCode = grantUserCodeSchema.parse(request.params.userCode)
      const body = approveGrantCodeRequestSchema.parse(request.body)
      await resolveGrantCode(db, session.accountId, userCode, 'approve', body)
      return { ok: true }
    },
  )

  app.post<{ Params: { userCode: string } }>(
    '/api/v1/apps/grant-codes/:userCode/deny',
    { preHandler: authenticate },
    async (request) => {
      const session = requireSession(request)
      const userCode = grantUserCodeSchema.parse(request.params.userCode)
      await resolveGrantCode(db, session.accountId, userCode, 'deny')
      return { ok: true }
    },
  )

  /* ---------- encrypted app storage ---------- */

  app.get('/api/v1/app/storage', { preHandler: appAuthenticate('storage') }, async (request) => {
    const session = requireAppSession(request)
    return { entries: await listStorage(db, session.appId, session.accountId) }
  })

  app.get<{ Params: { key: string } }>(
    '/api/v1/app/storage/:key',
    { preHandler: appAuthenticate('storage') },
    async (request, reply) => {
      const session = requireAppSession(request)
      const row = await getStorage(db, session.appId, session.accountId, request.params.key)
      reply.header('etag', `"${row.version}"`)
      reply.type('application/octet-stream')
      return reply.send(row.ciphertext)
    },
  )

  app.put<{ Params: { key: string } }>(
    '/api/v1/app/storage/:key',
    { preHandler: appAuthenticate('storage') },
    async (request, reply) => {
      const session = requireAppSession(request)
      const body = request.body
      if (!Buffer.isBuffer(body)) throw new ServiceError(400, 'binary_body_required')

      const ifMatch = request.headers['if-match']
      const ifNoneMatch = request.headers['if-none-match']
      const ifVersion =
        typeof ifMatch === 'string' ? Number(ifMatch.replaceAll('"', '')) : undefined
      if (ifMatch !== undefined && Number.isNaN(ifVersion)) {
        throw new ServiceError(400, 'invalid_if_match')
      }

      const result = await putStorage(
        db,
        session.appId,
        session.accountId,
        request.params.key,
        body,
        {
          ifVersion,
          createOnly: ifNoneMatch === '*',
        },
      )
      reply.header('etag', `"${result.version}"`)
      return { version: result.version }
    },
  )

  app.delete<{ Params: { key: string } }>(
    '/api/v1/app/storage/:key',
    { preHandler: appAuthenticate('storage') },
    async (request) => {
      const session = requireAppSession(request)
      await deleteStorage(db, session.appId, session.accountId, request.params.key)
      return { ok: true }
    },
  )
}
