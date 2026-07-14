import type {
  ClaimedKeyPackage,
  GroupSummary,
  MailboxMessage,
  PendingWelcome,
} from '@gathernet/shared'
import { KEY_PACKAGE_REPLENISH_BELOW, KEY_PACKAGE_TARGET } from '@gathernet/shared'
import { create } from 'zustand'
import { ApiError, api } from '../lib/api.ts'
import { type HubCrypto, loadCrypto, type MlsDeviceHandle } from '../lib/mls.ts'
import {
  type DeviceRecord,
  groupStore,
  kpStore,
  messageStore,
  type StoredMessage,
} from '../lib/storage.ts'
import { WsRequestError, wsClient } from '../lib/ws-client.ts'

export interface ChatGroup {
  groupId: string
  friendAccountId: string
  /** true once this device is an MLS leaf and can encrypt/decrypt */
  ready: boolean
}

interface ChatUiState {
  groups: Record<string, ChatGroup> // by friendAccountId
  messages: Record<string, StoredMessage[]> // by groupId
}

export const useChat = create<ChatUiState>(() => ({ groups: {}, messages: {} }))

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16))
const bytesToHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
const fromB64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

const cursorKey = (groupId: string) => `gn.cursor.${groupId}`
const getCursor = (groupId: string): number =>
  Number(localStorage.getItem(cursorKey(groupId)) ?? '0')
const setCursor = (groupId: string, seq: number): void =>
  localStorage.setItem(cursorKey(groupId), String(Math.max(seq, getCursor(groupId))))

/**
 * Owns the MlsDevice and all MLS orchestration. Invariant everywhere:
 * persist the returned snapshot BEFORE releasing ciphertext to the network
 * and BEFORE acking a processed message — an old snapshot replayed after
 * either would reuse ratchet keys.
 */
class ChatStore {
  private crypto: HubCrypto | null = null
  private device: MlsDeviceHandle | null = null
  private record: DeviceRecord | null = null
  private unsubscribes: (() => void)[] = []
  private queues = new Map<string, Promise<void>>()

  async init(record: DeviceRecord): Promise<void> {
    this.crypto = await loadCrypto()
    this.record = record
    this.device = this.crypto.createDevice(record.credential, record.deviceSecret)

    // Restore MLS group state and pending key-package secrets.
    for (const key of await groupStore.keys()) {
      const groupId = String(key)
      const snapshot = await groupStore.get(groupId)
      if (snapshot) this.device.loadGroup(hexToBytes(groupId), snapshot)
    }
    for (const key of await kpStore.keys()) {
      const ref = String(key)
      const privateState = await kpStore.get(ref)
      if (privateState) this.device.importKeyPackagePrivate(hexToBytes(ref), privateState)
    }

    // Load decrypted history into UI state.
    const messages: Record<string, StoredMessage[]> = {}
    for (const key of await groupStore.keys()) {
      const groupId = String(key)
      messages[groupId] = await messageStore.list(groupId)
    }
    useChat.setState({ messages })

    this.unsubscribes.push(
      // NOTE: syncAll is never itself enqueued — it enqueues (and awaits)
      // per-group leaf work, so putting it on a group queue would deadlock.
      wsClient.on('group.created', () => {
        this.syncAll().catch((err) => console.error('syncAll failed', err))
      }),
      wsClient.on('welcome', (m) => {
        void this.enqueue(m.payload.groupId, () =>
          this.handleWelcome({
            welcomeId: m.payload.welcomeId,
            groupId: m.payload.groupId,
            payload: m.payload.payload,
          }),
        )
      }),
      wsClient.on('chat.message', (m) => {
        void this.enqueue(m.payload.groupId, () =>
          this.processMailboxMessage({
            groupId: m.payload.groupId,
            seq: m.payload.seq,
            kind: m.payload.kind,
            epoch: m.payload.epoch,
            senderDevice: m.payload.senderDevice,
            payload: m.payload.payload,
            sentAt: m.payload.sentAt,
          }),
        )
      }),
      wsClient.on('hello.ok', (m) => {
        this.maintainKeyPackages(m.payload.kpRemaining).catch((err) =>
          console.error('kp maintenance failed', err),
        )
        this.syncAll().catch((err) => console.error('syncAll failed', err))
      }),
      wsClient.on('presence.update', () => {
        // A friend coming online may finally have key packages — retry
        // any group we couldn't bootstrap yet.
        void this.syncAll()
      }),
    )

    if (wsClient.status === 'connected') {
      await this.syncAll()
      await this.maintainKeyPackages(null)
    }
  }

