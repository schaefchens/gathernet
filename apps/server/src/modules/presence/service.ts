import type { AccountId, ServerMessage } from '@gathernet/shared'
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { accounts } from '../../db/schema.ts'
import type { WsSession } from '../../ws/gateway.ts'
import type { ConnectionRegistry } from '../../ws/registry.ts'
import { friendAccountIds } from '../friends/service.ts'

export type LiveStatus = 'online' | 'away' | 'invisible'
export type EffectiveStatus = 'online' | 'away' | 'offline'

/**
 * Presence lives in memory only; Postgres stores just the account's default
 * preference. All visibility filtering happens here, server-side — the
 * client is never trusted to hide "invisible" itself.
 *
 * Single-node by design for M1. Multi-node later replaces the direct
 * registry fan-out with a bus carrying the same PresenceEvent shape.
 */
export class PresenceService {
  private live = new Map<string, LiveStatus>()

  constructor(
    private readonly db: Db,
    private readonly registry: ConnectionRegistry,
  ) {}

  effectiveStatus(accountId: string): EffectiveStatus {
    if (!this.registry.isAccountOnline(accountId)) return 'offline'
    const status = this.live.get(accountId) ?? 'online'
    return status === 'invisible' ? 'offline' : status
  }

  async onConnect(session: WsSession): Promise<void> {
    // Called after the registry already contains this socket, so "came
    // online" is detected by this being the account's first socket.
    const firstSocket = this.registry.socketCount(session.accountId) === 1
    if (!this.live.has(session.accountId)) {
      const account = await this.db.query.accounts.findFirst({
        where: eq(accounts.accountId, session.accountId),
      })
      this.live.set(session.accountId, account?.presencePref ?? 'online')
    }

    // Snapshot of all friends to the connecting device.
    const friends = await friendAccountIds(this.db, session.accountId)
    session.send({
      type: 'presence.snapshot',
      payload: {
        friends: friends.map((accountId) => ({
          accountId: accountId as AccountId,
          status: this.effectiveStatus(accountId),
        })),
      },
    })

    // First socket and visible → announce to friends. An invisible default
    // pref stays silent: friends saw offline before and still do.
    const nowVisible = this.effectiveStatus(session.accountId)
    if (firstSocket && nowVisible !== 'offline') {
      await this.broadcast(session.accountId, nowVisible, friends)
    }
  }

  async onDisconnect(session: WsSession): Promise<void> {
    if (this.registry.isAccountOnline(session.accountId)) return
    const hadStatus = this.live.get(session.accountId)
    this.live.delete(session.accountId)
    // Was invisible → friends already saw offline; nothing changes for them.
    if (hadStatus === 'invisible') return
    await this.broadcast(session.accountId, 'offline')
  }

  async set(session: WsSession, status: LiveStatus): Promise<void> {
    const before = this.effectiveStatus(session.accountId)
    this.live.set(session.accountId, status)
    const after = this.effectiveStatus(session.accountId)
    // Keep the account's own other devices in sync locally? Not needed —
    // each device tracks its own selection; friends only see effective.
    if (before !== after) {
      await this.broadcast(session.accountId, after)
    }
  }

  private async broadcast(
    accountId: string,
    status: EffectiveStatus,
    friends?: string[],
  ): Promise<void> {
    const targets = friends ?? (await friendAccountIds(this.db, accountId))
    const message: ServerMessage = {
      type: 'presence.update',
      payload: { accountId: accountId as AccountId, status },
    }
    for (const friendId of targets) {
      this.registry.sendToAccount(friendId, message)
    }
  }
}
