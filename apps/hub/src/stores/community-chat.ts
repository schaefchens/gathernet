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
  CommunityDeviceResponse,
  CommunityDevicesResponse,
  CommunityListItem,
  CommunityRoot,
  MailboxMessage,
} from '@gathernet/shared'
import { create } from 'zustand'
import { ApiError, api } from '../lib/api.ts'
import {
  bootstrapGroupKeyChannel,
  channelEpochHighWater,
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
  accountHoldsCap,
  buildCapability,
  COMMUNITY_SCOPE,
  fetchKMetaGrant,
  forgetKMetaCache,
  fromStdB64,
  getKMetaEpoch,
  getPinnedOwner,
  issueCapabilities,
  issueChannelModCaps,
  makeCapFetcher,
  makeDeviceResolver,
  pinCommunityOwner,
  publishCommunityRoot,
  rotateCommunity,
  syncKeyGrants,
  toStdB64,
  verifyCommunityRoot,
} from '../lib/community-keys.ts'
import { encryptAndUpload } from '../lib/media.ts'
import {
  deleteBody,
  editBody,
  encodeBody,
  type MessageBody,
  mediaBody,
  parseBody,
  reactionBody,
  textBody,
} from '../lib/message-body.ts'
import {
  applyDelete,
  applyEdit,
  applyReaction,
  bodyToStored,
  ingestBody,
} from '../lib/message-ingest.ts'
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
export type ChannelStatus =
  | 'idle'
  | 'joining'
  | 'ready'
  | 'locked'
  | 'pending'
  | 'error'
  | 'untrusted'
  /** group_key: an authorised rotation exists we can't adopt yet — sending is paused
   *  (fail-closed forward secrecy). Transient; clears when the new-epoch grant lands. */
  | 'rotation_pending'

interface CommunityChatState {
  channels: Record<string, ChannelStatus> // by channelId
  messages: Record<string, StoredMessage[]> // by channelId
}

