import type { DeviceId, GroupId } from '@gathernet/shared'
import { ROOM_EPHEMERAL_BURST, ROOM_EPHEMERAL_RATE_PER_SEC } from '@gathernet/shared'
import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { groupMembers, groups } from '../../db/schema.ts'
import type { WsMessageHandler, WsSession } from '../../ws/gateway.ts'
import type { ConnectionRegistry } from '../../ws/registry.ts'

/**
 * `room.ephemeral`: fire-and-forget fan-out of opaque payloads (cursor,
 * pointer, typing …) to the online MLS member devices of a room group.
 * Never persisted, never sequenced.
 *
 * Guard rails:
 * - membership checked against active group_members, cached per socket with
 *   a 30s TTL (max 100 groups) — a kicked device keeps relaying for at most
 *   the TTL, until its MLS leaf removal lands;
 * - per-session token bucket (ROOM_EPHEMERAL_RATE_PER_SEC steady,
 *   ROOM_EPHEMERAL_BURST burst); over-budget frames get an error reply and
 *   are dropped.
 */

const MEMBERSHIP_TTL_MS = 30_000
const MEMBERSHIP_CACHE_MAX = 100

interface CacheEntry {
  /** null → not an active member of a room group */
  recipients: string[] | null
  expiresAt: number
}

interface EphemeralState {
  tokens: number
  lastRefillMs: number
  membership: Map<string, CacheEntry>
}

export function makeRoomEphemeralHandler(db: Db, registry: ConnectionRegistry): WsMessageHandler {
  const states = new WeakMap<WsSession, EphemeralState>()

  const stateOf = (session: WsSession): EphemeralState => {
    let state = states.get(session)
    if (!state) {
      state = { tokens: ROOM_EPHEMERAL_BURST, lastRefillMs: Date.now(), membership: new Map() }
      states.set(session, state)
    }
    return state
  }

  const takeToken = (state: EphemeralState): boolean => {
    const now = Date.now()
    const refill = ((now - state.lastRefillMs) / 1000) * ROOM_EPHEMERAL_RATE_PER_SEC
    state.tokens = Math.min(ROOM_EPHEMERAL_BURST, state.tokens + refill)
    state.lastRefillMs = now
    if (state.tokens < 1) return false
    state.tokens -= 1
    return true
  }

  const recipientsFor = async (
    state: EphemeralState,
    session: WsSession,
    groupId: string,
  ): Promise<string[] | null> => {
    const cached = state.membership.get(groupId)
    if (cached && cached.expiresAt > Date.now()) return cached.recipients

    const group = await db.query.groups.findFirst({ where: eq(groups.groupId, groupId) })
    let recipients: string[] | null = null
    if (group?.kind === 'room') {
      const leaves = await db
        .select({ deviceId: groupMembers.deviceId })
        .from(groupMembers)
        .where(and(eq(groupMembers.groupId, groupId), isNull(groupMembers.removedEpoch)))
      const deviceIds = leaves.map((l) => l.deviceId)
      recipients = deviceIds.includes(session.deviceId) ? deviceIds : null
    }

    if (state.membership.size >= MEMBERSHIP_CACHE_MAX) {
      // Maps iterate in insertion order → evict the oldest entry.
      const oldest = state.membership.keys().next().value
      if (oldest !== undefined) state.membership.delete(oldest)
    }
    state.membership.set(groupId, { recipients, expiresAt: Date.now() + MEMBERSHIP_TTL_MS })
    return recipients
  }

  return async (session, message) => {
    if (message.type !== 'room.ephemeral') return
    const state = stateOf(session)
    if (!takeToken(state)) {
      session.send({ type: 'error', replyTo: message.id, payload: { code: 'rate_limited' } })
      return
    }
    const recipients = await recipientsFor(state, session, message.payload.groupId)
    if (!recipients) {
      session.send({ type: 'error', replyTo: message.id, payload: { code: 'not_a_member' } })
      return
    }
    for (const deviceId of recipients) {
      if (deviceId === session.deviceId) continue
      registry.sendToDevice(deviceId, {
        type: 'room.ephemeral',
        payload: {
          groupId: message.payload.groupId as GroupId,
          epoch: message.payload.epoch,
          senderDevice: session.deviceId as DeviceId,
          payload: message.payload.payload,
        },
      })
    }
    session.send({ type: 'ack', replyTo: message.id, payload: {} })
  }
}
