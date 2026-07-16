import { originSchema, registerPublicationRequestSchema, scopesSchema } from '@gathernet/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db } from '../../db/index.ts'
import { ServiceError } from '../accounts/service.ts'
import { invalidateOriginCache } from '../apps/origins.ts'
import {
  getOwnPublication,
  getPublicationCard,
  listOwnPublications,
  registerPublication,
  updateOwnPublication,
} from './service.ts'

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  iconUrl: z.url().max(300).optional(),
  // Same strict validation as registration — never let PATCH smuggle a
  // plaintext or malformed origin into the CORS allowlist / postMessage targets.
  origins: z.array(originSchema).min(1).max(10).optional(),
  allowedScopes: scopesSchema.optional(),
})

export interface PublicationRoutesOptions {
  db: Db
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
}

function requireSession(request: FastifyRequest) {
  const session = request.session
  if (!session) throw new ServiceError(401, 'unauthorized')
  return session
}

export function registerPublicationRoutes(
  app: FastifyInstance,
  { db, authenticate }: PublicationRoutesOptions,
): void {
  app.post('/api/v1/publications', { preHandler: authenticate }, async (request, reply) => {
    const session = requireSession(request)
    const body = registerPublicationRequestSchema.parse(request.body)
    reply.status(201)
    const result = await registerPublication(db, session.accountId, body)
    invalidateOriginCache()
    return result
  })

  app.get('/api/v1/publications', { preHandler: authenticate }, async (request) => {
    const session = requireSession(request)
    return { publications: await listOwnPublications(db, session.accountId) }
  })

  app.get<{ Params: { pubId: string } }>(
    '/api/v1/publications/:pubId',
    { preHandler: authenticate },
    async (request) => {
      const session = requireSession(request)
      return getOwnPublication(db, session.accountId, request.params.pubId)
    },
  )

  app.patch<{ Params: { pubId: string } }>(
    '/api/v1/publications/:pubId',
    { preHandler: authenticate },
    async (request) => {
      const session = requireSession(request)
      const body = updateSchema.parse(request.body)
      const result = await updateOwnPublication(db, session.accountId, request.params.pubId, body)
      invalidateOriginCache()
      return result
    },
  )

  /** Public consent-screen card (no auth; global rate limit applies). */
  app.get<{ Params: { appId: string } }>('/api/v1/apps/card/:appId', async (request) => {
    return getPublicationCard(db, request.params.appId)
  })
}
