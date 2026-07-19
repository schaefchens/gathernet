import {
  b64,
  ConflictError,
  type CursorStore,
  hexToBytes,
  MlsSyncEngine,
  type SnapshotStore,
  type SyncTransport,
} from '@gathernet/mls-sync'
import type { ChannelJoinInfoResponse, CommunityListItem, MailboxMessage } from '@gathernet/shared'
import { create } from 'zustand'
import { ApiError, api } from '../lib/api.ts'
import {
  fetchKMetaGrant,
  forgetKMetaCache,
  rotateCommunity,
  syncKeyGrants,
} from '../lib/community-keys.ts'
import { type HubCrypto, loadCrypto, type MlsDeviceHandle } from '../lib/mls.ts'
import {
  channelStore,
  type DeviceRecord,
  messageStore,
  type StoredMessage,
} from '../lib/storage.ts'
import { wsClient } from '../lib/ws-client.ts'

/**
 * Per-channel readiness. A channel is `ready` once this device holds MLS
 * state for it (it created it, external-joined it, or restored it from disk).
 * `locked` marks a channel the server refuses to hand GroupInfo for (leaders
 * only). `pending` means the channel exists but its epoch-0 GroupInfo has not
 * been published yet (the creator hasn't bootstrapped it).
 */
export type ChannelStatus = 'idle' | 'joining' | 'ready' | 'locked' | 'pending' | 'error'

interface CommunityChatState {
  channels: Record<string, ChannelStatus> // by channelId
  messages: Record<string, StoredMessage[]> // by channelId
}

export const useCommunityChat = create<CommunityChatState>(() => ({ channels: {}, messages: {} }))

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/* --------- MlsSyncEngine ports — a SECOND engine, pointed at channels --------- */

/**
 * Channel snapshots live in their OWN IndexedDB store, so this engine's
 * `keys()` never returns DM groups and vice versa — the two engines share the
 * device secret but not their group sets.
 */
const snapshots: SnapshotStore = {
  get: (channelId) => channelStore.get(channelId),
  put: (channelId, snapshot) => channelStore.put(channelId, snapshot),
  delete: (channelId) => channelStore.delete(channelId),
  keys: async () => (await channelStore.keys()).map(String),
}

// A cursor namespace distinct from the DM store's `gn.cursor.*`.
const cursorKey = (channelId: string) => `gn.ccursor.${channelId}`
const cursors: CursorStore = {
  get: (channelId) => Number(localStorage.getItem(cursorKey(channelId)) ?? '0'),
  set: (channelId, seq) => localStorage.setItem(cursorKey(channelId), String(seq)),
}

/**
 * Channels share the DM mailbox/WS surface for reads and application
 * ciphertext, but commits and GroupInfo go through the community endpoints.
 * `deviceId` is threaded in so postCommit can satisfy the channel commit
 * route's `deviceId === session.deviceId` check.
 */
function makeTransport(deviceId: string): SyncTransport {
  return {
    async fetchMessages(channelId, afterSeq) {
      const { messages } = await api<{ messages: MailboxMessage[] }>(
        'GET',
        `/api/v1/mls/groups/${channelId}/messages?after=${afterSeq}`,
      )
      return messages
    },
    async postCommit(channelId, body) {
      try {
        await api('POST', `/api/v1/communities/channels/${channelId}/commits`, {
          ...body,
          deviceId,
        })
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          const current = (err.body as { currentEpoch?: unknown } | null)?.currentEpoch
          throw new ConflictError(typeof current === 'number' ? current : undefined)
        }
        throw err
      }
    },
    async fetchGroupInfo(channelId) {
      try {
        const info = await api<ChannelJoinInfoResponse>(
          'GET',
          `/api/v1/communities/channels/${channelId}`,
        )
        return { groupInfo: info.groupInfo, epoch: info.epoch }
      } catch (err) {
        // 403 channel_forbidden — no GroupInfo for us.
        if (err instanceof ApiError && err.status === 403) return null
        throw err
      }
    },
    async sendCiphertext(channelId, epoch, ciphertextB64) {
      return (await wsClient.send('chat.send', {
        groupId: channelId,
        epoch,
        ciphertext: ciphertextB64,
      })) as { seq: number }
    },
    async ackSeq(channelId, seq) {
      try {
        await wsClient.send('chat.ack', { groupId: channelId, seq })
      } catch {
        // offline — cursor makes redelivery a no-op
      }
    },
    async ackWelcome(welcomeId) {
      try {
        await wsClient.send('welcome.ack', { welcomeId })
      } catch {
        // offline — harmless duplicate later
      }
    },
  }
}

