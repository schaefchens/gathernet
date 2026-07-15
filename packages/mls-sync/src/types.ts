/**
 * Minimal structural mirror of the MLS device surface the engine needs
 * (see apps/hub/src/lib/mls.ts). Declared locally so this package never
 * depends on @gathernet/mls-client (and thus never forces wasm resolution);
 * any structurally compatible handle works.
 */

export interface CommitResult {
  commit: Uint8Array
  welcomes: Uint8Array[]
  groupInfo: Uint8Array
  snapshot: Uint8Array
}

export interface RemoveResult {
  commit: Uint8Array
  groupInfo: Uint8Array
  snapshot: Uint8Array
}

export interface ProcessedMessage {
  kind: 'application' | 'commit' | 'proposal'
  plaintext?: Uint8Array
  senderDeviceId?: string
  senderAccountId?: string
  epoch: number
  groupInfo?: Uint8Array
  snapshot: Uint8Array
}

export interface MemberInfo {
  accountId: string
  deviceId: string
  name: string
}

export interface MlsDeviceHandle {
  createGroup(groupId: Uint8Array): { snapshot: Uint8Array }
  loadGroup(groupId: Uint8Array, snapshot: Uint8Array): void
  addMembers(groupId: Uint8Array, keyPackages: Uint8Array[]): CommitResult
  removeMembers(groupId: Uint8Array, deviceIds: string[]): RemoveResult
  joinFromWelcome(welcome: Uint8Array): {
    groupId: Uint8Array
    epoch: number
    members: MemberInfo[]
    snapshot: Uint8Array
  }
  externalJoin(groupInfo: Uint8Array): {
    groupId: Uint8Array
    commit: Uint8Array
    epoch: number
    snapshot: Uint8Array
  }
  encrypt(
    groupId: Uint8Array,
    plaintext: Uint8Array,
  ): { ciphertext: Uint8Array; snapshot: Uint8Array }
  processIncoming(groupId: Uint8Array, message: Uint8Array): ProcessedMessage
  currentGroupInfo(groupId: Uint8Array): Uint8Array
  members(groupId: Uint8Array): MemberInfo[]
  currentEpoch(groupId: Uint8Array): number
}
