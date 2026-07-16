import {
  acceptCommunityInviteRequestSchema,
  createChannelRequestSchema,
  createCommunityInviteRequestSchema,
  createCommunityRequestSchema,
  type DeviceId,
  type GroupId,
  postCommitRequestSchema,
  publishChannelGroupInfoRequestSchema,
  setMemberRoleRequestSchema,
  updateCommunityRequestSchema,
} from '@gathernet/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db } from '../../db/index.ts'
import type { ConnectionRegistry } from '../../ws/registry.ts'
import { ServiceError } from '../accounts/service.ts'
import { EpochConflictError, postCommit } from '../delivery/service.ts'
import {
  acceptCommunityInvite,
  channelCommunityId,
  createChannel,
  createCommunity,
  createCommunityInvite,
  deleteChannel,
  getChannelJoinInfo,
  getCommunityDetail,
  leaveCommunity,
  listCommunities,
  listCommunityInvites,
  publishChannelGroupInfo,
  removeMember,
  revokeCommunityInvite,
  setMemberRole,
  updateCommunity,
} from './service.ts'

export interface CommunityRoutesOptions {
  db: Db
  registry: ConnectionRegistry
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
}

function requireSession(request: FastifyRequest) {
  const session = request.session
  if (!session) throw new ServiceError(401, 'unauthorized')
  return session
}

/** Channel MLS commits carry the committing device explicitly. */
const channelCommitSchema = postCommitRequestSchema.extend({ deviceId: z.string() })

export function registerCommunityRoutes(
  app: FastifyInstance,
  { db, registry, authenticate }: CommunityRoutesOptions,
): void {
  const auth = { preHandler: authenticate }

  app.post('/api/v1/communities', auth, async (request, reply) => {
    const session = requireSession(request)
    const body = createCommunityRequestSchema.parse(request.body)
    reply.status(201)
    return createCommunity(db, session.accountId, body)
  })

  app.get('/api/v1/communities', auth, async (request) => {
    const session = requireSession(request)
    return { communities: await listCommunities(db, session.accountId) }
  })

  // Invite accept — static path, must precede `/:id` matching semantically
  // (Fastify's radix tree already prefers static segments).
  app.post('/api/v1/communities/invites/accept', auth, async (request) => {
    const session = requireSession(request)
    const body = acceptCommunityInviteRequestSchema.parse(request.body)
    return acceptCommunityInvite(db, registry, session.accountId, body.code)
  })

  /* ------------------------------ channels ------------------------------ */

  app.post<{ Params: { channelId: string } }>(
    '/api/v1/communities/channels/:channelId/group-info',
    auth,
    async (request) => {
      const session = requireSession(request)
      const body = publishChannelGroupInfoRequestSchema.parse(request.body)
      await publishChannelGroupInfo(
        db,
        session.accountId,
        request.params.channelId,
        body.groupInfo,
        body.deviceId,
      )
      return { ok: true }
    },
  )

  app.post<{ Params: { channelId: string } }>(
    '/api/v1/communities/channels/:channelId/commits',
    auth,
    async (request, reply) => {
      const session = requireSession(request)
      const body = channelCommitSchema.parse(request.body)
      if (body.deviceId !== session.deviceId) throw new ServiceError(400, 'device_mismatch')
      const channelId = request.params.channelId
      if (!(await channelCommunityId(db, channelId))) {
        throw new ServiceError(404, 'channel_not_found')
      }
      try {
        const fanout = await postCommit(db, session.accountId, session.deviceId, channelId, body)
        for (const recipient of fanout.commitRecipients) {
          registry.sendToDevice(recipient, {
            type: 'chat.message',
            payload: {
              groupId: channelId as GroupId,
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
              groupId: channelId as GroupId,
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

  app.get<{ Params: { channelId: string } }>(
    '/api/v1/communities/channels/:channelId',
    auth,
    async (request) => {
      const session = requireSession(request)
      return getChannelJoinInfo(db, session.accountId, request.params.channelId)
    },
  )

  /* ---------------------------- community by id --------------------------- */

  app.get<{ Params: { id: string } }>('/api/v1/communities/:id', auth, async (request) => {
    const session = requireSession(request)
    return getCommunityDetail(db, session.accountId, request.params.id)
  })

  app.patch<{ Params: { id: string } }>('/api/v1/communities/:id', auth, async (request) => {
    const session = requireSession(request)
    const body = updateCommunityRequestSchema.parse(request.body)
    await updateCommunity(db, session.accountId, request.params.id, body)
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>(
    '/api/v1/communities/:id/invites',
    auth,
    async (request, reply) => {
      const session = requireSession(request)
      const body = createCommunityInviteRequestSchema.parse(request.body ?? {})
      reply.status(201)
      return createCommunityInvite(db, session.accountId, request.params.id, body)
    },
  )

  app.get<{ Params: { id: string } }>('/api/v1/communities/:id/invites', auth, async (request) => {
    const session = requireSession(request)
    return { invites: await listCommunityInvites(db, session.accountId, request.params.id) }
  })

  app.delete<{ Params: { id: string; inviteId: string } }>(
    '/api/v1/communities/:id/invites/:inviteId',
    auth,
    async (request) => {
      const session = requireSession(request)
      await revokeCommunityInvite(db, session.accountId, request.params.id, request.params.inviteId)
      return { ok: true }
    },
  )

  app.post<{ Params: { id: string } }>(
    '/api/v1/communities/:id/channels',
    auth,
    async (request, reply) => {
      const session = requireSession(request)
      const body = createChannelRequestSchema.parse(request.body)
      reply.status(201)
      return createChannel(db, registry, session.accountId, request.params.id, body)
    },
  )

  app.delete<{ Params: { id: string; channelId: string } }>(
    '/api/v1/communities/:id/channels/:channelId',
    auth,
    async (request) => {
      const session = requireSession(request)
      await deleteChannel(
        db,
        registry,
        session.accountId,
        request.params.id,
        request.params.channelId,
      )
      return { ok: true }
    },
  )

  app.post<{ Params: { id: string; accountId: string } }>(
    '/api/v1/communities/:id/members/:accountId/role',
    auth,
    async (request) => {
      const session = requireSession(request)
      const body = setMemberRoleRequestSchema.parse(request.body)
      await setMemberRole(
        db,
        registry,
        session.accountId,
        request.params.id,
        request.params.accountId,
        body.role,
      )
      return { ok: true }
    },
  )

  app.post<{ Params: { id: string; accountId: string } }>(
    '/api/v1/communities/:id/members/:accountId/remove',
    auth,
    async (request) => {
      const session = requireSession(request)
      await removeMember(
        db,
        registry,
        session.accountId,
        request.params.id,
        request.params.accountId,
      )
      return { ok: true }
    },
  )

  app.post<{ Params: { id: string } }>('/api/v1/communities/:id/leave', auth, async (request) => {
    const session = requireSession(request)
    await leaveCommunity(db, registry, session.accountId, request.params.id)
    return { ok: true }
  })
}
