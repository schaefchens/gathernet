import { uploadMessageMediaRequestSchema } from '@gathernet/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../../db/index.ts'
import type { BlobStore } from '../../storage/blob-store.ts'
import { ServiceError } from '../accounts/service.ts'
import { deleteMessageMedia, getMessageMedia, uploadMessageMedia } from './service.ts'

export interface MediaRoutesOptions {
  db: Db
  blobStore: BlobStore
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
}

function requireSession(request: FastifyRequest) {
  const session = request.session
  if (!session) throw new ServiceError(401, 'unauthorized')
  return session
}

export function registerMediaRoutes(
  app: FastifyInstance,
  { db, blobStore, authenticate }: MediaRoutesOptions,
): void {
  const auth = { preHandler: authenticate }

  app.post('/api/v1/media', auth, async (request, reply) => {
    const session = requireSession(request)
    const body = uploadMessageMediaRequestSchema.parse(request.body)
    reply.status(201)
    return uploadMessageMedia(db, blobStore, session.accountId, body.ciphertext)
  })

  app.get<{ Params: { mediaId: string } }>(
    '/api/v1/media/:mediaId',
    auth,
    async (request, reply) => {
      requireSession(request)
      const bytes = await getMessageMedia(db, blobStore, request.params.mediaId)
      reply.header('cache-control', 'private, max-age=31536000, immutable')
      reply.type('application/octet-stream')
      return reply.send(bytes)
    },
  )

  app.delete<{ Params: { mediaId: string } }>('/api/v1/media/:mediaId', auth, async (request) => {
    const session = requireSession(request)
    await deleteMessageMedia(db, blobStore, session.accountId, request.params.mediaId)
    return { ok: true }
  })
}
