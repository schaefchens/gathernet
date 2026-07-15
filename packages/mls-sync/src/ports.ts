import type { MailboxMessage } from '@gathernet/shared'

/** Durable storage for sealed MLS group snapshots, keyed by hex group id. */
export interface SnapshotStore {
  get(groupId: string): Promise<Uint8Array | null>
  put(groupId: string, snapshot: Uint8Array): Promise<unknown>
  delete(groupId: string): Promise<unknown>
  keys(): Promise<string[]>
}

/** Last fully-processed mailbox seq per group. The engine enforces monotonicity. */
export interface CursorStore {
  get(groupId: string): number
  set(groupId: string, seq: number): void
}

/** Thrown by SyncTransport.postCommit when the server rejects the epoch (HTTP 409). */
export class ConflictError extends Error {
  constructor(readonly currentEpoch?: number) {
    super('commit epoch conflict')
    this.name = 'ConflictError'
  }
}

/** Wire body for a commit, all binary fields base64-encoded. */
export interface CommitBody {
  epoch: number
  commit: string
  groupInfo: string
  welcomes: { deviceId: string; payload: string }[]
  memberChanges: { adds: string[]; removes: string[] }
}

/**
 * Everything the engine needs from the network. Implementations decide the
 * actual wiring (HTTP, WebSocket, ...) and are expected to swallow
 * offline errors on the ack methods — the cursor makes redelivery a no-op.
 */
export interface SyncTransport {
  fetchMessages(groupId: string, afterSeq: number): Promise<MailboxMessage[]>
  /** Throws ConflictError (with the server's currentEpoch when known) on 409. */
  postCommit(groupId: string, body: CommitBody): Promise<void>
  fetchGroupInfo(groupId: string): Promise<{ groupInfo: string | null; epoch: number } | null>
  sendCiphertext(groupId: string, epoch: number, ciphertextB64: string): Promise<{ seq: number }>
  ackSeq(groupId: string, seq: number): Promise<void>
  ackWelcome(welcomeId: number): Promise<void>
}

/** A decrypted application message, handed to the app exactly once per seq. */
export interface ApplicationMessage {
  groupId: string
  seq: number
  kind: 'application' | 'commit' | 'proposal'
  senderAccountId?: string | undefined
  senderDeviceId?: string | undefined
  plaintext?: Uint8Array | undefined
  epoch: number
}

/**
 * Called for every decrypted application message, BEFORE the seq is acked.
 * The engine does no payload parsing — the raw plaintext is the app's.
 */
export type ApplicationSink = (message: ApplicationMessage) => void | Promise<void>

export interface Logger {
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}
