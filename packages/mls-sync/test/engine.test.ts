import type { DeviceId, GroupId, MailboxMessage, PendingWelcome } from '@gathernet/shared'
import { describe, expect, it } from 'vitest'
import {
  type ApplicationMessage,
  type ApplicationSink,
  b64,
  bytesToHex,
  type CommitBody,
  ConflictError,
  type CursorStore,
  hexToBytes,
  type MlsDeviceHandle,
  MlsSyncEngine,
  type SnapshotStore,
  type SyncTransport,
} from '../src/index.ts'

const GROUP = 'ab'.repeat(16) as GroupId
const SELF = '11'.repeat(16) as DeviceId
const FRIEND = '22'.repeat(16) as DeviceId

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function makeMessage(seq: number, sender: DeviceId = FRIEND): MailboxMessage {
  return {
    groupId: GROUP,
    seq,
    kind: 'application',
    epoch: 1,
    senderDevice: sender,
    payload: b64(encoder.encode(`m${seq}`)),
    sentAt: 0,
  }
}

function makeWelcome(welcomeId = 1): PendingWelcome {
  return { welcomeId, groupId: GROUP, payload: b64(encoder.encode(GROUP)) }
}

class MemorySnapshots implements SnapshotStore {
  map = new Map<string, Uint8Array>()
  /** When set, the next put() waits on this promise first (ordering tests). */
  gate: Promise<void> | null = null

  constructor(private log: string[]) {}

  async get(groupId: string): Promise<Uint8Array | null> {
    return this.map.get(groupId) ?? null
  }
  async put(groupId: string, snapshot: Uint8Array): Promise<unknown> {
    if (this.gate) {
      const gate = this.gate
      this.gate = null
      await gate
    }
    this.log.push('put')
    this.map.set(groupId, snapshot)
    return undefined
  }
  async delete(groupId: string): Promise<unknown> {
    this.log.push('deleteSnapshot')
    this.map.delete(groupId)
    return undefined
  }
  async keys(): Promise<string[]> {
    return [...this.map.keys()]
  }
}

class MemoryCursors implements CursorStore {
  map = new Map<string, number>()
  get(groupId: string): number {
    return this.map.get(groupId) ?? 0
  }
  set(groupId: string, seq: number): void {
    this.map.set(groupId, seq)
  }
}

class FakeTransport implements SyncTransport {
  messages: MailboxMessage[] = []
  commitResults: ('ok' | 'conflict')[] = []
  groupInfo: { groupInfo: string | null; epoch: number } | null = null
  failNextSend = false
  private seq = 0

  constructor(private log: string[]) {}

  async fetchMessages(_groupId: string, afterSeq: number): Promise<MailboxMessage[]> {
    this.log.push(`fetch:${afterSeq}`)
    return this.messages.filter((m) => m.seq > afterSeq)
  }
  async postCommit(_groupId: string, body: CommitBody): Promise<void> {
    this.log.push(`commit:${body.epoch}`)
    if ((this.commitResults.shift() ?? 'ok') === 'conflict') {
      throw new ConflictError(body.epoch + 1)
    }
  }
  async fetchGroupInfo(): Promise<{ groupInfo: string | null; epoch: number } | null> {
    this.log.push('groupInfo')
    return this.groupInfo
  }
  async sendCiphertext(_groupId: string, _epoch: number, _ct: string): Promise<{ seq: number }> {
    if (this.failNextSend) {
      this.failNextSend = false
      throw new Error('offline')
    }
    this.seq += 1
    this.log.push(`sendCiphertext:${this.seq}`)
    return { seq: this.seq }
  }
  async ackSeq(_groupId: string, seq: number): Promise<void> {
    this.log.push(`ackSeq:${seq}`)
  }
  async ackWelcome(welcomeId: number): Promise<void> {
    this.log.push(`ackWelcome:${welcomeId}`)
  }
}