/**
 * Community-channel counterpart to the DM chat store. It owns a SEPARATE
 * MlsSyncEngine over a SEPARATE snapshot/cursor namespace, but shares the
 * device secret (same deviceId, so the server sees one device) and the same
 * `chat.message` WS stream — DM messages fall through here (no channel
 * snapshot) and channel messages fall through the DM store, so the two never
 * fight over a groupId.
 */
class CommunityChatStore {
  private crypto: HubCrypto | null = null
  private device: MlsDeviceHandle | null = null
  private record: DeviceRecord | null = null
  private engine: MlsSyncEngine | null = null
  private unsubscribes: (() => void)[] = []
  /** channelIds this device holds MLS state for (created/joined/restored). */
  private ready = new Set<string>()

  async init(record: DeviceRecord): Promise<void> {
    this.crypto = await loadCrypto()
    this.record = record
    // A device instance of our own — same credential/secret, hence same
    // deviceId, but an independent group set from the DM store's device.
    const device = this.crypto.createDevice(record.credential, record.deviceSecret)
    this.device = device
    this.engine = new MlsSyncEngine({
      device,
      deviceId: record.deviceId,
      snapshots,
      cursors,
      transport: makeTransport(record.deviceId),
      onApplication: async (message) => {
        const body = JSON.parse(decoder.decode(message.plaintext)) as { t: string; ts: number }
        const stored: StoredMessage = {
          groupId: message.groupId,
          seq: message.seq,
          senderAccountId: message.senderAccountId ?? 'unknown',
          text: body.t,
          sentAt: body.ts,
          outgoing: false,
        }
        await messageStore.put(stored)
        appendMessage(stored)
      },
    })

    // Restore channel MLS state + decrypted history.
    await this.engine.loadPersistedGroups()
    for (const channelId of this.engine.groupIds()) this.ready.add(channelId)

    const messages: Record<string, StoredMessage[]> = {}
    const channels: Record<string, ChannelStatus> = {}
    for (const key of await channelStore.keys()) {
      const channelId = String(key)
      messages[channelId] = await messageStore.list(channelId)
      channels[channelId] = 'ready'
    }
    useCommunityChat.setState({ messages, channels })

    this.unsubscribes.push(
      wsClient.on('chat.message', (m) => {
        // Only ours have a channel snapshot; the rest (DMs) no-op here.
        this.engine
          ?.processMailboxMessage({
            groupId: m.payload.groupId,
            seq: m.payload.seq,
            kind: m.payload.kind,
            epoch: m.payload.epoch,
            senderDevice: m.payload.senderDevice,
            payload: m.payload.payload,
            sentAt: m.payload.sentAt,
          })
          .catch((err) => console.error('channel work failed', m.payload.groupId, err))
      }),
      wsClient.on('hello.ok', () => {
        void this.catchUpAll()
        void this.sweepRotations()
      }),
    )

    if (wsClient.status === 'connected') {
      await this.catchUpAll()
      void this.sweepRotations()
    }
  }

  /**
   * On (re)connect, process any pending K_meta rotations for communities where
   * this account is a leader — so simply having Gathernet open on any device is
   * enough to rotate after a member left, without opening the community. Cheap:
   * one list fetch; rotation only runs where `rotationPending` is set.
   */
  private async sweepRotations(): Promise<void> {
    if (!this.record) return
    let list: { communities: CommunityListItem[] }
    try {
      list = await api<{ communities: CommunityListItem[] }>('GET', '/api/v1/communities')
    } catch {
      return
    }
    for (const c of list.communities) {
      if ((c.myRole === 'owner' || c.myRole === 'leader') && c.rotationPending) {
        await this.rotateCommunity(c.communityId)
      }
    }
  }

  reset(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    this.unsubscribes = []
    this.engine = null
    this.device = null
    this.crypto = null
    this.record = null
    this.ready = new Set()
    forgetKMetaCache()
    useCommunityChat.setState({ channels: {}, messages: {} })
  }

  /** Re-sync every channel we already hold state for (reconnect / boot). */
  private async catchUpAll(): Promise<void> {
    const engine = this.engine
    if (!engine) return
    for (const channelId of [...this.ready]) {
      await engine
        .catchUp(channelId)
        .catch((err) => console.error('channel work failed', channelId, err))
    }
  }

