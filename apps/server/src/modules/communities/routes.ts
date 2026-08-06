import {
  acceptCommunityInviteRequestSchema,
  approveArtifactRequestSchema,
  createChannelInviteRequestSchema,
  createChannelRequestSchema,
  createCommunityInviteRequestSchema,
  createCommunityRequestSchema,
  type DeviceId,
  deleteTicketRequestSchema,
  type GroupId,
  joinByCodeRequestSchema,
  paginationQuerySchema,
  postArtifactRequestSchema,
  postCapabilitiesRequestSchema,
  postChannelKeyGrantsRequestSchema,
  postCommitRequestSchema,
  postKeyGrantsRequestSchema,
  postReportRequestSchema,
  postTicketRequestSchema,
  publishChannelGroupInfoRequestSchema,
  reminderTriggerRequestSchema,
  resolveJoinRequestSchema,
  resolveReportRequestSchema,
  rotateChannelRequestSchema,
  rotateRequestSchema,
  setCommunityRootRequestSchema,
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
import type { BlobStore } from '../../storage/blob-store.ts'
import type { ConnectionRegistry } from '../../ws/registry.ts'
import { ServiceError } from '../accounts/service.ts'
import { EpochConflictError, postCommit } from '../delivery/service.ts'
import {
  acceptCommunityInvite,
  approveArtifact,
  channelCommunityId,
  createChannel,
  createChannelInvite,
  createCommunity,
  createCommunityInvite,
  deleteArtifact,
  deleteChannel,
  deleteTicket,
  getCapability,
  getChannelJoinInfo,
  getCommunityDetail,
  getCommunityDevice,
  getCommunityMedia,
  joinChannel,
  joinChannelByCode,
  kickFromChannel,
  leaveCommunity,
  listArtifacts,
  listChannelDevices,
  listChannelMembers,
  listCommunities,
  listCommunityDevices,
  listCommunityInvites,
  listCommunityMemberIds,
  listCommunityMembers,
  listModerationRecipients,
  listReports,
  moderationRemoveMessage,
  myCapabilities,
  myChannelKeyGrant,
  myKeyGrant,
  postArtifact,
  postCapabilities,
  postChannelKeyGrants,
  postKeyGrants,
  postReport,
  postTicket,
  publishChannelGroupInfo,
  removeMember,
  resolveJoinRequest,
  resolveReport,
  revokeCommunityInvite,
  rotateChannel,
  rotateCommunity,
  setCommunityRoot,
  setMemberRole,
  setModerator,
  setMuted,
  triggerChannelReminder,
  updateChannel,
  updateCommunity,
  uploadCommunityMedia,
} from './service.ts'

export interface CommunityRoutesOptions {
  db: Db
  registry: ConnectionRegistry
  blobStore: BlobStore
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
}

function requireSession(request: FastifyRequest) {
  const session = request.session
  if (!session) throw new ServiceError(401, 'unauthorized')
  return session
}

/** Channel MLS commits carry the committing device explicitly. */
const channelCommitSchema = postCommitRequestSchema.extend({ deviceId: z.string() })

/** Query for a single capability lookup (chain-walk): scope + subject account. */
const capabilityQuerySchema = z.object({
  scope: z.string().min(1).max(64),
  account: z.string().min(1),
})

export function registerCommunityRoutes(
  app: FastifyInstance,
  { db, registry, blobStore, authenticate }: CommunityRoutesOptions,
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
      const bytes = await getCommunityMedia(
        db,
        blobStore,
        session.accountId,
        request.params.mediaId,
      )
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

  app.get<{ Params: { id: string } }>('/api/v1/communities/:id/members', auth, async (request) => {
    const session = requireSession(request)
    const { after, limit } = paginationQuerySchema.parse(request.query)
    return listCommunityMembers(db, session.accountId, request.params.id, after, limit)
  })

  // Member IDs only (no display names) — owner/leader, any community size. Capability
  // issuance sweeps this so minting caps never materialises a browsable roster.
  app.get<{ Params: { id: string } }>(
    '/api/v1/communities/:id/member-ids',
    auth,
    async (request) => {
      const session = requireSession(request)
      const { after, limit } = paginationQuerySchema.parse(request.query)
      return listCommunityMemberIds(db, session.accountId, request.params.id, after, limit)
    },
  )

  app.patch<{ Params: { id: string } }>('/api/v1/communities/:id', auth, async (request) => {
    const session = requireSession(request)
    const body = updateCommunityRequestSchema.parse(request.body)
    await updateCommunity(db, registry, session.accountId, request.params.id, body)
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/api/v1/communities/:id/root', auth, async (request) => {
    const session = requireSession(request)
    const body = setCommunityRootRequestSchema.parse(request.body)
    await setCommunityRoot(
      db,
      session.accountId,
      request.params.id,
      body.ownerDeviceId,
      body.ownerSig,
    )
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>(
    '/api/v1/communities/:id/media',
    auth,
    async (request, reply) => {
      const session = requireSession(request)
      const body = uploadMediaRequestSchema.parse(request.body)
      reply.status(201)
      return uploadCommunityMedia(
        db,
        blobStore,
        session.accountId,
        request.params.id,
        body.ciphertext,
      )
    },
  )

  /* ----------------------- K_meta cross-device grants --------------------- */

  app.get<{ Params: { id: string } }>('/api/v1/communities/:id/devices', auth, async (request) => {
    const session = requireSession(request)
    const { after, limit } = paginationQuerySchema.parse(request.query)
    return listCommunityDevices(db, session.accountId, request.params.id, after, limit)
  })

  app.get<{ Params: { id: string; deviceId: string } }>(
    '/api/v1/communities/:id/devices/:deviceId',
    auth,
    async (request) => {
      const session = requireSession(request)
      return getCommunityDevice(db, session.accountId, request.params.id, request.params.deviceId)
    },
  )

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
      await postKeyGrants(db, registry, session.accountId, request.params.id, body)
      return { ok: true }
    },
  )

  app.post<{ Params: { id: string } }>('/api/v1/communities/:id/rotate', auth, async (request) => {
    const session = requireSession(request)
    const body = rotateRequestSchema.parse(request.body)
    await rotateCommunity(db, registry, blobStore, session.accountId, request.params.id, body)
    return { ok: true }
  })

  /* --------------------- membership capabilities (relayed) --------------------- */

  app.post<{ Params: { id: string } }>(
    '/api/v1/communities/:id/capabilities',
    auth,
    async (request) => {
      const session = requireSession(request)
      const body = postCapabilitiesRequestSchema.parse(request.body)
      await postCapabilities(db, session.accountId, request.params.id, body)
      return { ok: true }
    },
  )

  app.get<{ Params: { id: string } }>(
    '/api/v1/communities/:id/capabilities/mine',
    auth,
    async (request) => {
      const session = requireSession(request)
      return myCapabilities(db, session.accountId, request.params.id)
    },
  )

  app.get<{ Params: { id: string }; Querystring: { scope?: string; account?: string } }>(
    '/api/v1/communities/:id/capabilities',
    auth,
    async (request) => {
      const session = requireSession(request)
      const { scope, account } = capabilityQuerySchema.parse(request.query)
      return getCapability(db, session.accountId, request.params.id, scope, account)
    },
  )

  /* ------------------- K_channel (group_key) grants --------------------- */

  app.get<{ Params: { id: string; channelId: string } }>(
    '/api/v1/communities/:id/channels/:channelId/devices',
    auth,
    async (request) => {
      const session = requireSession(request)
      const { after, limit } = paginationQuerySchema.parse(request.query)
      return listChannelDevices(
        db,
        session.accountId,
        request.params.id,
        request.params.channelId,
        after,
        limit,
      )
    },
  )

  app.get<{ Params: { id: string; channelId: string } }>(
    '/api/v1/communities/:id/channels/:channelId/key-grants/mine',
    auth,
    async (request) => {
      const session = requireSession(request)
      return myChannelKeyGrant(
        db,
        session.accountId,
        session.deviceId,
        request.params.id,
        request.params.channelId,
      )
    },
  )

  app.post<{ Params: { id: string; channelId: string } }>(
    '/api/v1/communities/:id/channels/:channelId/key-grants',
    auth,
    async (request) => {
      const session = requireSession(request)
      const body = postChannelKeyGrantsRequestSchema.parse(request.body)
      await postChannelKeyGrants(
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

  app.post<{ Params: { id: string; channelId: string } }>(
    '/api/v1/communities/:id/channels/:channelId/rotate',
    auth,
    async (request) => {
      const session = requireSession(request)
      const body = rotateChannelRequestSchema.parse(request.body)
      await rotateChannel(
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

  /* ------------------- pinned channel artifacts (relayed) ------------------- */

  app.get<{ Params: { id: string; channelId: string } }>(
    '/api/v1/communities/:id/channels/:channelId/artifacts',
    auth,
    async (request) => {
      const session = requireSession(request)
      return listArtifacts(db, session.accountId, request.params.id, request.params.channelId)
    },
  )

  app.post<{ Params: { id: string; channelId: string } }>(
    '/api/v1/communities/:id/channels/:channelId/artifacts',
    auth,
    async (request) => {
      const session = requireSession(request)
      const body = postArtifactRequestSchema.parse(request.body)
      await postArtifact(
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

  app.post<{ Params: { id: string; channelId: string; artifactId: string } }>(
    '/api/v1/communities/:id/channels/:channelId/artifacts/:artifactId/approve',
    auth,
    async (request) => {
      const session = requireSession(request)
      const body = approveArtifactRequestSchema.parse(request.body)
      await approveArtifact(
        db,
        registry,
        session.accountId,
        request.params.id,
        request.params.channelId,
        request.params.artifactId,
        body,
      )
      return { ok: true }
    },
  )

  app.delete<{ Params: { id: string; channelId: string; artifactId: string } }>(
    '/api/v1/communities/:id/channels/:channelId/artifacts/:artifactId',
    auth,
    async (request) => {
      const session = requireSession(request)
      await deleteArtifact(
        db,
        registry,
        session.accountId,
        request.params.id,
        request.params.channelId,
        request.params.artifactId,
      )
      return { ok: true }
    },
  )

  app.post<{ Params: { id: string; channelId: string; artifactId: string } }>(
    '/api/v1/communities/:id/channels/:channelId/artifacts/:artifactId/ticket',
    auth,
    async (request) => {
      const session = requireSession(request)
      const body = postTicketRequestSchema.parse(request.body)
      await postTicket(
        db,
        registry,
        session.accountId,
        request.params.id,
        request.params.channelId,
        request.params.artifactId,
        body,
      )
      return { ok: true }
    },
  )

  app.delete<{ Params: { id: string; channelId: string; artifactId: string } }>(
    '/api/v1/communities/:id/channels/:channelId/artifacts/:artifactId/ticket',
    auth,
    async (request) => {
      const session = requireSession(request)
      const body = deleteTicketRequestSchema.parse(request.body)
      await deleteTicket(
        db,
        registry,
        session.accountId,
        request.params.id,
        request.params.channelId,
        request.params.artifactId,
        body,
      )
      return { ok: true }
    },
  )

  // Peer-triggered event reminder: a member's client (online at reminder time) fires this;
  // the server relays a content-free push to offline RSVP'd members. No time is stored.
  app.post<{ Params: { id: string; channelId: string; artifactId: string } }>(
    '/api/v1/communities/:id/channels/:channelId/artifacts/:artifactId/reminder-trigger',
    auth,
    async (request) => {
      const session = requireSession(request)
      const body = reminderTriggerRequestSchema.parse(request.body)
      return triggerChannelReminder(
        db,
        registry,
        session.accountId,
        request.params.id,
        request.params.channelId,
        request.params.artifactId,
        body,
      )
    },
  )

  /* ------------------------ message reports (E2EE, mod-only) ---------------- */

  // The channel's mod/leader devices a report may be sealed to (a reporter's client
  // ECIES-seals to each). Any active community member may fetch it to file a report.
  app.get<{ Params: { id: string; channelId: string } }>(
    '/api/v1/communities/:id/channels/:channelId/moderation-recipients',
    auth,
    async (request) => {
      const session = requireSession(request)
      return listModerationRecipients(
        db,
        session.accountId,
        request.params.id,
        request.params.channelId,
      )
    },
  )

  app.post<{ Params: { id: string; channelId: string } }>(
    '/api/v1/communities/:id/channels/:channelId/reports',
    auth,
    async (request) => {
      const session = requireSession(request)
      const body = postReportRequestSchema.parse(request.body)
      await postReport(
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

  app.get<{ Params: { id: string; channelId: string } }>(
    '/api/v1/communities/:id/channels/:channelId/reports',
    auth,
    async (request) => {
      const session = requireSession(request)
      return listReports(db, session.accountId, request.params.id, request.params.channelId)
    },
  )

  app.patch<{ Params: { id: string; channelId: string; reportId: string } }>(
    '/api/v1/communities/:id/channels/:channelId/reports/:reportId',
    auth,
    async (request) => {
      const session = requireSession(request)
      const body = resolveReportRequestSchema.parse(request.body)
      await resolveReport(
        db,
        session.accountId,
        request.params.id,
        request.params.channelId,
        request.params.reportId,
        body,
      )
      return { ok: true }
    },
  )

  // Moderator removes a message for everyone (hard-delete + tombstone broadcast).
  app.delete<{ Params: { id: string; channelId: string; seq: string } }>(
    '/api/v1/communities/:id/channels/:channelId/messages/:seq',
    auth,
    async (request) => {
      const session = requireSession(request)
      const seq = Number(request.params.seq)
      if (!Number.isInteger(seq) || seq < 0) throw new ServiceError(400, 'invalid_seq')
      await moderationRemoveMessage(
        db,
        registry,
        session.accountId,
        request.params.id,
        request.params.channelId,
        seq,
      )
      return { ok: true }
    },
  )

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
      const { after, limit } = paginationQuerySchema.parse(request.query)
      return listChannelMembers(
        db,
        session.accountId,
        request.params.id,
        request.params.channelId,
        after,
        limit,
      )
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
