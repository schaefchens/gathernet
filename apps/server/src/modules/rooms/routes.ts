import {
  createRoomRequestSchema,
  type DeviceId,
  type GroupId,
  joinRoomRequestSchema,
  kickRoomMemberRequestSchema,
  postCommitRequestSchema,
  publishRoomGroupInfoRequestSchema,
  registerAppDeviceRequestSchema,
  resolveRoomJoinRequestSchema,
  setRoomPhaseRequestSchema,
} from '@gathernet/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db } from '../../db/index.ts'
import type { ConnectionRegistry } from '../../ws/registry.ts'
import { ServiceError } from '../accounts/service.ts'
import { EpochConflictError, postCommit } from '../delivery/service.ts'
import {
  closeRoom,
  createRoom,
  getRoomDetail,
  joinRoom,
  kickMember,
  leaveRoom,
  listJoinRequests,
  listPublicRooms,
  publishGroupInfo,
  registerAppDevice,
  requireOwnAppDevice,
  resolveJoinRequest,
  setPhase,
} from './service.ts'

export interface RoomRoutesOptions {
  db: Db
  registry: ConnectionRegistry
  /** app-session auth factory (per-scope), from plugins/app-auth.ts */
  appAuthenticate: (
    scope?: 'identity' | 'storage' | 'rooms',
  ) => (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
}

function requireAppSession(request: FastifyRequest) {
  const session = request.appSession
  if (!session) throw new ServiceError(401, 'unauthorized')
  return session
}

/** All rooms endpoints ride the app-token surface with scope 'rooms'. */
export function registerRoomRoutes(
  app: FastifyInstance,
  { db, registry, appAuthenticate }: RoomRoutesOptions,
): void {
  const auth = { preHandler: appAuthenticate('rooms') }

  app.post('/api/v1/app/devices', auth, async (request, reply) => {
    const session = requireAppSession(request)
    const body = registerAppDeviceRequestSchema.parse(request.body)
    const result = await registerAppDevice(db, session, body.devicePk, body.name)
    reply.status(201)
    return result
  })

  app.post('/api/v1/app/rooms', auth, async (request, reply) => {
    const session = requireAppSession(request)
    const body = createRoomRequestSchema.parse(request.body)
    const result = await createRoom(db, session, body)
    reply.status(201)
    return result
  })

  app.get('/api/v1/app/rooms', auth, async (request) => {
    const session = requireAppSession(request)
    return { rooms: await listPublicRooms(db, session.appId) }
  })

  app.post('/api/v1/app/rooms/join', auth, async (request) => {
    const session = requireAppSession(request)
    const body = joinRoomRequestSchema.parse(request.body)
    return joinRoom(db, registry, session, body)
  })

  // MLS commits for room groups over the app surface (external join, add,
  // remove). The committing app device is named in the body; postCommit's
  // room branch authorizes it against active room membership.
  const roomCommitSchema = postCommitRequestSchema.extend({ deviceId: z.string() })
  app.post<{ Params: { roomId: string } }>(
    '/api/v1/app/rooms/:roomId/commits',
    auth,
    async (request, reply) => {
      const session = requireAppSession(request)
      const body = roomCommitSchema.parse(request.body)
      // The committer device must belong to THIS caller's (app, account) —
      // never trust a client-supplied deviceId to name someone else's leaf.
      await requireOwnAppDevice(db, session, body.deviceId)
      try {
        const fanout = await postCommit(
          db,
          session.accountId,
          body.deviceId,
          request.params.roomId,
          body,
        )
        for (const recipient of fanout.commitRecipients) {
          registry.sendToDevice(recipient, {
            type: 'chat.message',
            payload: {
              groupId: request.params.roomId as GroupId,
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
              groupId: request.params.roomId as GroupId,
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

  app.post<{ Params: { roomId: string } }>(
    '/api/v1/app/rooms/:roomId/group-info',
    auth,
    async (request) => {
      const session = requireAppSession(request)
      const body = publishRoomGroupInfoRequestSchema.parse(request.body)
      await publishGroupInfo(db, session, request.params.roomId, body.groupInfo, body.deviceId)
      return { ok: true }
    },
  )

  app.get<{ Params: { roomId: string } }>('/api/v1/app/rooms/:roomId', auth, async (request) => {
    const session = requireAppSession(request)
    return getRoomDetail(db, session, request.params.roomId)
  })

  app.get<{ Params: { roomId: string } }>(
    '/api/v1/app/rooms/:roomId/requests',
    auth,
    async (request) => {
      const session = requireAppSession(request)
      return { requests: await listJoinRequests(db, session, request.params.roomId) }
    },
  )

  app.post<{ Params: { roomId: string; requestId: string } }>(
    '/api/v1/app/rooms/:roomId/requests/:requestId',
    auth,
    async (request) => {
      const session = requireAppSession(request)
      const body = resolveRoomJoinRequestSchema.parse(request.body)
      await resolveJoinRequest(
        db,
        registry,
        session,
        request.params.roomId,
        request.params.requestId,
        body.action,
      )
      return { ok: true }
    },
  )

  app.post<{ Params: { roomId: string } }>(
    '/api/v1/app/rooms/:roomId/kick',
    auth,
    async (request) => {
      const session = requireAppSession(request)
      const body = kickRoomMemberRequestSchema.parse(request.body)
      await kickMember(db, registry, session, request.params.roomId, body.appUserId)
      return { ok: true }
    },
  )

  app.post<{ Params: { roomId: string } }>(
    '/api/v1/app/rooms/:roomId/leave',
    auth,
    async (request) => {
      const session = requireAppSession(request)
      await leaveRoom(db, registry, session, request.params.roomId)
      return { ok: true }
    },
  )

  app.post<{ Params: { roomId: string } }>(
    '/api/v1/app/rooms/:roomId/phase',
    auth,
    async (request) => {
      const session = requireAppSession(request)
      const body = setRoomPhaseRequestSchema.parse(request.body)
      await setPhase(db, registry, session, request.params.roomId, body.phase)
      return { ok: true }
    },
  )

  app.post<{ Params: { roomId: string } }>(
    '/api/v1/app/rooms/:roomId/close',
    auth,
    async (request) => {
      const session = requireAppSession(request)
      await closeRoom(db, registry, session, request.params.roomId)
      return { ok: true }
    },
  )
}
