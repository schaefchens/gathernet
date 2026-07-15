import type { AppScope } from '@gathernet/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../db/index.ts'
import { type AppSessionIdentity, verifyAppSessionToken } from '../modules/apps/sessions.ts'

declare module 'fastify' {
  interface FastifyRequest {
    appSession: AppSessionIdentity | null
  }
}

/** preHandler for `/api/v1/app/*` routes: resolves `Bearer gna.…` + scope check. */
export function makeAppAuthenticate(db: Db, requiredScope?: AppScope) {
  return async function appAuthenticate(request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null
    const identity = token ? await verifyAppSessionToken(db, token) : null
    if (!identity) {
      return reply.status(401).send({ error: 'unauthorized' })
    }
    if (requiredScope && !identity.scopes.includes(requiredScope)) {
      return reply.status(403).send({ error: 'insufficient_scope' })
    }
    request.appSession = identity
  }
}