  private setStatus(channelId: string, status: ChannelStatus): void {
    useCommunityChat.setState((state) => ({
      channels: { ...state.channels, [channelId]: status },
    }))
  }

  /**
   * Epoch-0 channel bootstrap — the CREATOR's first act after creating the
   * channel row: build the MLS group locally (single leaf = this device) and
   * publish its GroupInfo so other members can external-join. Mirrors the
   * rooms host bootstrap, but the publish goes to the channel group-info
   * endpoint instead of a commit (the group stays at epoch 0).
   */
  async bootstrapChannel(channelId: string): Promise<void> {
    const device = this.device
    const record = this.record
    if (!device || !record) throw new Error('locked')
    if (this.ready.has(channelId)) return

    const groupIdBytes = hexToBytes(channelId)
    const { snapshot } = device.createGroup(groupIdBytes)
    // Persist BEFORE the GroupInfo leaves this device.
    await channelStore.put(channelId, snapshot)
    const groupInfo = device.currentGroupInfo(groupIdBytes)
    await api('POST', `/api/v1/communities/channels/${channelId}/group-info`, {
      groupInfo: b64(groupInfo),
      deviceId: record.deviceId,
    })
    this.ready.add(channelId)
    this.setStatus(channelId, 'ready')
    useCommunityChat.setState((state) => ({
      messages: { ...state.messages, [channelId]: state.messages[channelId] ?? [] },
    }))
  }

