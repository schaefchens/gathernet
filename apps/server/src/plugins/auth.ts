import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../db/index.ts'
import { type SessionIdentity, verifySessionToken } from '../modules/auth/sessions.ts'

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionIdentity | null
  }
}

/** preHandler for protected routes: resolves `Authorization: Bearer gn.…`. */
export function makeAuthenticate(db: Db) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null
    const identity = token ? await verifySessionToken(db, token) : null
    if (!identity) {
      return reply.status(401).send({ error: 'unauthorized' })
    }
    request.session = identity
  }
}