function makeDevice(log: string[], flags: { failProcess: boolean }): MlsDeviceHandle {
  return {
    createGroup: (groupId) => {
      log.push(`createGroup:${bytesToHex(groupId).slice(0, 4)}`)
      return { snapshot: Uint8Array.of(1) }
    },
    loadGroup: (groupId) => {
      log.push(`loadGroup:${bytesToHex(groupId).slice(0, 4)}`)
    },
    addMembers: (_groupId, keyPackages) => ({
      commit: Uint8Array.of(2),
      welcomes: keyPackages.map((_, i) => Uint8Array.of(10 + i)),
      groupInfo: Uint8Array.of(3),
      snapshot: Uint8Array.of(4),
    }),
    removeMembers: () => ({
      commit: Uint8Array.of(5),
      groupInfo: Uint8Array.of(6),
      snapshot: Uint8Array.of(7),
    }),
    joinFromWelcome: (welcome) => ({
      groupId: hexToBytes(decoder.decode(welcome)),
      epoch: 1,
      members: [],
      snapshot: Uint8Array.of(8),
    }),
    externalJoin: () => ({
      groupId: hexToBytes(GROUP),
      commit: Uint8Array.of(9),
      epoch: 1,
      snapshot: Uint8Array.of(10),
    }),
    encrypt: (_groupId, plaintext) => {
      log.push('encrypt')
      return { ciphertext: plaintext, snapshot: Uint8Array.of(11) }
    },
    processIncoming: (_groupId, message) => {
      if (flags.failProcess) throw new Error('cannot decrypt')
      log.push(`process:${decoder.decode(message)}`)
      return {
        kind: 'application',
        plaintext: message,
        senderAccountId: 'friend',
        senderDeviceId: FRIEND,
        epoch: 1,
        snapshot: Uint8Array.of(12),
      }
    },
    currentGroupInfo: () => Uint8Array.of(13),
    members: () => [{ accountId: 'friend', deviceId: FRIEND, name: 'f' }],
    currentEpoch: () => 1,
  }
}

function setup(onApplication?: ApplicationSink) {
  const log: string[] = []
  const received: ApplicationMessage[] = []
  const flags = { failProcess: false }
  const snapshots = new MemorySnapshots(log)
  const cursors = new MemoryCursors()
  const transport = new FakeTransport(log)
  const device = makeDevice(log, flags)
  const engine = new MlsSyncEngine({
    device,
    deviceId: SELF,
    snapshots,
    cursors,
    transport,
    onApplication:
      onApplication ??
      ((message) => {
        log.push(`app:${message.seq}`)
        received.push(message)
      }),
    logger: { warn() {}, error() {} },
  })
  return { log, received, flags, snapshots, cursors, transport, engine }
}

describe('queue serialization', () => {
  it('does not deadlock when an entry point awaits enqueued leaf work internally', async () => {
    const { engine, transport, received, log } = setup()
    transport.messages = [makeMessage(1), makeMessage(2)]

    // handleWelcome runs on the group queue and internally awaits catchUp —
    // if catchUp were re-enqueued this would hang forever.
    await expect(engine.handleWelcome(makeWelcome())).resolves.toBe(true)

    expect(received.map((m) => m.seq)).toEqual([1, 2])
    expect(log).toContain('ackWelcome:1')
    expect(engine.hasGroup(GROUP)).toBe(true)
  })

  it('serializes concurrent entry points on the same group', async () => {
    const { engine, snapshots, log } = setup()
    snapshots.map.set(GROUP, Uint8Array.of(0)) // already a member

    let release = () => {}
    snapshots.gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const send = engine.sendApplication(GROUP, encoder.encode('hi'))
    const process = engine.processMailboxMessage(makeMessage(5))
    await tick()
    // The send's snapshot persist is gated — nothing may run ahead of it.
    expect(log).not.toContain('process:m5')

    release()
    await Promise.all([send, process])

    expect(log.indexOf('encrypt')).toBeLessThan(log.indexOf('put'))
    expect(log.indexOf('put')).toBeLessThan(log.indexOf('sendCiphertext:1'))
    expect(log.indexOf('sendCiphertext:1')).toBeLessThan(log.indexOf('process:m5'))
  })

  it('rejects a failed job to its caller without poisoning the queue', async () => {
    const { engine, transport, snapshots, received } = setup()
    snapshots.map.set(GROUP, Uint8Array.of(0))
    transport.failNextSend = true

    await expect(engine.sendApplication(GROUP, encoder.encode('x'))).rejects.toThrow('offline')
    await engine.processMailboxMessage(makeMessage(1))
    expect(received.map((m) => m.seq)).toEqual([1])
  })
})