  /**
   * Open an ALREADY-JOINED channel for reading/writing (restore local MLS state
   * or external-join with the released GroupInfo). Idempotent. The server only
   * releases GroupInfo to active channel members, so this is called by the UI
   * for channels whose directory `myStatus` is 'active'; for others the UI shows
   * the join/request/invite affordances instead and calls `joinChannel`.
   */
  async openChannel(channelId: string): Promise<ChannelStatus> {
    const engine = this.engine
    const record = this.record
    if (!engine || !record) return 'error'
    if (this.ready.has(channelId)) {
      this.setStatus(channelId, 'ready')
      await engine.catchUp(channelId).catch(() => {})
      return 'ready'
    }

    this.setStatus(channelId, 'joining')
    let info: ChannelJoinInfoResponse
    try {
      info = await api<ChannelJoinInfoResponse>('GET', `/api/v1/communities/channels/${channelId}`)
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        this.setStatus(channelId, 'locked')
        return 'locked'
      }
      this.setStatus(channelId, 'error')
      return 'error'
    }
    return this.consumeJoinInfo(channelId, info)
  }

  /**
   * Explicit join action (open channels + invite acceptance). POSTs to the
   * channel join endpoint: the server flips us to active (open policy or
   * accepting a targeted invite) and returns GroupInfo, or leaves us 'pending'
   * (request policy → awaiting a moderator). Returns the resulting status.
   */
  async joinChannel(communityId: string, channelId: string): Promise<ChannelStatus> {
    if (!this.engine || !this.record) return 'error'
    let info: ChannelJoinInfoResponse
    try {
      info = await api<ChannelJoinInfoResponse>(
        'POST',
        `/api/v1/communities/${communityId}/channels/${channelId}/join`,
      )
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        this.setStatus(channelId, 'locked')
        return 'locked'
      }
      this.setStatus(channelId, 'error')
      return 'error'
    }
    return this.consumeJoinInfo(channelId, info)
  }

  /** Join a channel via a per-channel invite code (reaches unlisted channels). */
  async joinByCode(
    communityId: string,
    code: string,
  ): Promise<{ channelId: string; status: ChannelStatus } | null> {
    if (!this.engine || !this.record) return null
    let info: ChannelJoinInfoResponse
    try {
      info = await api<ChannelJoinInfoResponse>(
        'POST',
        `/api/v1/communities/${communityId}/channels/join-by-code`,
        { code },
      )
    } catch {
      return null
    }
    const status = await this.consumeJoinInfo(info.channelId, info)
    return { channelId: info.channelId, status }
  }

  /** Turn a join-info response into a local status, external-joining if active. */
  private async consumeJoinInfo(
    channelId: string,
    info: ChannelJoinInfoResponse,
  ): Promise<ChannelStatus> {
    if (info.status !== 'active' || !info.groupInfo) {
      this.setStatus(channelId, 'pending')
      return 'pending'
    }
    return this.externalJoinInto(channelId, info.groupInfo, info.epoch)
  }

  private async externalJoinInto(
    channelId: string,
    groupInfo: string,
    epoch: number,
  ): Promise<ChannelStatus> {
    const engine = this.engine
    const record = this.record
    if (!engine || !record) return 'error'
    if (this.ready.has(channelId)) {
      this.setStatus(channelId, 'ready')
      await engine.catchUp(channelId).catch(() => {})
      return 'ready'
    }
    this.setStatus(channelId, 'joining')
    try {
      const joined = await engine.externalJoinWithRetry(
        channelId,
        { groupInfo, epoch },
        record.deviceId,
      )
      if (joined) {
        this.ready.add(channelId)
        this.setStatus(channelId, 'ready')
        useCommunityChat.setState((state) => ({
          messages: { ...state.messages, [channelId]: state.messages[channelId] ?? [] },
        }))
        return 'ready'
      }
    } catch (err) {
      console.error('channel join failed', channelId, err)
    }
    this.setStatus(channelId, 'pending')
    return 'pending'
  }

  /**
   * Disappearing messages (client side): drop locally-held messages older than
   * the channel's TTL from IndexedDB and the in-memory store. The server prunes
   * the ciphertext on its own schedule; this keeps decrypted copies from
   * outliving the window. Called by the UI on channel open with the channel's
   * `messageTtlDays`.
   */
  async pruneChannelLocal(channelId: string, ttlDays: number): Promise<void> {
    const cutoff = Date.now() - ttlDays * 24 * 3600 * 1000
    await messageStore.pruneOlderThan(channelId, cutoff).catch(() => {})
    useCommunityChat.setState((state) => {
      const list = state.messages[channelId]
      if (!list) return state
      return {
        messages: { ...state.messages, [channelId]: list.filter((m) => m.sentAt >= cutoff) },
      }
    })
  }

  async send(channelId: string, text: string): Promise<void> {
    const engine = this.engine
    const record = this.record
    if (!engine || !record) throw new Error('locked')
    const plaintext = encoder.encode(JSON.stringify({ t: text, ts: Date.now() }))
    const { seq } = await engine.sendApplication(channelId, plaintext)
    const stored: StoredMessage = {
      groupId: channelId,
      seq,
      senderAccountId: record.accountId,
      text,
      sentAt: Date.now(),
      outgoing: true,
    }
    await messageStore.put(stored)
    appendMessage(stored)
  }

  /**
   * Cross-device K_meta sync for a community: fetch a grant sealed to this
   * device if we lack the key, and grant our key to other member devices that
   * don't have it. Returns true iff K_meta was newly obtained (caller refreshes
   * decrypted views). No-op before unlock.
   */
  async syncKeyGrants(communityId: string, knownEpoch?: number): Promise<boolean> {
    if (!this.record) return false
    return syncKeyGrants(communityId, this.record, knownEpoch).catch(() => false)
  }

  /** Fetch-only variant (WS events / list views) — never seals to others. */
  async fetchKeyGrant(communityId: string, knownEpoch?: number): Promise<boolean> {
    if (!this.record) return false
    return fetchKMetaGrant(communityId, this.record, knownEpoch).catch(() => false)
  }

  /** Leader-driven K_meta rotation after a member left (forward secrecy). */
  async rotateCommunity(communityId: string): Promise<boolean> {
    if (!this.record) return false
    return rotateCommunity(communityId, this.record).catch(() => false)
  }

  /** Forget a locally-held channel (e.g. after it was deleted server-side). */
  async forgetChannel(channelId: string): Promise<void> {
    this.ready.delete(channelId)
    await channelStore.delete(channelId).catch(() => {})
    useCommunityChat.setState((state) => {
      const channels = { ...state.channels }
      const messages = { ...state.messages }
      delete channels[channelId]
      delete messages[channelId]
      return { channels, messages }
    })
  }
}

function appendMessage(message: StoredMessage): void {
  useCommunityChat.setState((state) => {
    const list = state.messages[message.groupId] ?? []
    if (list.some((m) => m.seq === message.seq)) return state
    return {
      messages: {
        ...state.messages,
        [message.groupId]: [...list, message].sort((a, b) => a.seq - b.seq),
      },
    }
  })
}

export const communityChatStore = new CommunityChatStore()