  reset(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    this.unsubscribes = []
    this.device = null
    this.crypto = null
    this.record = null
    this.queues.clear()
    useChat.setState({ groups: {}, messages: {} })
  }

  /** Serialize all MLS work per group. */
  private enqueue(groupId: string, work: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(groupId) ?? Promise.resolve()
    const next = prev.then(work).catch((err) => {
      console.error('chat work failed', groupId, err)
    })
    this.queues.set(groupId, next)
    return next
  }

  async syncAll(): Promise<void> {
    if (!this.device) return
    const { groups } = await api<{ groups: GroupSummary[] }>('GET', '/api/v1/mls/groups')

    const byFriend: Record<string, ChatGroup> = {}
    for (const group of groups) {
      byFriend[group.friendAccountId] = {
        groupId: group.groupId,
        friendAccountId: group.friendAccountId,
        ready: group.isMember && (await groupStore.get(group.groupId)) !== null,
      }
    }
    useChat.setState({ groups: byFriend })

    // Pending welcomes first — they make us a member.
    const { welcomes } = await api<{ welcomes: PendingWelcome[] }>('GET', '/api/v1/mls/welcomes')
    for (const welcome of welcomes) {
      await this.enqueue(welcome.groupId, () => this.handleWelcome(welcome))
    }

    for (const group of groups) {
      await this.enqueue(group.groupId, async () => {
        const hasLocal = (await groupStore.get(group.groupId)) !== null
        if (group.isMember && hasLocal) {
          await this.catchUp(group.groupId)
        } else if (!group.isMember && group.creator && group.currentEpoch === 0) {
          await this.bootstrapAsCreator(group)
        } else if (!group.isMember && group.groupInfo && !hasLocal) {
          // Restored device: join every existing group via external commit.
          await this.externalJoin(group)
        }
      })
    }
    this.refreshReadiness()
  }

  private refreshReadiness(): void {
    void (async () => {
      const groups = { ...useChat.getState().groups }
      for (const friendId of Object.keys(groups)) {
        const group = groups[friendId]
        if (group && !group.ready) {
          groups[friendId] = { ...group, ready: (await groupStore.get(group.groupId)) !== null }
        }
      }
      useChat.setState({ groups })
    })()
  }

