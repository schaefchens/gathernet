import {
  b64,
  bytesToHex,
  ConflictError,
  type CursorStore,
  fromB64,
  hexToBytes,
  MlsSyncEngine,
  type SnapshotStore,
  type SyncTransport,
} from '@gathernet/mls-sync'
import type {
  ClaimedKeyPackage,
  GroupSummary,
  MailboxMessage,
  PendingWelcome,
} from '@gathernet/shared'
import { KEY_PACKAGE_REPLENISH_BELOW, KEY_PACKAGE_TARGET } from '@gathernet/shared'
import { create } from 'zustand'
import { ApiError, api } from '../lib/api.ts'
import { encryptAndUpload } from '../lib/media.ts'
import {
  consumeBody,
  deleteBody,
  editBody,
  encodeBody,
  mediaBody,
  parseBody,
  reactionBody,
  textBody,
  voiceBody,
} from '../lib/message-body.ts'
import {
  applyDelete,
  applyEdit,
  applyReaction,
  bodyToStored,
  consumeLocally,
  ingestBody,
} from '../lib/message-ingest.ts'
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

/* ---------- MlsSyncEngine ports, wired to the Hub's storage/network ---------- */

const snapshots: SnapshotStore = {
  get: (groupId) => groupStore.get(groupId),
  put: (groupId, snapshot) => groupStore.put(groupId, snapshot),
  delete: (groupId) => groupStore.delete(groupId),
  keys: async () => (await groupStore.keys()).map(String),
}

const cursorKey = (groupId: string) => `gn.cursor.${groupId}`
const cursors: CursorStore = {
  get: (groupId) => Number(localStorage.getItem(cursorKey(groupId)) ?? '0'),
  set: (groupId, seq) => localStorage.setItem(cursorKey(groupId), String(seq)),
}

const transport: SyncTransport = {
  async fetchMessages(groupId, afterSeq) {
    const { messages } = await api<{ messages: MailboxMessage[] }>(
      'GET',
      `/api/v1/mls/groups/${groupId}/messages?after=${afterSeq}`,
    )
    return messages
  },
  async postCommit(groupId, body) {
    try {
      await api('POST', `/api/v1/mls/groups/${groupId}/commits`, body)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const current = (err.body as { currentEpoch?: unknown } | null)?.currentEpoch
        throw new ConflictError(typeof current === 'number' ? current : undefined)
      }
      throw err
    }
  },
  async fetchGroupInfo(groupId) {
    const { groups } = await api<{ groups: GroupSummary[] }>('GET', '/api/v1/mls/groups')
    const group = groups.find((g) => g.groupId === groupId)
    return group ? { groupInfo: group.groupInfo, epoch: group.currentEpoch } : null
  },
  async sendCiphertext(groupId, epoch, ciphertextB64) {
    return (await wsClient.send('chat.send', {
      groupId,
      epoch,
      ciphertext: ciphertextB64,
    })) as { seq: number }
  },
  async ackSeq(groupId, seq) {
    try {
      await wsClient.send('chat.ack', { groupId, seq })
    } catch {
      // offline — server will re-deliver; cursor makes reprocessing a no-op
    }
  },
  async ackWelcome(welcomeId) {
    try {
      await wsClient.send('welcome.ack', { welcomeId })
    } catch {
      // offline — the welcome stays queued server-side; harmless duplicate later
    }
  },
}

/**
 * Hub adapter around the transport-agnostic MlsSyncEngine (which owns the
 * persist-snapshot-before-transmit/ack invariants and per-group queues).
 * This store keeps the DM-specific parts: ws wiring, group bootstrap,
 * key-package maintenance, and the {t, ts} JSON message payload format.
 */
class ChatStore {
  private crypto: HubCrypto | null = null
  private device: MlsDeviceHandle | null = null
  private record: DeviceRecord | null = null
  private engine: MlsSyncEngine | null = null
  private unsubscribes: (() => void)[] = []

