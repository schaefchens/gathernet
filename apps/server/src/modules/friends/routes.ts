import {
  type AccountId,
  acceptInviteRequestSchema,
  createInviteRequestSchema,
} from '@gathernet/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../../db/index.ts'
import type { ConnectionRegistry } from '../../ws/registry.ts'
import { ServiceError } from '../accounts/service.ts'
import {
  acceptInvite,
  blockAccount,
  createInvite,
  listFriends,
  listInvites,
  removeFriend,
  revokeInvite,
  unblockAccount,
} from './service.ts'

export interface FriendRoutesOptions {
  db: Db
  registry: ConnectionRegistry
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
  /** Stage 6 hook: called after a friendship forms, to create the MLS group. */
  onFriendshipCreated?: (inviterAccountId: string, accepterAccountId: string) => Promise<void>
}

function requireSession(request: FastifyRequest) {
  const session = request.session
  if (!session) throw new ServiceError(401, 'unauthorized')
  return session
}

export function registerFriendRoutes(
  app: FastifyInstance,
  { db, registry, authenticate, onFriendshipCreated }: FriendRoutesOptions,
): void {
  app.post('/api/v1/friends/invites', { preHandler: authenticate }, async (request, reply) => {
    const session = requireSession(request)
    const body = createInviteRequestSchema.parse(request.body ?? {})
    reply.status(201)
    return createInvite(db, session.accountId, body)
  })

  app.get('/api/v1/friends/invites', { preHandler: authenticate }, async (request) => {
    const session = requireSession(request)
    return { invites: await listInvites(db, session.accountId) }
  })

  app.delete<{ Params: { inviteId: string } }>(
    '/api/v1/friends/invites/:inviteId',
    { preHandler: authenticate },
    async (request) => {
      const session = requireSession(request)
      await revokeInvite(db, session.accountId, request.params.inviteId)
      return { ok: true }
    },
  )

  app.post('/api/v1/friends/invites/accept', { preHandler: authenticate }, async (request) => {
    const session = requireSession(request)
    const body = acceptInviteRequestSchema.parse(request.body)
    const result = await acceptInvite(db, session.accountId, body.code)

    registry.sendToAccount(result.inviter.accountId, {
      type: 'friend.added',
      payload: {
        accountId: result.accepter.accountId as AccountId,
        displayName: result.accepter.displayName,
      },
    })
    registry.sendToAccount(result.accepter.accountId, {
      type: 'friend.added',
      payload: {
        accountId: result.inviter.accountId as AccountId,
        displayName: result.inviter.displayName,
      },
    })
    await onFriendshipCreated?.(result.inviter.accountId, result.accepter.accountId)

    return { friend: { ...result.inviter, since: Date.now() } }
  })

  app.get('/api/v1/friends', { preHandler: authenticate }, async (request) => {
    const session = requireSession(request)
    return { friends: await listFriends(db, session.accountId) }
  })

  app.delete<{ Params: { accountId: string } }>(
    '/api/v1/friends/:accountId',
    { preHandler: authenticate },
    async (request) => {
      const session = requireSession(request)
      const removed = await removeFriend(db, session.accountId, request.params.accountId)
      if (!removed) throw new ServiceError(404, 'not_friends')
      notifyRemoved(registry, session.accountId, request.params.accountId)
      return { ok: true }
    },
  )

  app.post<{ Params: { accountId: string } }>(
    '/api/v1/friends/:accountId/block',
    { preHandler: authenticate },
    async (request) => {
      const session = requireSession(request)
      const removedFriendship = await blockAccount(db, session.accountId, request.params.accountId)
      if (removedFriendship) {
        notifyRemoved(registry, session.accountId, request.params.accountId)
      }
      return { ok: true }
    },
  )

  app.delete<{ Params: { accountId: string } }>(
    '/api/v1/friends/:accountId/block',
    { preHandler: authenticate },
    async (request) => {
      const session = requireSession(request)
      await unblockAccount(db, session.accountId, request.params.accountId)
      return { ok: true }
    },
  )
}

function notifyRemoved(registry: ConnectionRegistry, a: string, b: string): void {
  registry.sendToAccount(a, { type: 'friend.removed', payload: { accountId: b as AccountId } })
  registry.sendToAccount(b, { type: 'friend.removed', payload: { accountId: a as AccountId } })
}