  /** The invite accepter's device builds the MLS group and adds everyone. */
  private async bootstrapAsCreator(group: GroupSummary): Promise<void> {
    const device = this.device
    const record = this.record
    if (!device || !record) return
    if ((await groupStore.get(group.groupId)) !== null) return

    const claim = await api<{ keyPackages: ClaimedKeyPackage[] }>(
      'POST',
      '/api/v1/mls/key-packages/claim',
      { accountIds: [group.friendAccountId, record.accountId] },
    )
    const others = claim.keyPackages.filter((kp) => kp.deviceId !== record.deviceId)
    // The friend has no key packages yet (fresh account, not yet uploaded):
    // leave the group untouched; presence/hello events retrigger syncAll.
    if (!others.some((kp) => kp.accountId === group.friendAccountId)) {
      console.warn('bootstrap deferred: no friend key packages yet', group.groupId)
      return
    }

    const groupIdBytes = hexToBytes(group.groupId)
    device.createGroup(groupIdBytes)
    const result = device.addMembers(
      groupIdBytes,
      others.map((kp) => fromB64(kp.data)),
    )

    // Persist BEFORE the commit leaves this device.
    await groupStore.put(group.groupId, result.snapshot)
    try {
      await api('POST', `/api/v1/mls/groups/${group.groupId}/commits`, {
        epoch: 0,
        commit: b64(result.commit),
        groupInfo: b64(result.groupInfo),
        welcomes: others.map((kp, i) => ({
          deviceId: kp.deviceId,
          payload: b64(result.welcomes[i] ?? result.welcomes[0] ?? result.commit),
        })),
        memberChanges: { adds: others.map((kp) => kp.deviceId), removes: [] },
      })
      setCursor(group.groupId, 1)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Another of our devices won the race — drop our local attempt and
        // wait for its Welcome.
        await groupStore.delete(group.groupId)
        return
      }
      throw err
    }
    this.refreshReadiness()
  }

  private async externalJoin(group: GroupSummary): Promise<void> {
    const device = this.device
    const record = this.record
    if (!device || !record || !group.groupInfo) return

    for (let attempt = 0; attempt < 3; attempt++) {
      const info =
        attempt === 0
          ? { groupInfo: group.groupInfo, epoch: group.currentEpoch }
          : await this.refetchGroupInfo(group.groupId)
      if (!info?.groupInfo) return

      const result = device.externalJoin(fromB64(info.groupInfo))
      await groupStore.put(group.groupId, result.snapshot)
      try {
        await api('POST', `/api/v1/mls/groups/${group.groupId}/commits`, {
          epoch: info.epoch,
          commit: b64(result.commit),
          groupInfo: b64(device.currentGroupInfo(hexToBytes(group.groupId))),
          welcomes: [],
          memberChanges: { adds: [record.deviceId], removes: [] },
        })
        setCursor(group.groupId, 0)
        await this.catchUp(group.groupId)
        this.refreshReadiness()
        return
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          await groupStore.delete(group.groupId)
          continue
        }
        throw err
      }
    }
  }

  private async refetchGroupInfo(
    groupId: string,
  ): Promise<{ groupInfo: string | null; epoch: number } | null> {
    const { groups } = await api<{ groups: GroupSummary[] }>('GET', '/api/v1/mls/groups')
    const group = groups.find((g) => g.groupId === groupId)
    return group ? { groupInfo: group.groupInfo, epoch: group.currentEpoch } : null
  }

  private async handleWelcome(welcome: PendingWelcome): Promise<void> {
    const device = this.device
    if (!device) return
    if ((await groupStore.get(welcome.groupId)) !== null) {
      // Already joined (e.g. via external commit) — just discard.
      await this.ackWelcome(welcome.welcomeId)
      return
    }
    try {
      const result = device.joinFromWelcome(fromB64(welcome.payload))
      const groupId = bytesToHex(result.groupId)
      await groupStore.put(groupId, result.snapshot)
      setCursor(groupId, 0)
      await this.ackWelcome(welcome.welcomeId)
      await this.catchUp(groupId)
      this.refreshReadiness()
    } catch (err) {
      console.error('welcome processing failed', err)
      await this.ackWelcome(welcome.welcomeId)
    }
  }

  private async ackWelcome(welcomeId: number): Promise<void> {
    try {
      await wsClient.send('welcome.ack', { welcomeId })
    } catch {
      // offline — the welcome stays queued server-side; harmless duplicate later
    }
  }

  private async catchUp(groupId: string): Promise<void> {
    const after = getCursor(groupId)
    const { messages } = await api<{ messages: MailboxMessage[] }>(
      'GET',
      `/api/v1/mls/groups/${groupId}/messages?after=${after}`,
    )
    for (const message of messages) {
      await this.processMailboxMessage(message)
    }
  }

  private async processMailboxMessage(message: MailboxMessage): Promise<void> {
    const device = this.device
    const record = this.record
    if (!device || !record) return
    if (message.seq <= getCursor(message.groupId)) return
    if (message.senderDevice === record.deviceId) {
      setCursor(message.groupId, message.seq)
      return
    }
    const snapshot = await groupStore.get(message.groupId)
    if (!snapshot) return // not a member yet; welcome will arrive

    let processed: ReturnType<MlsDeviceHandle['processIncoming']>
    try {
      processed = device.processIncoming(hexToBytes(message.groupId), fromB64(message.payload))
    } catch (err) {
      // Can't decrypt (e.g. message predates our join) — skip past it.
      console.warn('processIncoming failed', message.groupId, message.seq, err)
      setCursor(message.groupId, message.seq)
      await this.ackSeq(message.groupId, message.seq)
      return
    }

    // Persist BEFORE ack — never re-request a message we already ratcheted past.
    await groupStore.put(message.groupId, processed.snapshot)
    setCursor(message.groupId, message.seq)

    if (processed.kind === 'application' && processed.plaintext) {
      try {
        const body = JSON.parse(decoder.decode(processed.plaintext)) as { t: string; ts: number }
        const stored: StoredMessage = {
          groupId: message.groupId,
          seq: message.seq,
          senderAccountId: processed.senderAccountId ?? 'unknown',
          text: body.t,
          sentAt: body.ts,
          outgoing: false,
        }
        await messageStore.put(stored)
        appendMessage(stored)
      } catch (err) {
        console.warn('bad message payload', err)
      }
    }
    await this.ackSeq(message.groupId, message.seq)
  }

  private async ackSeq(groupId: string, seq: number): Promise<void> {
    try {
      await wsClient.send('chat.ack', { groupId, seq })
    } catch {
      // offline — server will re-deliver; cursor makes reprocessing a no-op
    }
  }

  async send(groupId: string, text: string): Promise<void> {
    const device = this.device
    const record = this.record
    if (!device || !record) throw new Error('locked')

    await this.enqueue(groupId, async () => {
      const plaintext = encoder.encode(JSON.stringify({ t: text, ts: Date.now() }))
      const result = device.encrypt(hexToBytes(groupId), plaintext)
      // Persist BEFORE the ciphertext leaves this device.
      await groupStore.put(groupId, result.snapshot)
      const ack = (await wsClient.send('chat.send', {
        groupId,
        epoch: device.currentEpoch(hexToBytes(groupId)),
        ciphertext: b64(result.ciphertext),
      })) as { seq: number }

      const stored: StoredMessage = {
        groupId,
        seq: ack.seq,
        senderAccountId: record.accountId,
        text,
        sentAt: Date.now(),
        outgoing: true,
      }
      setCursor(groupId, ack.seq)
      await messageStore.put(stored)
      appendMessage(stored)
    })
  }

  /**
   * After revoking a device (post-compromise security): remove its leaf from
   * every shared MLS group so future epochs exclude it.
   */
  async removeDeviceFromGroups(deviceId: string): Promise<void> {
    const device = this.device
    if (!device) return
    for (const key of await groupStore.keys()) {
      const groupId = String(key)
      await this.enqueue(groupId, async () => {
        const groupIdBytes = hexToBytes(groupId)
        if (!device.members(groupIdBytes).some((m) => m.deviceId === deviceId)) return
        const epoch = device.currentEpoch(groupIdBytes)
        const result = device.removeMembers(groupIdBytes, [deviceId])
        await groupStore.put(groupId, result.snapshot)
        try {
          await api('POST', `/api/v1/mls/groups/${groupId}/commits`, {
            epoch,
            commit: b64(result.commit),
            groupInfo: b64(result.groupInfo),
            welcomes: [],
            memberChanges: { adds: [], removes: [deviceId] },
          })
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) {
            // Epoch raced — reload from mailbox and let syncAll retry later.
            await this.catchUp(groupId)
            return
          }
          throw err
        }
      })
    }
  }

  private async maintainKeyPackages(known: number | null): Promise<void> {
    const device = this.device
    if (!device) return
    let remaining = known
    if (remaining === null) {
      const res = await api<{ kpRemaining: number }>('GET', '/api/v1/mls/key-packages/count')
      remaining = res.kpRemaining
    }
    if (remaining >= KEY_PACKAGE_REPLENISH_BELOW) return

    const batch: { ref: string; data: string; isLastResort: boolean }[] = []
    for (let i = 0; i < KEY_PACKAGE_TARGET - remaining; i++) {
      const kp = device.generateKeyPackage(false)
      const ref = bytesToHex(kp.ref)
      await kpStore.put(ref, kp.privateState) // persist secret BEFORE upload
      batch.push({ ref, data: b64(kp.message), isLastResort: false })
    }
    const lastResort = device.generateKeyPackage(true)
    const lastResortRef = bytesToHex(lastResort.ref)
    await kpStore.put(lastResortRef, lastResort.privateState)
    batch.push({ ref: lastResortRef, data: b64(lastResort.message), isLastResort: true })

    try {
      await api('POST', '/api/v1/mls/key-packages', { keyPackages: batch })
    } catch (err) {
      if (!(err instanceof WsRequestError)) console.error('kp upload failed', err)
    }
  }
}

function appendMessage(message: StoredMessage): void {
  useChat.setState((state) => {
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

export const chatStore = new ChatStore()
