import {
  claimKeyPackagesRequestSchema,
  type DeviceId,
  type GroupId,
  postCommitRequestSchema,
  uploadKeyPackagesRequestSchema,
} from '@gathernet/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db } from '../../db/index.ts'
import type { ConnectionRegistry } from '../../ws/registry.ts'
import { ServiceError } from '../accounts/service.ts'
import {
  claimKeyPackages,
  countKeyPackages,
  EpochConflictError,
  listGroups,
  listMessages,
  listWelcomes,
  postCommit,
  uploadKeyPackages,
} from './service.ts'

const messagesQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
})

export interface DeliveryRoutesOptions {
  db: Db
  registry: ConnectionRegistry
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
}

function requireSession(request: FastifyRequest) {
  const session = request.session
  if (!session) throw new ServiceError(401, 'unauthorized')
  return session
}

export function registerDeliveryRoutes(
  app: FastifyInstance,
  { db, registry, authenticate }: DeliveryRoutesOptions,
): void {
  app.post('/api/v1/mls/key-packages', { preHandler: authenticate }, async (request) => {
    const session = requireSession(request)
    const body = uploadKeyPackagesRequestSchema.parse(request.body)
    const remaining = await uploadKeyPackages(db, session.deviceId, body)
    return { kpRemaining: remaining }
  })

  app.get('/api/v1/mls/key-packages/count', { preHandler: authenticate }, async (request) => {
    const session = requireSession(request)
    return { kpRemaining: await countKeyPackages(db, session.deviceId) }
  })

  app.post('/api/v1/mls/key-packages/claim', { preHandler: authenticate }, async (request) => {
    const session = requireSession(request)
    const body = claimKeyPackagesRequestSchema.parse(request.body)
    return {
      keyPackages: await claimKeyPackages(db, session.accountId, session.deviceId, body.accountIds),
    }
  })

  app.get('/api/v1/mls/groups', { preHandler: authenticate }, async (request) => {
    const session = requireSession(request)
    return { groups: await listGroups(db, session.accountId, session.deviceId) }
  })

  app.post<{ Params: { groupId: string } }>(
    '/api/v1/mls/groups/:groupId/commits',
    { preHandler: authenticate },
    async (request, reply) => {
      const session = requireSession(request)
      const body = postCommitRequestSchema.parse(request.body)
      try {
        const fanout = await postCommit(
          db,
          session.accountId,
          session.deviceId,
          request.params.groupId,
          body,
        )
        for (const recipient of fanout.commitRecipients) {
          registry.sendToDevice(recipient, {
            type: 'chat.message',
            payload: {
              groupId: request.params.groupId as GroupId,
              seq: fanout.seq,
              kind: 'commit',
              epoch: body.epoch,
              senderDevice: fanout.senderDevice as DeviceId,
              payload: fanout.payload,
              sentAt: Date.now(),
            },
          })
        }
        for (const welcome of fanout.welcomeRecipients) {
          registry.sendToDevice(welcome.deviceId, {
            type: 'welcome',
            payload: {
              welcomeId: welcome.welcomeId,
              groupId: request.params.groupId as GroupId,
              payload: welcome.payload,
            },
          })
        }
        return { seq: fanout.seq, newEpoch: fanout.newEpoch }
      } catch (err) {
        if (err instanceof EpochConflictError) {
          return reply.status(409).send({ error: 'epoch_conflict', currentEpoch: err.currentEpoch })
        }
        throw err
      }
    },
  )

  app.get<{ Params: { groupId: string } }>(
    '/api/v1/mls/groups/:groupId/messages',
    { preHandler: authenticate },
    async (request) => {
      const session = requireSession(request)
      const query = messagesQuerySchema.parse(request.query)
      return {
        messages: await listMessages(db, session.accountId, request.params.groupId, query.after),
      }
    },
  )

  app.get('/api/v1/mls/welcomes', { preHandler: authenticate }, async (request) => {
    const session = requireSession(request)
    return { welcomes: await listWelcomes(db, session.deviceId) }
  })
}
