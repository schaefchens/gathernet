import type { MailboxMessage, PendingWelcome } from '@gathernet/shared'
import { b64, bytesToHex, fromB64, hexToBytes } from './codec.ts'
import {
  type ApplicationSink,
  ConflictError,
  type CursorStore,
  type Logger,
  type SnapshotStore,
  type SyncTransport,
} from './ports.ts'
import type { MemberInfo, MlsDeviceHandle, ProcessedMessage } from './types.ts'

export interface MlsSyncEngineOptions {
  device: MlsDeviceHandle
  /** This device's id — messages it authored are skipped (MLS senders can't decrypt their own ciphertext). */
  deviceId: string
  snapshots: SnapshotStore
  cursors: CursorStore
  transport: SyncTransport
  onApplication: ApplicationSink
  logger?: Logger
}

export type CreateGroupOutcome = 'created' | 'conflict' | 'exists'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Transport-agnostic MLS sync orchestration. Invariant everywhere:
 * persist the returned snapshot BEFORE releasing ciphertext to the network
 * and BEFORE acking a processed message — an old snapshot replayed after
 * either would reuse ratchet keys.
 *
 * All public group-touching methods serialize on a per-group promise queue.
 * Orchestration that awaits these entry points (e.g. a store's syncAll) must
 * never itself run on a group queue — that would deadlock. Internally,
 * enqueued work only ever calls the unqueued `*Locked` leaf helpers.
 */
export class MlsSyncEngine {
  private readonly device: MlsDeviceHandle
  private readonly deviceId: string
  private readonly snapshots: SnapshotStore
  private readonly cursors: CursorStore
  private readonly transport: SyncTransport
  private readonly onApplication: ApplicationSink
  private readonly logger: Logger

  private queues = new Map<string, Promise<void>>()
  /** Groups this device holds local state for; mirrors the snapshot store. */
  private groups = new Set<string>()

  constructor(options: MlsSyncEngineOptions) {
    this.device = options.device
    this.deviceId = options.deviceId
    this.snapshots = options.snapshots
    this.cursors = options.cursors
    this.transport = options.transport
    this.onApplication = options.onApplication
    this.logger = options.logger ?? console
  }

  /**
   * Serialize all MLS work per group. The returned promise carries the
   * work's result/rejection to the caller; the queue chain itself swallows
   * failures so one failed job never poisons the group's queue.
   */
  private enqueue<T>(groupId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(groupId) ?? Promise.resolve()
    const result = prev.then(work)
    this.queues.set(
      groupId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    )
    return result
  }

  /** Cursors only ever move forward. */
  private setCursor(groupId: string, seq: number): void {
    this.cursors.set(groupId, Math.max(seq, this.cursors.get(groupId)))
  }

  /** Load every persisted group snapshot into the MLS device. Call once at startup. */
  async loadPersistedGroups(): Promise<void> {
    for (const groupId of await this.snapshots.keys()) {
      const snapshot = await this.snapshots.get(groupId)
      if (snapshot) {
        this.device.loadGroup(hexToBytes(groupId), snapshot)
        this.groups.add(groupId)
      }
    }
  }

  /** True once this device holds local MLS state for the group. */
  hasGroup(groupId: string): boolean {
    return this.groups.has(groupId)
  }

  groupIds(): string[] {
    return [...this.groups]
  }

  currentEpoch(groupId: string): number {
    return this.device.currentEpoch(hexToBytes(groupId))
  }

  /** The group's current MLS leaves (accountId/deviceId/name). Read-only. */
  members(groupId: string): MemberInfo[] {
    return this.device.members(hexToBytes(groupId))
  }

  /** Fetch and process every mailbox message past the cursor. */
  catchUp(groupId: string): Promise<void> {
    return this.enqueue(groupId, () => this.catchUpLocked(groupId))
  }

  private async catchUpLocked(groupId: string): Promise<void> {
    const after = this.cursors.get(groupId)
    const messages = await this.transport.fetchMessages(groupId, after)
    for (const message of messages) {
      await this.processLocked(message)
    }
  }

  /** Process one pushed mailbox message (e.g. from a websocket event). */
  processMailboxMessage(message: MailboxMessage): Promise<void> {
    return this.enqueue(message.groupId, () => this.processLocked(message))
  }

  private async processLocked(message: MailboxMessage): Promise<void> {
    if (message.seq <= this.cursors.get(message.groupId)) return
    if (message.senderDevice === this.deviceId) {
      this.setCursor(message.groupId, message.seq)
      return
    }
    const snapshot = await this.snapshots.get(message.groupId)
    if (!snapshot) return // not a member yet; welcome will arrive

    let processed: ProcessedMessage
    try {
      processed = this.device.processIncoming(hexToBytes(message.groupId), fromB64(message.payload))
    } catch (err) {
      // Can't decrypt (e.g. message predates our join) — skip past it.
      this.logger.warn('processIncoming failed', message.groupId, message.seq, err)
      this.setCursor(message.groupId, message.seq)
      await this.transport.ackSeq(message.groupId, message.seq)
      return
    }

    // Persist BEFORE ack — never re-request a message we already ratcheted past.
    await this.snapshots.put(message.groupId, processed.snapshot)
    this.setCursor(message.groupId, message.seq)

    if (processed.kind === 'application' && processed.plaintext) {
      try {
        await this.onApplication({
          groupId: message.groupId,
          seq: message.seq,
          kind: processed.kind,
          senderAccountId: processed.senderAccountId,
          senderDeviceId: processed.senderDeviceId,
          plaintext: processed.plaintext,
          epoch: processed.epoch,
        })
      } catch (err) {
        this.logger.warn('bad message payload', err)
      }
    }
    await this.transport.ackSeq(message.groupId, message.seq)
  }

  /** Encrypt and send one application message; resolves with its mailbox seq. */
  sendApplication(groupId: string, plaintext: Uint8Array): Promise<{ seq: number }> {
    return this.enqueue(groupId, async () => {
      const result = this.device.encrypt(hexToBytes(groupId), plaintext)
      // Persist BEFORE the ciphertext leaves this device.
      await this.snapshots.put(groupId, result.snapshot)
      const ack = await this.transport.sendCiphertext(
        groupId,
        this.device.currentEpoch(hexToBytes(groupId)),
        b64(result.ciphertext),
      )
      this.setCursor(groupId, ack.seq)
      return { seq: ack.seq }
    })
  }

  /** Join a group from a pending Welcome. Resolves true if we became a member. */
  handleWelcome(welcome: PendingWelcome): Promise<boolean> {
    return this.enqueue(welcome.groupId, () => this.handleWelcomeLocked(welcome))
  }

  private async handleWelcomeLocked(welcome: PendingWelcome): Promise<boolean> {
    if ((await this.snapshots.get(welcome.groupId)) !== null) {
      // Already joined (e.g. via external commit) — just discard.
      await this.transport.ackWelcome(welcome.welcomeId)
      return false
    }
    try {
      const result = this.device.joinFromWelcome(fromB64(welcome.payload))
      const groupId = bytesToHex(result.groupId)
      await this.snapshots.put(groupId, result.snapshot)
      this.groups.add(groupId)
      this.setCursor(groupId, 0)
      await this.transport.ackWelcome(welcome.welcomeId)
      await this.catchUpLocked(groupId)
      return true
    } catch (err) {
      this.logger.error('welcome processing failed', err)
      await this.transport.ackWelcome(welcome.welcomeId)
      return false
    }
  }

  /**
   * Create a brand-new group (epoch 0) and add the given members, posting the
   * commit plus their Welcomes. 'conflict' means another device won the
   * creation race — local state is dropped; wait for its Welcome instead.
   */
  createGroupWithMembers(
    groupId: string,
    members: { deviceId: string; keyPackage: Uint8Array }[],
  ): Promise<CreateGroupOutcome> {
    return this.enqueue(groupId, async () => {
      if ((await this.snapshots.get(groupId)) !== null) return 'exists'

      const groupIdBytes = hexToBytes(groupId)
      this.device.createGroup(groupIdBytes)
      const result = this.device.addMembers(
        groupIdBytes,
        members.map((m) => m.keyPackage),
      )

      // Persist BEFORE the commit leaves this device.
      await this.snapshots.put(groupId, result.snapshot)
      this.groups.add(groupId)
      try {
        await this.transport.postCommit(groupId, {
          epoch: 0,
          commit: b64(result.commit),
          groupInfo: b64(result.groupInfo),
          welcomes: members.map((m, i) => ({
            deviceId: m.deviceId,
            payload: b64(result.welcomes[i] ?? result.welcomes[0] ?? result.commit),
          })),
          memberChanges: { adds: members.map((m) => m.deviceId), removes: [] },
        })
      } catch (err) {
        if (err instanceof ConflictError) {
          await this.snapshots.delete(groupId)
          this.groups.delete(groupId)
          return 'conflict'
        }
        throw err
      }
      this.setCursor(groupId, 1)
      return 'created'
    })
  }

  /**
   * Join an existing group via external commit, retrying with fresh GroupInfo
   * (plus a little jitter) when another commit wins the epoch. Resolves true
   * once this device is a member.
   */
  externalJoinWithRetry(
    groupId: string,
    initialInfo: { groupInfo: string | null; epoch: number },
    selfDeviceId: string,
    attempts = 6,
  ): Promise<boolean> {
    return this.enqueue(groupId, async () => {
      if (this.groups.has(groupId)) return true // joined meanwhile (e.g. via Welcome)

      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) await sleep(Math.random() * 150 * attempt)
        const info = attempt === 0 ? initialInfo : await this.transport.fetchGroupInfo(groupId)
        if (!info?.groupInfo) return false

        const result = this.device.externalJoin(fromB64(info.groupInfo))
        await this.snapshots.put(groupId, result.snapshot)
        this.groups.add(groupId)
        try {
          await this.transport.postCommit(groupId, {
            epoch: info.epoch,
            commit: b64(result.commit),
            groupInfo: b64(this.device.currentGroupInfo(hexToBytes(groupId))),
            welcomes: [],
            memberChanges: { adds: [selfDeviceId], removes: [] },
          })
        } catch (err) {
          if (err instanceof ConflictError) {
            await this.snapshots.delete(groupId)
            this.groups.delete(groupId)
            continue
          }
          throw err
        }
        this.setCursor(groupId, 0)
        await this.catchUpLocked(groupId)
        return true
      }
      return false
    })
  }

  /**
   * Remove the given devices' leaves from a group (post-compromise security).
   * On an epoch race the mailbox is re-read and the removal is left for the
   * caller's next sync pass.
   */
  removeAccountDevices(groupId: string, deviceIds: string[]): Promise<void> {
    return this.enqueue(groupId, async () => {
      const groupIdBytes = hexToBytes(groupId)
      const members = this.device.members(groupIdBytes)
      const present = deviceIds.filter((id) => members.some((m) => m.deviceId === id))
      if (present.length === 0) return

      const epoch = this.device.currentEpoch(groupIdBytes)
      const result = this.device.removeMembers(groupIdBytes, present)
      await this.snapshots.put(groupId, result.snapshot)
      try {
        await this.transport.postCommit(groupId, {
          epoch,
          commit: b64(result.commit),
          groupInfo: b64(result.groupInfo),
          welcomes: [],
          memberChanges: { adds: [], removes: present },
        })
      } catch (err) {
        if (err instanceof ConflictError) {
          // Epoch raced — reload from mailbox and let the next sync retry.
          await this.catchUpLocked(groupId)
          return
        }
        throw err
      }
    })
  }
}
