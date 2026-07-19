import {
  acceptCommunityInviteRequestSchema,
  createChannelInviteRequestSchema,
  createChannelRequestSchema,
  createCommunityInviteRequestSchema,
  createCommunityRequestSchema,
  type DeviceId,
  type GroupId,
  joinByCodeRequestSchema,
  postCommitRequestSchema,
  postKeyGrantsRequestSchema,
  publishChannelGroupInfoRequestSchema,
  resolveJoinRequestSchema,
  rotateRequestSchema,
  setMemberRoleRequestSchema,
  setModeratorRequestSchema,
  setMutedRequestSchema,
  updateChannelRequestSchema,
  updateCommunityRequestSchema,
  uploadMediaRequestSchema,
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
  createChannelInvite,
  createCommunity,
  createCommunityInvite,
  deleteChannel,
  getChannelJoinInfo,
  getCommunityDetail,
  getCommunityMedia,
  joinChannel,
  joinChannelByCode,
  kickFromChannel,
  leaveCommunity,
  listChannelMembers,
  listCommunities,
  listCommunityDevices,
  listCommunityInvites,
  myKeyGrant,
  postKeyGrants,
  publishChannelGroupInfo,
  removeMember,
  resolveJoinRequest,
  revokeCommunityInvite,
  rotateCommunity,
  setMemberRole,
  setModerator,
  setMuted,
  updateChannel,
  updateCommunity,
  uploadCommunityMedia,
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
    const body = createCommunityRequestSchema.parse(request.body ?? {})
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

  /* ------------------------------- media -------------------------------- */

  app.get<{ Params: { mediaId: string } }>(
    '/api/v1/communities/media/:mediaId',
    auth,
    async (request, reply) => {
      const session = requireSession(request)
      const bytes = await getCommunityMedia(db, session.accountId, request.params.mediaId)
      reply.header('cache-control', 'private, max-age=31536000, immutable')
      reply.type('application/octet-stream')
      return reply.send(bytes)
    },
  )

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
    await updateCommunity(db, registry, session.accountId, request.params.id, body)
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>(
    '/api/v1/communities/:id/media',
    auth,
    async (request, reply) => {
      const session = requireSession(request)
      const body = uploadMediaRequestSchema.parse(request.body)
      reply.status(201)
      return uploadCommunityMedia(db, session.accountId, request.params.id, body.ciphertext)
    },
  )

  /* ----------------------- K_meta cross-device grants --------------------- */

  app.get<{ Params: { id: string } }>('/api/v1/communities/:id/devices', auth, async (request) => {
    const session = requireSession(request)
    return listCommunityDevices(db, session.accountId, request.params.id)
  })

  app.get<{ Params: { id: string } }>(
    '/api/v1/communities/:id/key-grants/mine',
    auth,
    async (request) => {
      const session = requireSession(request)
      return myKeyGrant(db, session.accountId, session.deviceId, request.params.id)
    },
  )

  app.post<{ Params: { id: string } }>(
    '/api/v1/communities/:id/key-grants',
    auth,
    async (request) => {
      const session = requireSession(request)
      const body = postKeyGrantsRequestSchema.parse(request.body)
      await postKeyGrants(
        db,
        registry,
        session.accountId,
        request.params.id,
        body.keyEpoch,
        body.grants,
      )
      return { ok: true }
    },
  )

  app.post<{ Params: { id: string } }>('/api/v1/communities/:id/rotate', auth, async (request) => {
    const session = requireSession(request)
    const body = rotateRequestSchema.parse(request.body)
    await rotateCommunity(db, registry, session.accountId, request.params.id, body)
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
      const body = createChannelRequestSchema.parse(request.body ?? {})
      reply.status(201)
      return createChannel(db, registry, session.accountId, request.params.id, body)
    },
  )

  // Join by per-channel code — static segment precedes `:channelId`.
  app.post<{ Params: { id: string } }>(
    '/api/v1/communities/:id/channels/join-by-code',
    auth,
    async (request) => {
      const session = requireSession(request)
      const body = joinByCodeRequestSchema.parse(request.body)
      return joinChannelByCode(db, registry, session.accountId, request.params.id, body.code)
    },
  )

  app.patch<{ Params: { id: string; channelId: string } }>(
    '/api/v1/communities/:id/channels/:channelId',
    auth,
    async (request) => {
      const session = requireSession(request)
      const body = updateChannelRequestSchema.parse(request.body)
      await updateChannel(
        db,
        registry,
        session.accountId,
        request.params.id,
        request.params.channelId,
        body,
      )
      return { ok: true }
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

  app.post<{ Params: { id: string; channelId: string } }>(
    '/api/v1/communities/:id/channels/:channelId/join',
    auth,
    async (request) => {
      const session = requireSession(request)
      return joinChannel(
        db,
        registry,
        session.accountId,
        request.params.id,
        request.params.channelId,
      )
    },
  )

  app.get<{ Params: { id: string; channelId: string } }>(
    '/api/v1/communities/:id/channels/:channelId/members',
    auth,
    async (request) => {
      const session = requireSession(request)
      const members = await listChannelMembers(
        db,
        session.accountId,
        request.params.id,
        request.params.channelId,
      )
      return { members }
    },
  )

  app.post<{ Params: { id: string; channelId: string; accountId: string } }>(
    '/api/v1/communities/:id/channels/:channelId/requests/:accountId',
    auth,
    async (request) => {
      const session = requireSession(request)
      const body = resolveJoinRequestSchema.parse(request.body)
      await resolveJoinRequest(
        db,
        registry,
        session.accountId,
        request.params.id,
        request.params.channelId,
        request.params.accountId,
        body.action,
      )
      return { ok: true }
    },
  )

  app.post<{ Params: { id: string; channelId: string } }>(
    '/api/v1/communities/:id/channels/:channelId/invites',
    auth,
    async (request, reply) => {
      const session = requireSession(request)
      const body = createChannelInviteRequestSchema.parse(request.body)
      reply.status(201)
      return createChannelInvite(
        db,
        registry,
        session.accountId,
        request.params.id,
        request.params.channelId,
        body,
      )
    },
  )

  app.post<{ Params: { id: string; channelId: string; accountId: string } }>(
    '/api/v1/communities/:id/channels/:channelId/moderators/:accountId',
    auth,
    async (request) => {
      const session = requireSession(request)
      const body = setModeratorRequestSchema.parse(request.body)
      await setModerator(
        db,
        registry,
        session.accountId,
        request.params.id,
        request.params.channelId,
        request.params.accountId,
        body.action,
      )
      return { ok: true }
    },
  )

  app.post<{ Params: { id: string; channelId: string; accountId: string } }>(
    '/api/v1/communities/:id/channels/:channelId/mute/:accountId',
    auth,
    async (request) => {
      const session = requireSession(request)
      const body = setMutedRequestSchema.parse(request.body)
      await setMuted(
        db,
        registry,
        session.accountId,
        request.params.id,
        request.params.channelId,
        request.params.accountId,
        body.muted,
      )
      return { ok: true }
    },
  )

  app.post<{ Params: { id: string; channelId: string; accountId: string } }>(
    '/api/v1/communities/:id/channels/:channelId/kick/:accountId',
    auth,
    async (request) => {
      const session = requireSession(request)
      await kickFromChannel(
        db,
        registry,
        session.accountId,
        request.params.id,
        request.params.channelId,
        request.params.accountId,
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