describe('cursor monotonicity', () => {
  it('never moves backwards and skips already-processed seqs', async () => {
    const { engine, snapshots, cursors, log } = setup()
    snapshots.map.set(GROUP, Uint8Array.of(0))

    await engine.processMailboxMessage(makeMessage(5))
    expect(cursors.get(GROUP)).toBe(5)

    await engine.processMailboxMessage(makeMessage(3))
    expect(cursors.get(GROUP)).toBe(5)
    expect(log.filter((e) => e.startsWith('process:'))).toEqual(['process:m5'])
  })

  it('advances past own-device messages without decrypting or acking', async () => {
    const { engine, snapshots, cursors, log } = setup()
    snapshots.map.set(GROUP, Uint8Array.of(0))

    await engine.processMailboxMessage(makeMessage(7, SELF))
    expect(cursors.get(GROUP)).toBe(7)
    expect(log.filter((e) => e.startsWith('process:') || e.startsWith('ackSeq:'))).toEqual([])
  })

  it('joining a group never rewinds an existing cursor', async () => {
    const { engine, cursors, log } = setup()
    cursors.map.set(GROUP, 5)

    await expect(engine.handleWelcome(makeWelcome())).resolves.toBe(true)
    expect(cursors.get(GROUP)).toBe(5)
    expect(log).toContain('fetch:5') // catch-up resumed after the kept cursor
  })

  it('skips past undecryptable messages, acking them', async () => {
    const { engine, snapshots, cursors, flags, log } = setup()
    snapshots.map.set(GROUP, Uint8Array.of(0))
    flags.failProcess = true

    await engine.processMailboxMessage(makeMessage(4))
    expect(cursors.get(GROUP)).toBe(4)
    expect(log).toContain('ackSeq:4')
    expect(log).not.toContain('put') // no new snapshot to persist
  })
})

describe('persist-before-release invariants', () => {
  it('persists the snapshot before the ciphertext leaves on send', async () => {
    const { engine, snapshots, log } = setup()
    snapshots.map.set(GROUP, Uint8Array.of(0))

    const { seq } = await engine.sendApplication(GROUP, encoder.encode('hello'))
    expect(seq).toBe(1)
    expect(log.indexOf('put')).toBeGreaterThan(-1)
    expect(log.indexOf('put')).toBeLessThan(log.indexOf('sendCiphertext:1'))
  })

  it('persists the snapshot and delivers the plaintext before acking on receive', async () => {
    const { engine, snapshots, log } = setup()
    snapshots.map.set(GROUP, Uint8Array.of(0))

    await engine.processMailboxMessage(makeMessage(1))
    expect(log.indexOf('put')).toBeLessThan(log.indexOf('ackSeq:1'))
    expect(log.indexOf('app:1')).toBeLessThan(log.indexOf('ackSeq:1'))
  })

  it('still acks when the application sink throws', async () => {
    const { engine, snapshots, cursors, log } = setup(() => {
      throw new Error('bad payload')
    })
    snapshots.map.set(GROUP, Uint8Array.of(0))

    await engine.processMailboxMessage(makeMessage(1))
    expect(cursors.get(GROUP)).toBe(1)
    expect(log).toContain('ackSeq:1')
  })
})

describe('commit conflicts', () => {
  it('drops local state and reports conflict when group creation races', async () => {
    const { engine, transport, snapshots } = setup()
    transport.commitResults = ['conflict']

    const outcome = await engine.createGroupWithMembers(GROUP, [
      { deviceId: FRIEND, keyPackage: Uint8Array.of(42) },
    ])
    expect(outcome).toBe('conflict')
    expect(engine.hasGroup(GROUP)).toBe(false)
    expect(await snapshots.get(GROUP)).toBeNull()
  })

  it('creates the group and advances the cursor on success', async () => {
    const { engine, cursors } = setup()
    const outcome = await engine.createGroupWithMembers(GROUP, [
      { deviceId: FRIEND, keyPackage: Uint8Array.of(42) },
    ])
    expect(outcome).toBe('created')
    expect(engine.hasGroup(GROUP)).toBe(true)
    expect(cursors.get(GROUP)).toBe(1)
  })

  it('retries an external join with refreshed group info after a conflict', async () => {
    const { engine, transport, log } = setup()
    transport.commitResults = ['conflict', 'ok']
    transport.groupInfo = { groupInfo: b64(Uint8Array.of(99)), epoch: 2 }

    const joined = await engine.externalJoinWithRetry(
      GROUP,
      { groupInfo: b64(Uint8Array.of(98)), epoch: 1 },
      SELF,
    )
    expect(joined).toBe(true)
    expect(log.filter((e) => e.startsWith('commit:'))).toEqual(['commit:1', 'commit:2'])
    expect(engine.hasGroup(GROUP)).toBe(true)
  })

  it('gives up an external join when group info disappears', async () => {
    const { engine, transport } = setup()
    transport.commitResults = ['conflict']
    transport.groupInfo = null

    const joined = await engine.externalJoinWithRetry(
      GROUP,
      { groupInfo: b64(Uint8Array.of(98)), epoch: 1 },
      SELF,
    )
    expect(joined).toBe(false)
    expect(engine.hasGroup(GROUP)).toBe(false)
  })

  it('re-reads the mailbox when a removal commit races', async () => {
    const { engine, snapshots, transport, log } = setup()
    snapshots.map.set(GROUP, Uint8Array.of(0))
    transport.commitResults = ['conflict']

    await engine.removeAccountDevices(GROUP, [FRIEND])
    expect(log).toContain('fetch:0') // catch-up after the conflict
  })
})
