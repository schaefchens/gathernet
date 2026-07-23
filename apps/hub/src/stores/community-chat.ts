import {
  b64,
  ConflictError,
  type CursorStore,
  hexToBytes,
  MlsSyncEngine,
  type SnapshotStore,
  type SyncTransport,
} from '@gathernet/mls-sync'
import type {
  ChannelJoinInfoResponse,
  CommunityDetailResponse,
  CommunityDevicesResponse,
  CommunityListItem,
  MailboxMessage,
} from '@gathernet/shared'
import { create } from 'zustand'
import { ApiError, api } from '../lib/api.ts'
import {
  bootstrapGroupKeyChannel,
  envelopeEpoch,
  fetchChannelKeyGrant,
  forgetChannelKeyCache,
  getKChannel,
  grantChannelKey,
  latestHeldEpoch,
  openChannelMessage,
  rotateChannelKey,
  sealChannelMessage,
  verifyChannelSender,
} from '../lib/channel-keys.ts'
import {
  fetchKMetaGrant,
  forgetKMetaCache,
  fromStdB64,
  rotateCommunity,
  syncKeyGrants,
  toStdB64,
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
  /** group_key channels this device tracks: channelId → {communityId, keyEpoch}. */
  private groupKey = new Map<string, { communityId: string; keyEpoch: number }>()
  /** Verified sender certs, per community: communityId → deviceId → identity (or null). */
  private senderCerts = new Map<
    string,
    Map<string, { devicePk: Uint8Array; accountId: string } | null>
  >()
  /** Last senderSeq accepted per `channelId:senderDeviceId` — best-effort replay guard. */
  private lastSenderSeq = new Map<string, number>()

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
        // group_key channels have no MLS snapshot — decrypt them via K_channel.
        const gk = this.groupKey.get(m.payload.groupId)
        if (gk) {
          void this.ingestGroupKeyMessage(m.payload.groupId, gk.communityId, {
            seq: m.payload.seq,
            senderDevice: m.payload.senderDevice,
            payload: m.payload.payload,
          }).catch((err) => console.error('channel work failed', m.payload.groupId, err))
          return
        }
        // Only our MLS groups have a channel snapshot; the rest (DMs) no-op here.
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
      if (c.myRole !== 'owner' && c.myRole !== 'leader') continue
      if (c.rotationPending) await this.rotateCommunity(c.communityId)
      // Rotate any group_key channel a member left/was removed from (durable flag).
      if (c.channelRotationPending) await this.sweepChannelRotations(c.communityId)
    }
  }

  /** Rotate every group_key channel in a community that is flagged rotationPending. */
  private async sweepChannelRotations(communityId: string): Promise<void> {
    let detail: CommunityDetailResponse
    try {
      detail = await api<CommunityDetailResponse>('GET', `/api/v1/communities/${communityId}`)
    } catch {
      return
    }
    for (const ch of detail.channels) {
      if (ch.encryptionMode === 'group_key' && ch.rotationPending) {
        await this.rotateChannelKey(communityId, ch.channelId, ch.keyEpoch).catch(() => {})
      }
    }
  }

  /**
   * A manager tops up K_channel grants for a group_key channel it holds a key for
   * (e.g. a new member joined). Idempotent + best-effort; a non-manager 403s. Only
   * acts on channels this device tracks (has opened/created).
   */
  async syncChannelGrants(communityId: string, channelId: string): Promise<void> {
    const gk = this.groupKey.get(channelId)
    const record = this.record
    if (!gk || !record) return
    const epoch = (await latestHeldEpoch(channelId)) ?? gk.keyEpoch
    const key = await getKChannel(channelId, epoch)
    if (key) await grantChannelKey(communityId, channelId, record, key, epoch).catch(() => {})
  }

  /**
   * A group_key channel grant landed for one of our devices — fetch + open it,
   * then replay any backlog we couldn't decrypt before. Safe when we don't track
   * the channel yet (the key is stored; a later open catches up).
   */
  async fetchChannelKey(communityId: string, channelId: string): Promise<void> {
    const record = this.record
    if (!record) return
    await fetchChannelKeyGrant(communityId, channelId, record).catch(() => {})
    if (this.groupKey.has(channelId)) {
      await this.catchUpGroupKey(channelId, communityId).catch(() => {})
    }
  }

  /** Live `community.channel_rotation_needed` handler: rotate from the channel's
   *  current epoch (the CAS resolves races with another manager). */
  async rotateChannelForEvent(communityId: string, channelId: string): Promise<void> {
    if (!this.record) return
    try {
      const info = await api<ChannelJoinInfoResponse>(
        'GET',
        `/api/v1/communities/channels/${channelId}`,
      )
      if (info.encryptionMode !== 'group_key') return
      await this.rotateChannelKey(communityId, channelId, info.keyEpoch)
    } catch {
      // not a manager / offline — the connect-sweep retries from the durable flag
    }
  }

  /** Manager-driven K_channel rotation after a member left (forward secrecy). */
  async rotateChannelKey(
    communityId: string,
    channelId: string,
    fromEpoch: number,
  ): Promise<boolean> {
    const record = this.record
    if (!record) return false
    const rotated = await rotateChannelKey(communityId, channelId, record, fromEpoch).catch(
      () => false,
    )
    if (rotated) {
      const gk = this.groupKey.get(channelId)
      if (gk) this.groupKey.set(channelId, { ...gk, keyEpoch: fromEpoch + 1 })
    }
    return rotated
  }

  reset(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    this.unsubscribes = []
    this.engine = null
    this.device = null
    this.crypto = null
    this.record = null
    this.ready = new Set()
    this.groupKey = new Map()
    this.senderCerts = new Map()
    this.lastSenderSeq = new Map()
    forgetKMetaCache()
    forgetChannelKeyCache()
    useCommunityChat.setState({ channels: {}, messages: {} })
  }

  /** Re-sync every channel we already hold state for (reconnect / boot). */
  private async catchUpAll(): Promise<void> {
    const engine = this.engine
    if (engine) {
      for (const channelId of [...this.ready]) {
        await engine
          .catchUp(channelId)
          .catch((err) => console.error('channel work failed', channelId, err))
      }
    }
    for (const [channelId, gk] of this.groupKey) {
      await this.catchUpGroupKey(channelId, gk.communityId).catch((err) =>
        console.error('channel work failed', channelId, err),
      )
    }
  }

  /* ------------------------------ group_key -------------------------------- */

  private cursor(channelId: string): number {
    return Number(localStorage.getItem(cursorKey(channelId)) ?? '0')
  }

  private setCursor(channelId: string, seq: number): void {
    if (seq > this.cursor(channelId)) localStorage.setItem(cursorKey(channelId), String(seq))
  }

  /**
   * Resolve + verify a claimed sender device's identity from its DeviceCert
   * (signed by its account) — NEVER the server's `senderDevice` field. Cached
   * per community (member devices verified in one fetch); a cache miss reloads.
   */
  private async resolveSender(
    communityId: string,
    deviceId: string,
  ): Promise<{ devicePk: Uint8Array; accountId: string } | null> {
    const cached = this.senderCerts.get(communityId)
    if (cached?.has(deviceId)) return cached.get(deviceId) ?? null
    try {
      const { devices } = await api<CommunityDevicesResponse>(
        'GET',
        `/api/v1/communities/${communityId}/devices`,
      )
      const map = new Map<string, { devicePk: Uint8Array; accountId: string } | null>()
      for (const d of devices) map.set(d.deviceId, await verifyChannelSender(d))
      this.senderCerts.set(communityId, map)
      return map.get(deviceId) ?? null
    } catch {
      return null
    }
  }

  /**
   * Ordered mailbox catch-up for a group_key channel: fetch ciphertext after the
   * cursor, decrypt + verify each in seq order, store, ack. Stops at the first
   * message whose K_channel epoch we don't hold yet (a later run resumes from the
   * unchanged cursor once the key arrives) so no gap is skipped. Used both for
   * reconnect and as the handler for a live `chat.message` nudge.
   */
  private async catchUpGroupKey(channelId: string, communityId: string): Promise<void> {
    const after = this.cursor(channelId)
    const { messages } = await api<{ messages: MailboxMessage[] }>(
      'GET',
      `/api/v1/mls/groups/${channelId}/messages?after=${after}`,
    )
    for (const m of messages) {
      const advanced = await this.processGroupKeyOne(channelId, communityId, m)
      if (!advanced) break // missing key — resume later from the cursor
      this.setCursor(channelId, m.seq)
      await wsClient.send('chat.ack', { groupId: channelId, seq: m.seq }).catch(() => {})
    }
  }

  private async ingestGroupKeyMessage(
    channelId: string,
    communityId: string,
    _m: { seq: number; senderDevice: string; payload: string },
  ): Promise<void> {
    // A live nudge: pull everything after the cursor in order (gap-safe).
    await this.catchUpGroupKey(channelId, communityId)
  }

  /**
   * Process one group_key ciphertext row. Returns true if the cursor may advance
   * past it (decrypted, or permanently undecryptable e.g. bad signature), false
   * if we simply lack the key epoch yet (retry later, don't advance).
   */
  private async processGroupKeyOne(
    channelId: string,
    communityId: string,
    m: { seq: number; payload: string },
  ): Promise<boolean> {
    const epoch = envelopeEpoch(m.payload)
    if (epoch === null) return true // malformed → skip
    let key = await getKChannel(channelId, epoch)
    if (!key && this.record) {
      await fetchChannelKeyGrant(communityId, channelId, this.record).catch(() => {})
      key = await getKChannel(channelId, epoch)
    }
    if (!key) return false // key not available yet
    const opened = await openChannelMessage({
      payloadB64: m.payload,
      key,
      communityId,
      channelId,
      resolveSender: (id) => this.resolveSender(communityId, id),
    })
    if (opened) {
      const sk = `${channelId}:${opened.senderDeviceId}`
      const seen = this.lastSenderSeq.get(sk) ?? -1
      if (opened.senderSeq > seen) {
        this.lastSenderSeq.set(sk, opened.senderSeq)
        const stored: StoredMessage = {
          groupId: channelId,
          seq: m.seq,
          senderAccountId: opened.senderAccountId,
          text: opened.text,
          sentAt: opened.ts,
          outgoing: opened.senderAccountId === this.record?.accountId,
        }
        await messageStore.put(stored)
        appendMessage(stored)
      }
    }
    return true
  }

  /**
   * Open an already-active group_key channel: track it, load local history,
   * ensure we hold the current K_channel, and (if we're a manager, enforced
   * server-side) top up grants for member devices that lack the key.
   */
  private async openGroupKeyChannel(info: ChannelJoinInfoResponse): Promise<ChannelStatus> {
    const record = this.record
    if (!record) return 'error'
    if (info.status !== 'active') {
      this.setStatus(info.channelId, 'pending')
      return 'pending'
    }
    this.groupKey.set(info.channelId, {
      communityId: info.communityId,
      keyEpoch: info.keyEpoch,
    })
    const local = await messageStore.list(info.channelId)
    useCommunityChat.setState((state) => ({
      messages: { ...state.messages, [info.channelId]: local },
    }))
    await fetchChannelKeyGrant(info.communityId, info.channelId, record).catch(() => {})
    const key = await getKChannel(info.channelId, info.keyEpoch)
    if (key) {
      // Best-effort: a manager tops up member grants; a non-manager's POST 403s.
      await grantChannelKey(info.communityId, info.channelId, record, key, info.keyEpoch).catch(
        () => {},
      )
    }
    this.setStatus(info.channelId, 'ready')
    await this.catchUpGroupKey(info.channelId, info.communityId).catch(() => {})
    return 'ready'
  }

  /**
   * Establish a brand-new group_key channel's epoch-0 key (creator's first act
   * after the channel row exists — the group_key counterpart to bootstrapChannel).
   */
  async bootstrapGroupKey(communityId: string, channelId: string): Promise<void> {
    const record = this.record
    if (!record) throw new Error('locked')
    await bootstrapGroupKeyChannel(communityId, channelId, record)
    this.groupKey.set(channelId, { communityId, keyEpoch: 0 })
    this.setStatus(channelId, 'ready')
    useCommunityChat.setState((state) => ({
      messages: { ...state.messages, [channelId]: state.messages[channelId] ?? [] },
    }))
  }

  private async sendGroupKey(
    channelId: string,
    gk: { communityId: string; keyEpoch: number },
    text: string,
  ): Promise<void> {
    const record = this.record
    if (!record) throw new Error('locked')
    // Send under the newest epoch we hold (rotation may have advanced it).
    const epoch = (await latestHeldEpoch(channelId)) ?? gk.keyEpoch
    let key = await getKChannel(channelId, epoch)
    if (!key) {
      await fetchChannelKeyGrant(gk.communityId, channelId, record).catch(() => {})
      key = await getKChannel(channelId, epoch)
    }
    if (!key) throw new Error('no_channel_key')

    const ts = Date.now()
    const seqStoreKey = `gn.gkseq.${channelId}`
    const hashStoreKey = `gn.gkhash.${channelId}`
    const senderSeq = Number(localStorage.getItem(seqStoreKey) ?? '0') + 1
    const prevRaw = localStorage.getItem(hashStoreKey)
    const prevSenderHash = prevRaw ? fromStdB64(prevRaw) : new Uint8Array(32)

    const { ciphertext, nextHash } = await sealChannelMessage({
      key,
      communityId: gk.communityId,
      channelId,
      epoch,
      senderDeviceId: record.deviceId,
      deviceSecret: record.deviceSecret,
      text,
      ts,
      senderSeq,
      prevSenderHash,
    })
    const { seq } = (await wsClient.send('chat.send', {
      groupId: channelId,
      epoch,
      ciphertext,
    })) as { seq: number }

    localStorage.setItem(seqStoreKey, String(senderSeq))
    localStorage.setItem(hashStoreKey, toStdB64(nextHash))
    // Our own echo (fanned back to our other devices) must not double-store.
    this.lastSenderSeq.set(`${channelId}:${record.deviceId}`, senderSeq)
    if (seq > this.cursor(channelId)) this.setCursor(channelId, seq)

    const stored: StoredMessage = {
      groupId: channelId,
      seq,
      senderAccountId: record.accountId,
      text,
      sentAt: ts,
      outgoing: true,
    }
    await messageStore.put(stored)
    appendMessage(stored)
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
    if (info.encryptionMode === 'group_key') return this.openGroupKeyChannel(info)
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
    // group_key channels have no MLS GroupInfo — join = activate + fetch key.
    if (info.encryptionMode === 'group_key') return this.openGroupKeyChannel(info)
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
    const gk = this.groupKey.get(channelId)
    if (gk) return this.sendGroupKey(channelId, gk, text)
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