  async init(record: DeviceRecord): Promise<void> {
    this.crypto = await loadCrypto()
    this.record = record
    const device = this.crypto.createDevice(record.credential, record.deviceSecret)
    this.device = device
    this.engine = new MlsSyncEngine({
      device,
      deviceId: record.deviceId,
      snapshots,
      cursors,
      transport,
      onApplication: async (message) => {
        const body = parseBody(message.plaintext)
        if (!body) return
        await ingestBody(
          {
            groupId: message.groupId,
            seq: message.seq,
            senderAccountId: message.senderAccountId ?? 'unknown',
            outgoing: false,
            myAccountId: record.accountId,
            getList: () => useChat.getState().messages[message.groupId] ?? [],
            setList: (list) =>
              useChat.setState((s) => ({
                messages: { ...s.messages, [message.groupId]: list },
              })),
            append: appendMessage,
            // A recipient opened my view-once message → drop its server copies so a
            // fresh device can't re-fetch it (DM: exactly one recipient, safe).
            onAuthoredConsume: (target) => {
              void api(
                'DELETE',
                `/api/v1/mls/groups/${target.groupId}/messages/${target.seq}`,
              ).catch(() => {})
              if (target.media) {
                void api('DELETE', `/api/v1/media/${target.media.mediaId}`).catch(() => {})
              }
            },
          },
          body,
        )
      },
    })

    // Restore MLS group state and pending key-package secrets.
    await this.engine.loadPersistedGroups()
    for (const key of await kpStore.keys()) {
      const ref = String(key)
      const privateState = await kpStore.get(ref)
      if (privateState) device.importKeyPackagePrivate(hexToBytes(ref), privateState)
    }

    // Load decrypted history into UI state.
    const messages: Record<string, StoredMessage[]> = {}
    for (const key of await groupStore.keys()) {
      const groupId = String(key)
      messages[groupId] = await messageStore.list(groupId)
    }
    useChat.setState({ messages })

    this.unsubscribes.push(
      // NOTE: syncAll is never itself put on a group queue — it awaits
      // per-group engine entry points, so enqueueing it would deadlock.
      wsClient.on('group.created', () => {
        this.syncAll().catch((err) => console.error('syncAll failed', err))
      }),
      wsClient.on('welcome', (m) => {
        void this.handleWelcome({
          welcomeId: m.payload.welcomeId,
          groupId: m.payload.groupId,
          payload: m.payload.payload,
        })
      }),
      wsClient.on('chat.message', (m) => {
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
          .catch((err) => console.error('chat work failed', m.payload.groupId, err))
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
    this.engine = null
    this.device = null
    this.crypto = null
    this.record = null
    useChat.setState({ groups: {}, messages: {} })
  }

  async syncAll(): Promise<void> {
    const engine = this.engine
    const record = this.record
    if (!engine || !record) return
    const { groups } = await api<{ groups: GroupSummary[] }>('GET', '/api/v1/mls/groups')

    const byFriend: Record<string, ChatGroup> = {}
    for (const group of groups) {
      byFriend[group.friendAccountId] = {
        groupId: group.groupId,
        friendAccountId: group.friendAccountId,
        ready: group.isMember && engine.hasGroup(group.groupId),
      }
    }
    useChat.setState({ groups: byFriend })

    // Pending welcomes first — they make us a member.
    const { welcomes } = await api<{ welcomes: PendingWelcome[] }>('GET', '/api/v1/mls/welcomes')
    for (const welcome of welcomes) {
      await this.handleWelcome(welcome)
    }

    for (const group of groups) {
      try {
        if (group.isMember && engine.hasGroup(group.groupId)) {
          await engine.catchUp(group.groupId)
        } else if (!group.isMember && group.creator && group.currentEpoch === 0) {
          await this.bootstrapAsCreator(group)
        } else if (!group.isMember && group.groupInfo && !engine.hasGroup(group.groupId)) {
          // Restored device: join every existing group via external commit.
          const joined = await engine.externalJoinWithRetry(
            group.groupId,
            { groupInfo: group.groupInfo, epoch: group.currentEpoch },
            record.deviceId,
          )
          if (joined) this.refreshReadiness()
        }
      } catch (err) {
        console.error('chat work failed', group.groupId, err)
      }
    }
    this.refreshReadiness()
  }

  private async handleWelcome(welcome: PendingWelcome): Promise<void> {
    const engine = this.engine
    if (!engine) return
    try {
      const joined = await engine.handleWelcome(welcome)
      if (joined) this.refreshReadiness()
    } catch (err) {
      console.error('chat work failed', welcome.groupId, err)
    }
  }

  private refreshReadiness(): void {
    const engine = this.engine
    if (!engine) return
    const groups = { ...useChat.getState().groups }
    for (const friendId of Object.keys(groups)) {
      const group = groups[friendId]
      if (group && !group.ready) {
        groups[friendId] = { ...group, ready: engine.hasGroup(group.groupId) }
      }
    }
    useChat.setState({ groups })
  }

  /** The invite accepter's device builds the MLS group and adds everyone. */
  private async bootstrapAsCreator(group: GroupSummary): Promise<void> {
    const engine = this.engine
    const record = this.record
    if (!engine || !record) return
    if (engine.hasGroup(group.groupId)) return

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

    const outcome = await engine.createGroupWithMembers(
      group.groupId,
      others.map((kp) => ({ deviceId: kp.deviceId, keyPackage: fromB64(kp.data) })),
    )
    // 'conflict': another of our devices won the race — wait for its Welcome.
    if (outcome === 'created') this.refreshReadiness()
  }

  async send(groupId: string, text: string, replyTo?: string, once?: boolean): Promise<void> {
    const engine = this.engine
    const record = this.record
    if (!engine || !record) throw new Error('locked')

    try {
      const body = textBody(text, replyTo, once)
      const { seq } = await engine.sendApplication(groupId, encodeBody(body))
      // MLS senders can't decrypt their own ciphertext → store optimistically from
      // the body (same id peers will see).
      const stored = bodyToStored(groupId, seq, record.accountId, true, body)
      if (stored) {
        await messageStore.put(stored)
        appendMessage(stored)
      }
    } catch (err) {
      console.error('chat work failed', groupId, err)
    }
  }

  /** Encrypt + upload an attachment, then send it as a media message (optional caption). */
  async sendMedia(
    groupId: string,
    file: Blob,
    caption?: string,
    replyTo?: string,
    once?: boolean,
  ): Promise<void> {
    const engine = this.engine
    const record = this.record
    if (!engine || !record) throw new Error('locked')
    const media = await encryptAndUpload(file)
    const body = mediaBody(media, caption, replyTo, once)
    const { seq } = await engine.sendApplication(groupId, encodeBody(body))
    const stored = bodyToStored(groupId, seq, record.accountId, true, body)
    if (stored) {
      await messageStore.put(stored)
      appendMessage(stored)
    }
  }

  /** Encrypt + upload a recorded voice note, then send it as a voice message. */
  async sendVoice(
    groupId: string,
    blob: Blob,
    durationMs: number,
    replyTo?: string,
    once?: boolean,
  ): Promise<void> {
    const engine = this.engine
    const record = this.record
    if (!engine || !record) throw new Error('locked')
    const media = await encryptAndUpload(blob, { durationMs })
    const body = voiceBody(media, durationMs, replyTo, once)
    const { seq } = await engine.sendApplication(groupId, encodeBody(body))
    const stored = bodyToStored(groupId, seq, record.accountId, true, body)
    if (stored) {
      await messageStore.put(stored)
      appendMessage(stored)
    }
  }

  /** Recipient opened a view-once message: destroy the local copy immediately, then
   *  tell the author (who deletes the server blob + record) and our own other devices. */
  async consumeViewOnce(groupId: string, targetId: string): Promise<void> {
    const engine = this.engine
    const record = this.record
    if (!engine || !record) return
    const res = consumeLocally(useChat.getState().messages[groupId] ?? [], targetId)
    if (res) {
      useChat.setState((s) => ({ messages: { ...s.messages, [groupId]: res.list } }))
      await messageStore.put(res.changed)
    }
    await engine.sendApplication(groupId, encodeBody(consumeBody(targetId))).catch(() => {})
  }

  /** Add or remove a reaction (emoji) on a message; optimistic locally + fanned out. */
  async react(groupId: string, targetId: string, emoji: string, remove: boolean): Promise<void> {
    const engine = this.engine
    const record = this.record
    if (!engine || !record) return
    try {
      const body = reactionBody(targetId, emoji, remove)
      await engine.sendApplication(groupId, encodeBody(body))
      // Apply to our own view (the control message isn't echoed back to us).
      const res = applyReaction(
        useChat.getState().messages[groupId] ?? [],
        targetId,
        emoji,
        record.accountId,
        remove,
      )
      if (res) {
        useChat.setState((s) => ({ messages: { ...s.messages, [groupId]: res.list } }))
        await messageStore.put(res.changed)
      }
    } catch (err) {
      console.error('react failed', groupId, err)
    }
  }

  /** Edit one of my own messages (new text); honored only if I'm the author. */
  async editMessage(groupId: string, targetId: string, text: string): Promise<void> {
    const engine = this.engine
    const record = this.record
    if (!engine || !record) return
    const body = editBody(targetId, text)
    await engine.sendApplication(groupId, encodeBody(body))
    const res = applyEdit(
      useChat.getState().messages[groupId] ?? [],
      targetId,
      text,
      body.ts,
      record.accountId,
    )
    if (res) {
      useChat.setState((s) => ({ messages: { ...s.messages, [groupId]: res.list } }))
      await messageStore.put(res.changed)
    }
  }

  /** Delete one of my messages for everyone: tombstone + remove the server record. */
  async deleteMessage(groupId: string, targetId: string, targetSeq: number): Promise<void> {
    const engine = this.engine
    const record = this.record
    if (!engine || !record) return
    const body = deleteBody(targetId)
    await engine.sendApplication(groupId, encodeBody(body))
    const res = applyDelete(
      useChat.getState().messages[groupId] ?? [],
      targetId,
      body.ts,
      record.accountId,
    )
    if (res) {
      useChat.setState((s) => ({ messages: { ...s.messages, [groupId]: res.list } }))
      await messageStore.put(res.changed)
    }
    // Defense-in-depth: drop the stored ciphertext so an un-fetched device never gets it.
    await api('DELETE', `/api/v1/mls/groups/${groupId}/messages/${targetSeq}`).catch(() => {})
  }

  /**
   * After revoking a device (post-compromise security): remove its leaf from
   * every shared MLS group so future epochs exclude it.
   */
  async removeDeviceFromGroups(deviceId: string): Promise<void> {
    const engine = this.engine
    if (!engine) return
    for (const key of await groupStore.keys()) {
      const groupId = String(key)
      await engine
        .removeAccountDevices(groupId, [deviceId])
        .catch((err) => console.error('chat work failed', groupId, err))
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