export const useCommunityChat = create<CommunityChatState>(() => ({ channels: {}, messages: {} }))

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
  /** MLS channels whose current leaf set failed capability verification (an
   *  unauthorised/injected member) — sending is refused to contain the leak. */
  private untrustedChannels = new Set<string>()
  /** group_key channels this device tracks: channelId → {communityId, keyEpoch}. */
  private groupKey = new Map<string, { communityId: string; keyEpoch: number }>()
  /** Verified sender certs, per community: communityId → deviceId → identity (or null). */
  private senderCerts = new Map<
    string,
    Map<string, { devicePk: Uint8Array; accountId: string } | null>
  >()
  /** `communityId:deviceId` sender ids not found in the member-device list — cached
   *  so a server injecting random unknown ids can't force an O(members) refetch +
   *  re-verify per frame. Cleared on reconnect so genuinely-new devices resolve. */
  private unresolvedSenders = new Set<string>()
  /** `communityId:epoch:accountId` → whether a group_key message sender holds a valid
   *  membership cap (so a REMOVED member holding a retained old key can't keep
   *  posting). Keyed by epoch → self-heals on rotation; only reached by cert-verified
   *  senders, so a server can't amplify it with fake accounts. */
  private memberCapCache = new Map<string, boolean>()

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
        const body = parseBody(message.plaintext)
        if (!body) return
        await ingestBody(
          {
            groupId: message.groupId,
            seq: message.seq,
            senderAccountId: message.senderAccountId ?? 'unknown',
            outgoing: false,
            getList: () => useCommunityChat.getState().messages[message.groupId] ?? [],
            setList: (list) =>
              useCommunityChat.setState((s) => ({
                messages: { ...s.messages, [message.groupId]: list },
              })),
            append: appendMessage,
          },
          body,
        )
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
      // Scalable group_key delivery: a tiny nudge → pull the ciphertext.
      wsClient.on('channel.updated', (m) => {
        const gk = this.groupKey.get(m.payload.channelId)
        if (gk) {
          void this.catchUpGroupKey(m.payload.channelId, gk.communityId).catch((err) =>
            console.error('channel work failed', m.payload.channelId, err),
          )
        }
      }),
      wsClient.on('hello.ok', () => {
        // Drop cached sender lookups so devices added while we were offline resolve.
        this.senderCerts.clear()
        this.unresolvedSenders.clear()
        this.memberCapCache.clear() // re-check membership (a just-issued cap resolves)
        this.resubscribeChannels()
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
      await this.refreshRotationPending(channelId)
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
    this.untrustedChannels = new Set()
    this.groupKey = new Map()
    this.senderCerts = new Map()
    this.unresolvedSenders = new Set()
    this.memberCapCache = new Map()
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

  /** Subscribe to a group_key channel's delivery nudges (fire-and-forget). */
  private subscribeGroupKey(channelId: string): void {
    void wsClient.send('channel.subscribe', { channelId }).catch(() => {})
  }

  /** Re-subscribe every tracked group_key channel after a (re)connect. */
  private resubscribeChannels(): void {
    for (const channelId of this.groupKey.keys()) this.subscribeGroupKey(channelId)
  }

  private cursor(channelId: string): number {
    return Number(localStorage.getItem(cursorKey(channelId)) ?? '0')
  }

  private setCursor(channelId: string, seq: number): void {
    if (seq > this.cursor(channelId)) localStorage.setItem(cursorKey(channelId), String(seq))
  }

  /**
   * Resolve + verify a claimed sender device's identity from its DeviceCert
   * (signed by its account) — NEVER the server's `senderDevice` field. Resolves ONE
   * device by id via the targeted endpoint (NOT the full member-device list): at
   * mega-community scale the list is capped/paged, so pulling it would (a) fail to
   * resolve any sender beyond the first page — silently dropping broadcast posts —
   * and (b) leak the roster to a regular member. Cached per (community, device); a
   * not-found id is negative-cached to bound an inject-random-ids amplification DoS.
   */
  private async resolveSender(
    communityId: string,
    deviceId: string,
  ): Promise<{ devicePk: Uint8Array; accountId: string } | null> {
    const cached = this.senderCerts.get(communityId)
    if (cached?.has(deviceId)) return cached.get(deviceId) ?? null
    if (this.unresolvedSenders.has(`${communityId}:${deviceId}`)) return null
    try {
      const { device } = await api<CommunityDeviceResponse>(
        'GET',
        `/api/v1/communities/${communityId}/devices/${deviceId}`,
      )
      const identity = device ? await verifyChannelSender(device) : null
      const map = cached ?? new Map<string, { devicePk: Uint8Array; accountId: string } | null>()
      map.set(deviceId, identity)
      this.senderCerts.set(communityId, map)
      if (!device) this.unresolvedSenders.add(`${communityId}:${deviceId}`)
      return identity
    } catch {
      return null
    }
  }

  /**
   * Whether a group_key message sender's account is a CURRENT community member —
   * holds a valid membership capability chained to the pinned owner at the held
   * epoch. Uses TARGETED lookups (single cap + single device, no roster enum —
   * honours the big-group no-roster constraint). Degrades to accept when there's no
   * pinned owner / no held K_meta. Cached per (community, epoch, account).
   */
  private async senderIsMember(communityId: string, accountId: string): Promise<boolean> {
    const ownerAccountId = await getPinnedOwner(communityId)
    const epoch = await getKMetaEpoch(communityId)
    if (!ownerAccountId || epoch < 0) return true // legacy/degraded — can't verify
    const cacheKey = `${communityId}:${epoch}:${accountId}`
    if (this.memberCapCache.get(cacheKey)) return true // cache POSITIVES only
    const resolve = makeDeviceResolver([], { communityId })
    const getCap = makeCapFetcher(communityId)
    const ok = await accountHoldsCap(
      COMMUNITY_SCOPE,
      accountId,
      ownerAccountId,
      resolve,
      getCap,
      epoch,
    )
    // Only cache a positive: a negative may be a cap that hasn't propagated yet
    // (a just-issued joiner) — caching it would drop their messages until reconnect.
    // Re-checking a negative is bounded (only cert-verified real accounts reach here).
    if (ok) this.memberCapCache.set(cacheKey, true)
    return ok
  }

  /**
   * Ordered mailbox catch-up for a group_key channel: fetch ciphertext after the
   * cursor, decrypt + verify each in seq order, store, ack. Malformed frames and
   * old-epoch history (never grantable) are skipped; it stalls (leaving the
   * cursor put) only on a current/in-flight epoch we don't hold yet, resuming
   * once the grant arrives. Used both for reconnect and as the live-nudge handler.
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
    // A newly-adopted epoch here (or an advanced high-water from a seen commitment)
    // may resolve or trigger the fail-closed composer state — reflect it now so the
    // composer isn't left stuck without a send attempt.
    await this.refreshRotationPending(channelId)
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
    if (!key) {
      // An epoch OLDER than any we hold will never be granted (forward secrecy):
      // a late joiner is granted only the current epoch, so retained history
      // under old epochs is undecryptable forever. Skip it (advance) instead of
      // stalling the whole channel behind it. Only wait for a current/in-flight
      // epoch, where a grant may still arrive.
      const held = await latestHeldEpoch(channelId)
      if (held !== null && epoch < held) return true
      return false
    }
    const opened = await openChannelMessage({
      payloadB64: m.payload,
      key,
      communityId,
      channelId,
      resolveSender: (id) => this.resolveSender(communityId, id),
    })
    if (opened) {
      // WRITE GATE: the sender must be a CURRENT community member (cap chained to the
      // pinned owner) — a removed member holding a retained old-epoch key must not be
      // able to keep posting authentic-looking messages. Cert-verified senders only
      // reach here, so this can't be amplified with fake accounts.
      if (!(await this.senderIsMember(communityId, opened.senderAccountId))) return true
      // Persisted per-(channel,sender) high-water senderSeq — survives reloads so
      // a compromised server can't replay a signed old envelope at a fresh seq.
      const seqKey = `gn.gkss.${channelId}.${opened.senderDeviceId}`
      const seen = Number(localStorage.getItem(seqKey) ?? '-1')
      if (opened.senderSeq > seen) {
        localStorage.setItem(seqKey, String(opened.senderSeq))
        const body = parseBody(opened.plaintext)
        if (body) {
          await ingestBody(
            {
              groupId: channelId,
              seq: m.seq,
              senderAccountId: opened.senderAccountId,
              outgoing: opened.senderAccountId === this.record?.accountId,
              getList: () => useCommunityChat.getState().messages[channelId] ?? [],
              setList: (list) =>
                useCommunityChat.setState((s) => ({
                  messages: { ...s.messages, [channelId]: list },
                })),
              append: appendMessage,
            },
            body,
          )
        }
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
    this.subscribeGroupKey(info.channelId)
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
    // Reflect fail-closed state on open (an unadopted authorised rotation → paused).
    await this.refreshRotationPending(info.channelId)
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
    this.subscribeGroupKey(channelId)
    this.setStatus(channelId, 'ready')
    useCommunityChat.setState((state) => ({
      messages: { ...state.messages, [channelId]: state.messages[channelId] ?? [] },
    }))
  }

  private async sendGroupKey(
    channelId: string,
    gk: { communityId: string; keyEpoch: number },
    body: MessageBody,
  ): Promise<void> {
    const record = this.record
    if (!record) throw new Error('locked')
    // Pick up any rotation FIRST — latestHeldEpoch reflects only what we hold, so
    // without this a sender that missed a rotation would seal under the OLD epoch
    // (the key a removed member still has), letting them read post-removal
    // messages. fetchChannelKeyGrant advances us to the server's current epoch AND
    // the forward-secrecy high-water (from the authorised rotation commitment).
    await fetchChannelKeyGrant(gk.communityId, channelId, record).catch(() => {})
    const epoch = (await latestHeldEpoch(channelId)) ?? gk.keyEpoch
    // FAIL CLOSED: if an AUTHORISED rotation to a higher epoch exists (locally-
    // trusted high-water) that we haven't been able to adopt, REFUSE to send rather
    // than seal under the superseded key a removed member still holds. Self-heals
    // when the new-epoch grant arrives (composer re-enables).
    if (epoch < channelEpochHighWater(channelId)) {
      this.setStatus(channelId, 'rotation_pending')
      throw new Error('rotation_pending')
    }
    this.clearRotationPending(channelId)
    const key = await getKChannel(channelId, epoch)
    if (!key) throw new Error('no_channel_key')

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
      body: encodeBody(body),
      ts: body.ts,
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
    localStorage.setItem(`gn.gkss.${channelId}.${record.deviceId}`, String(senderSeq))
    if (seq > this.cursor(channelId)) this.setCursor(channelId, seq)

    // A display message is stored optimistically; a control message (reaction) is
    // applied by the caller (react) — bodyToStored returns null for it.
    const stored = bodyToStored(channelId, seq, record.accountId, true, body)
    if (stored) {
      await messageStore.put(stored)
      appendMessage(stored)
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
    if (info.encryptionMode === 'group_key') return this.openGroupKeyChannel(info)
    return this.consumeJoinInfo(channelId, info)
  }

  /**
   * MLS-channel capability overlay (detection + containment). mls-rs applies an
   * external-join commit automatically — a compromised server could inject a leaf
   * we can't refuse at the protocol layer without a crate change — so after the
   * channel's engine has caught up we enumerate its current MLS leaves and require
   * EACH leaf's account to hold a valid membership capability chained to the pinned
   * owner. If any leaf lacks one the channel is marked `untrusted`: the composer is
   * disabled and `send` refuses, so no further plaintext reaches the injected
   * member. Runs only when an owner is pinned (else we can't verify → legacy trust)
   * and only for MLS channels (group_key access is gated at the key-grant instead).
   * Returns true iff the channel is trusted.
   *
   * Scope note: this verifies COMMUNITY membership (blocks a server-injected
   * outsider). Per-channel authorisation (channel-scope caps) is the same follow-up
   * as the K_channel grant enforcement.
   */
  async verifyChannelTrust(communityId: string, channelId: string): Promise<boolean> {
    const engine = this.engine
    if (!engine || this.groupKey.has(channelId) || !engine.hasGroup(channelId)) return true
    const ownerAccountId = await getPinnedOwner(communityId)
    // The epoch pin must come from LOCALLY-held key material, never the relay: our
    // held K_meta epoch is monotonic + commitment-verified. With no pinned owner or
    // no held K_meta we can't verify → legacy trust (same degradation as K_meta).
    const expectedEpoch = await getKMetaEpoch(communityId)
    if (!ownerAccountId || expectedEpoch < 0) {
      this.clearUntrusted(channelId)
      return true
    }
    let devices: CommunityDevicesResponse['devices']
    try {
      devices = (
        await api<CommunityDevicesResponse>('GET', `/api/v1/communities/${communityId}/devices`)
      ).devices
    } catch {
      return true // offline — don't flip a channel untrusted on a fetch failure
    }
    // Seed with the fetched page, but allow bounded fetch-on-miss: an MLS leaf (or a
    // cap issuer in its chain) can be a device beyond the first roster page, and
    // without fetch-on-miss it would fail to resolve → the channel would be falsely
    // flipped untrusted (composer wedge) in a >page-size community.
    const resolve = makeDeviceResolver(devices, { communityId, maxFetch: 256 })
    const getCap = makeCapFetcher(communityId)
    let trusted = true
    for (const leaf of engine.members(channelId)) {
      if (
        !(await accountHoldsCap(
          COMMUNITY_SCOPE,
          leaf.accountId,
          ownerAccountId,
          resolve,
          getCap,
          expectedEpoch,
        ))
      ) {
        trusted = false
        break
      }
    }
    if (trusted) {
      this.clearUntrusted(channelId)
    } else {
      this.untrustedChannels.add(channelId)
      this.setStatus(channelId, 'untrusted')
    }
    return trusted
  }

  /** Restore a channel to `ready` if it was previously flagged untrusted. */
  private clearUntrusted(channelId: string): void {
    if (this.untrustedChannels.delete(channelId) && this.ready.has(channelId)) {
      this.setStatus(channelId, 'ready')
    }
  }

  /** Restore a group_key channel to `ready` after a rotation_pending clears (keyed
   *  off `groupKey`, NOT `ready` — group_key channels never join `this.ready`). */
  private clearRotationPending(channelId: string): void {
    if (this.groupKey.has(channelId)) this.setStatus(channelId, 'ready')
  }

  /**
   * Re-evaluate a group_key channel's fail-closed send state: if an authorised
   * rotation (high-water) is ahead of the epoch we hold, mark rotation_pending;
   * else clear it. Called after a grant fetch / channel open so the composer
   * reflects the current state without waiting for a send attempt.
   */
  private async refreshRotationPending(channelId: string): Promise<void> {
    if (!this.groupKey.has(channelId)) return
    const held = (await latestHeldEpoch(channelId)) ?? -1
    if (held < channelEpochHighWater(channelId)) {
      this.setStatus(channelId, 'rotation_pending')
    } else {
      this.clearRotationPending(channelId)
    }
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

  async send(channelId: string, text: string, replyTo?: string): Promise<void> {
    return this.sendBody(channelId, textBody(text, replyTo))
  }

  /** Encrypt + upload an attachment, then send it as a media message (optional caption). */
  async sendMedia(
    channelId: string,
    file: Blob,
    caption?: string,
    replyTo?: string,
  ): Promise<void> {
    const media = await encryptAndUpload(file)
    return this.sendBody(channelId, mediaBody(media, caption, replyTo))
  }

  /** Add or remove a reaction on a channel message (both MLS + group_key channels). */
  async react(channelId: string, targetId: string, emoji: string, remove: boolean): Promise<void> {
    const record = this.record
    if (!record) return
    await this.sendBody(channelId, reactionBody(targetId, emoji, remove)).catch((err) =>
      console.error('react failed', channelId, err),
    )
    // Apply to our own view (the control message isn't echoed back on MLS).
    const res = applyReaction(
      useCommunityChat.getState().messages[channelId] ?? [],
      targetId,
      emoji,
      record.accountId,
      remove,
    )
    if (res) {
      useCommunityChat.setState((s) => ({ messages: { ...s.messages, [channelId]: res.list } }))
      await messageStore.put(res.changed)
    }
  }

  /** Edit one of my own channel messages (honored only if I'm the author). */
  async editMessage(channelId: string, targetId: string, text: string): Promise<void> {
    const record = this.record
    if (!record) return
    const body = editBody(targetId, text)
    await this.sendBody(channelId, body).catch((err) =>
      console.error('edit failed', channelId, err),
    )
    const res = applyEdit(
      useCommunityChat.getState().messages[channelId] ?? [],
      targetId,
      text,
      body.ts,
      record.accountId,
    )
    if (res) {
      useCommunityChat.setState((s) => ({ messages: { ...s.messages, [channelId]: res.list } }))
      await messageStore.put(res.changed)
    }
  }

  /** Delete one of my channel messages for everyone: tombstone + remove server record. */
  async deleteMessage(channelId: string, targetId: string, targetSeq: number): Promise<void> {
    const record = this.record
    if (!record) return
    const body = deleteBody(targetId)
    await this.sendBody(channelId, body).catch((err) =>
      console.error('delete failed', channelId, err),
    )
    const res = applyDelete(
      useCommunityChat.getState().messages[channelId] ?? [],
      targetId,
      body.ts,
      record.accountId,
    )
    if (res) {
      useCommunityChat.setState((s) => ({ messages: { ...s.messages, [channelId]: res.list } }))
      await messageStore.put(res.changed)
    }
    await api('DELETE', `/api/v1/mls/groups/${channelId}/messages/${targetSeq}`).catch(() => {})
  }

  /** Encode + send a message body over the channel's transport (MLS or group_key). */
  private async sendBody(channelId: string, body: MessageBody): Promise<void> {
    const gk = this.groupKey.get(channelId)
    if (gk) return this.sendGroupKey(channelId, gk, body)
    const engine = this.engine
    const record = this.record
    if (!engine || !record) throw new Error('locked')
    // Containment: never emit plaintext into a channel with an unauthorised leaf.
    if (this.untrustedChannels.has(channelId)) throw new Error('untrusted')
    const { seq } = await engine.sendApplication(channelId, encodeBody(body))
    const stored = bodyToStored(channelId, seq, record.accountId, true, body)
    if (stored) {
      await messageStore.put(stored)
      appendMessage(stored)
    }
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

  /** Owner: sign + publish the community ownership root (capability-chain anchor). */
  async publishCommunityRoot(communityId: string): Promise<void> {
    if (!this.record) return
    await publishCommunityRoot(communityId, this.record).catch(() => {})
  }

  /** Pin the community owner (from the out-of-band invite) — TOFU, first-seen wins. */
  async pinCommunityOwner(communityId: string, ownerAccountId: string): Promise<void> {
    await pinCommunityOwner(communityId, ownerAccountId).catch(() => {})
  }

  /**
   * Bootstrap the capability root for a community that predates this feature (or a
   * device that never saw the owner out-of-band). The owner publishes + self-pins
   * the root on next activity if it's missing; a member with no local pin TOFU-pins
   * from the server-served root — but only after verifying the owner's own device
   * signed it (internal consistency; the out-of-band invite pin is still stronger).
   */
  async bootstrapOwnership(
    communityId: string,
    root: CommunityRoot | null,
    myRole: 'owner' | 'leader' | 'member',
  ): Promise<void> {
    if (!this.record) return
    if (myRole === 'owner') {
      if (!root) await this.publishCommunityRoot(communityId)
      return
    }
    if (!root || (await getPinnedOwner(communityId))) return
    try {
      const { devices } = await api<CommunityDevicesResponse>(
        'GET',
        `/api/v1/communities/${communityId}/devices`,
      )
      if (await verifyCommunityRoot(root, makeDeviceResolver(devices))) {
        await pinCommunityOwner(communityId, root.ownerAccountId)
      }
    } catch {
      // offline — a later open retries.
    }
  }

  /** Owner/leader: issue identity-signed membership caps for the roster (this epoch). */
  async issueCapabilities(
    communityId: string,
    epoch: number,
    myRole: 'owner' | 'leader' | 'member',
  ): Promise<void> {
    if (!this.record) return
    await issueCapabilities(communityId, epoch, myRole, this.record).catch(() => {})
  }

  /**
   * Owner/leader: issue a single community MEMBER cap for a just-joined account,
   * TARGETED (one cap, no roster sweep — scale-safe at 100k) so the joiner is capped
   * before a manager tops up their key grant (else the grant gate would skip them).
   * Fired on the `community.member_joined` event. Fresh community joiners are always
   * role 'member'. No-op unless we're owner/leader and hold the current K_meta.
   */
  async issueMemberCapForJoiner(communityId: string, joinerAccountId: string): Promise<void> {
    if (!this.record) return
    const epoch = await getKMetaEpoch(communityId)
    if (epoch < 0) return
    const detail = await api<CommunityDetailResponse>(
      'GET',
      `/api/v1/communities/${communityId}`,
    ).catch(() => null)
    if (!detail || (detail.myRole !== 'owner' && detail.myRole !== 'leader')) return
    const cap = await buildCapability(
      communityId,
      COMMUNITY_SCOPE,
      joinerAccountId,
      'member',
      epoch,
      this.record,
    )
    await api('POST', `/api/v1/communities/${communityId}/capabilities`, {
      capabilities: [cap],
    }).catch(() => {})
  }

  /** Owner/leader: issue channel-moderator caps (the group_key rotation-minter authority). */
  async issueChannelModCaps(
    communityId: string,
    channelIds: string[],
    epoch: number,
    myRole: 'owner' | 'leader' | 'member',
  ): Promise<void> {
    if (!this.record || channelIds.length === 0) return
    await issueChannelModCaps(communityId, channelIds, epoch, myRole, this.record).catch(() => {})
  }

  /**
   * Issue a channel-moderator cap for one channel at the locally-held community
   * epoch — called by a leader/owner right after promoting a moderator, so the new
   * moderator can mint a trusted rotation immediately (not only after the next sweep).
   */
  async issueChannelModCapNow(communityId: string, channelId: string): Promise<void> {
    if (!this.record) return
    const epoch = await getKMetaEpoch(communityId)
    if (epoch < 0) return
    await issueChannelModCaps(communityId, [channelId], epoch, 'leader', this.record).catch(
      () => {},
    )
  }

  /** Forget a locally-held channel (e.g. after it was deleted server-side). */
  async forgetChannel(channelId: string): Promise<void> {
    this.ready.delete(channelId)
    if (this.groupKey.delete(channelId)) {
      void wsClient.send('channel.unsubscribe', { channelId }).catch(() => {})
    }
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
