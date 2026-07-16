import {
  type ApplicationMessage,
  type CommitBody,
  ConflictError,
  type CursorStore,
  hexToBytes,
  MlsSyncEngine,
  type SnapshotStore,
  type SyncTransport,
} from '@gathernet/mls-sync'
import type {
  JoinRoomResponse,
  MailboxMessage,
  RoomBrowserItem,
  RoomDetailResponse,
} from '@gathernet/shared'
import { GathernetError } from '../errors.ts'
import { b64, fromB64, type HttpClient } from '../internal.ts'
import { decodeEnvelope, encodeChat, encodeIntent, intentPayload } from './envelope.ts'
import { openEphemeral, sealEphemeral } from './ephemeral.ts'
import { buildRoomDevice, type MlsDevice, type MlsModule, type RoomDevice } from './mls.ts'
import { SdkWsClient } from './ws.ts'

/* --------------------------------- types ---------------------------------- */

export interface RoomMember {
  appUserId: string
  displayName: string
  isHost: boolean
}

export interface IntentMessage {
  /** the sending member's pseudonymous appUserId */
  from: string
  payload: unknown
}

export interface ChatMessage {
  from: string
  text: string
}

export interface EphemeralMessage {
  from: string
  payload: Uint8Array
}

export interface PublicRoom {
  roomId: string
  title: string
  memberCount: number
  maxMembers: number
  compatTag: string
}

export interface CreateRoomOptions {
  title: string
  /** public → listed & anyone can join; otherwise code-only. Default false. */
  public?: boolean
  maxMembers?: number
  compatTag: string
}

export interface Room {
  readonly roomId: string
  readonly code: string
  members(): RoomMember[]
  onMembers(cb: (members: RoomMember[]) => void): () => void
  /** Send a structured app intent (object) or raw bytes to every member. */
  send(payload: unknown): Promise<void>
  onMessage(cb: (message: IntentMessage) => void): () => void
  readonly chat: {
    send(text: string): Promise<void>
    onMessage(cb: (message: ChatMessage) => void): () => void
  }
  readonly ephemeral: {
    send(payload: Uint8Array): Promise<void>
    on(cb: (message: EphemeralMessage) => void): () => void
  }
  readonly host: {
    kick(appUserId: string): Promise<void>
    close(): Promise<void>
  }
  leave(): Promise<void>
  onClosed(cb: (reason: string) => void): () => void
}

/* ------------------------------ in-memory stores -------------------------- */

/**
 * Room MLS state is EPHEMERAL in M2: kept only in memory, never persisted.
 * A browser reload or process restart drops it, and the client re-joins from
 * scratch. (DMs, by contrast, persist their snapshots.)
 */
class MemorySnapshotStore implements SnapshotStore {
  private readonly map = new Map<string, Uint8Array>()
  get(groupId: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.map.get(groupId) ?? null)
  }
  put(groupId: string, snapshot: Uint8Array): Promise<void> {
    this.map.set(groupId, snapshot)
    return Promise.resolve()
  }
  delete(groupId: string): Promise<void> {
    this.map.delete(groupId)
    return Promise.resolve()
  }
  keys(): Promise<string[]> {
    return Promise.resolve([...this.map.keys()])
  }
}

class MemoryCursorStore implements CursorStore {
  private readonly map = new Map<string, number>()
  get(groupId: string): number {
    return this.map.get(groupId) ?? 0
  }
  set(groupId: string, seq: number): void {
    this.map.set(groupId, seq)
  }
}

/* ------------------------------- transport -------------------------------- */

/**
 * Wires the sync engine to the rooms HTTP + WS surface. Room commits ride
 * POST /app/rooms/:id/commits (the committing app device is named in the
 * body); application ciphertext + acks ride the WebSocket. There is no
 * app-surface mailbox catch-up endpoint in M2, so `fetchMessages` returns
 * nothing — rooms rely entirely on live WS delivery.
 */
class RoomSyncTransport implements SyncTransport {
  constructor(
    private readonly http: HttpClient,
    private readonly ws: SdkWsClient,
    private readonly deviceId: string,
  ) {}

  fetchMessages(): Promise<MailboxMessage[]> {
    return Promise.resolve([])
  }

  async postCommit(groupId: string, body: CommitBody): Promise<void> {
    try {
      await this.http.request('POST', `/api/v1/app/rooms/${groupId}/commits`, {
        json: { ...body, deviceId: this.deviceId },
      })
    } catch (err) {
      if (err instanceof GathernetError && err.status === 409) throw new ConflictError()
      throw err
    }
  }

  async fetchGroupInfo(
    groupId: string,
  ): Promise<{ groupInfo: string | null; epoch: number } | null> {
    const { data } = await this.http.request<RoomDetailResponse>(
      'GET',
      `/api/v1/app/rooms/${groupId}`,
    )
    return { groupInfo: data.groupInfo, epoch: data.epoch }
  }

  async sendCiphertext(
    groupId: string,
    epoch: number,
    ciphertextB64: string,
  ): Promise<{ seq: number }> {
    const result = (await this.ws.send('chat.send', {
      groupId,
      epoch,
      ciphertext: ciphertextB64,
    })) as { seq: number }
    return { seq: result.seq }
  }

  async ackSeq(groupId: string, seq: number): Promise<void> {
    await this.ws.send('chat.ack', { groupId, seq }).catch(() => undefined)
  }

  ackWelcome(): Promise<void> {
    return Promise.resolve()
  }
}

/* ------------------------------ rooms client ------------------------------ */

export interface RoomsClientOptions {
  http: HttpClient
  serverUrl: string
  getToken: () => string | null
  self: () => { appUserId: string; displayName: string }
  /** Dynamically import + initialize @gathernet/mls-client (browser or Node). */
  initMls: () => Promise<MlsModule>
  /** Reuse a fixed 32-byte device seed (stable bot identity); omit to generate. */
  deviceSecret?: Uint8Array
}

interface PendingJoin {
  resolve: (payload: { roomId: string; groupInfo: string | null; epoch: number }) => void
  reject: (err: Error) => void
}

export class RoomsClient {
  private readonly rooms = new Map<string, RoomImpl>()
  private ready: Promise<Ready> | null = null
  private readonly pendingJoins: PendingJoin[] = []

  constructor(private readonly options: RoomsClientOptions) {}

  /** List public rooms for this app (HTTP only — no MLS init required). */
  async listPublic(): Promise<PublicRoom[]> {
    const { data } = await this.options.http.request<{ rooms: RoomBrowserItem[] }>(
      'GET',
      '/api/v1/app/rooms',
    )
    return data.rooms.map((r) => ({
      roomId: r.roomId,
      title: r.title,
      memberCount: r.memberCount,
      maxMembers: r.maxMembers,
      compatTag: r.compatTag,
    }))
  }

  async create(options: CreateRoomOptions): Promise<Room> {
    const ctx = await this.ensureReady()
    const visibility = options.public ? 'public' : 'private'
    const json: Record<string, unknown> = {
      visibility,
      title: options.title,
      compatTag: options.compatTag,
    }
    if (options.maxMembers !== undefined) json.maxMembers = options.maxMembers
    const { data } = await this.options.http.request<{ roomId: string; code: string }>(
      'POST',
      '/api/v1/app/rooms',
      { json },
    )

    const groupIdBytes = hexToBytes(data.roomId)
    const created = ctx.device.device.createGroup(groupIdBytes)
    await ctx.snapshots.put(data.roomId, created.snapshot)
    const groupInfo = ctx.device.device.currentGroupInfo(groupIdBytes)
    await this.options.http.request('POST', `/api/v1/app/rooms/${data.roomId}/group-info`, {
      json: { groupInfo: b64(groupInfo), deviceId: ctx.device.deviceId },
    })

    const room = this.attach(ctx, data.roomId, data.code)
    await room.refreshMembers()
    return room
  }

  async joinByCode(code: string, options: { compatTag: string }): Promise<Room> {
    const ctx = await this.ensureReady()
    const { data } = await this.options.http.request<JoinRoomResponse>(
      'POST',
      '/api/v1/app/rooms/join',
      { json: { code, compatTag: options.compatTag, deviceId: ctx.device.deviceId } },
    )

    if (data.status === 'joined') {
      return this.completeJoin(ctx, data.roomId, code, {
        groupInfo: data.groupInfo,
        epoch: data.epoch,
      })
    }

    // pending → the host must approve; resolve when room.join_approved arrives.
    const approval = await new Promise<{
      roomId: string
      groupInfo: string | null
      epoch: number
    }>((resolve, reject) => {
      this.pendingJoins.push({ resolve, reject })
    })
    return this.completeJoin(ctx, approval.roomId, code, {
      groupInfo: approval.groupInfo,
      epoch: approval.epoch,
    })
  }

  /** Tear down the WebSocket and drop all room state. */
  async close(): Promise<void> {
    const ctx = this.ready ? await this.ready.catch(() => null) : null
    ctx?.ws.stop()
    ctx?.device.device.free()
    this.rooms.clear()
    this.ready = null
  }

  /* ------------------------------ internals ------------------------------ */

  private ensureReady(): Promise<Ready> {
    this.ready ??= this.init()
    return this.ready
  }

  private async init(): Promise<Ready> {
    const mls = await this.options.initMls()
    const self = this.options.self()
    const device = buildRoomDevice(mls, self.appUserId, this.options.deviceSecret)

    const { data } = await this.options.http.request<{ deviceId: string }>(
      'POST',
      '/api/v1/app/devices',
      { json: { devicePk: b64(device.publicKey), name: self.appUserId } },
    )
    const deviceId = data.deviceId

    const snapshots = new MemorySnapshotStore()
    const cursors = new MemoryCursorStore()
    const wsUrl = `${this.options.serverUrl.replace(/^http/, 'ws')}/ws`
    const ws = new SdkWsClient({ url: wsUrl, getToken: this.options.getToken, deviceId })
    const transport = new RoomSyncTransport(this.options.http, ws, deviceId)
    const engine = new MlsSyncEngine({
      device: device.device,
      deviceId,
      snapshots,
      cursors,
      transport,
      onApplication: (message) => this.onApplication(message),
    })

    const ctx: Ready = { mls, device, deviceId, snapshots, cursors, ws, engine }

    ws.on('chat.message', (message) => {
      void engine.processMailboxMessage(message.payload as unknown as MailboxMessage)
    })
    ws.on('room.ephemeral', (message) => {
      const room = this.rooms.get(message.payload.groupId)
      room?.onEphemeral(
        message.payload.senderDevice,
        message.payload.epoch,
        message.payload.payload,
      )
    })
    ws.on('room.member_joined', (message) => {
      this.rooms
        .get(message.payload.roomId)
        ?.onMemberJoined(message.payload.appUserId, message.payload.displayName)
    })
    ws.on('room.member_left', (message) => {
      this.rooms.get(message.payload.roomId)?.onMemberGone(message.payload.appUserId)
    })
    ws.on('room.member_kicked', (message) => {
      this.rooms.get(message.payload.roomId)?.onMemberGone(message.payload.appUserId)
    })
    ws.on('room.host_changed', (message) => {
      this.rooms.get(message.payload.roomId)?.onHostChanged(message.payload.hostAppUserId)
    })
    ws.on('room.join_approved', (message) => {
      const waiter = this.pendingJoins.shift()
      waiter?.resolve({
        roomId: message.payload.roomId,
        groupInfo: message.payload.groupInfo,
        epoch: message.payload.epoch,
      })
    })
    ws.on('room.join_declined', () => {
      this.pendingJoins.shift()?.reject(new GathernetError('denied', 'join request declined'))
    })
    ws.on('room.closed', (message) => {
      this.rooms.get(message.payload.roomId)?.onClosedByServer(message.payload.reason)
    })

    ws.start()
    await ws.whenConnected()
    return ctx
  }

  private async completeJoin(
    ctx: Ready,
    roomId: string,
    code: string,
    info: { groupInfo: string | null; epoch: number },
  ): Promise<Room> {
    const joined = await ctx.engine.externalJoinWithRetry(
      roomId,
      { groupInfo: info.groupInfo, epoch: info.epoch },
      ctx.deviceId,
    )
    if (!joined) throw new GathernetError('server', 'could not join the room MLS group')
    const room = this.attach(ctx, roomId, code)
    await room.refreshMembers()
    return room
  }

  private attach(ctx: Ready, roomId: string, code: string): RoomImpl {
    const existing = this.rooms.get(roomId)
    if (existing) return existing
    const room = new RoomImpl(ctx, this.options.http, this.options.self, roomId, code)
    this.rooms.set(roomId, room)
    return room
  }

  private onApplication(message: ApplicationMessage): void {
    const room = this.rooms.get(message.groupId)
    if (!room || !message.plaintext || !message.senderDeviceId) return
    room.onIncoming(message.senderDeviceId, message.plaintext)
  }
}

interface Ready {
  mls: MlsModule
  device: RoomDevice
  deviceId: string
  snapshots: MemorySnapshotStore
  cursors: MemoryCursorStore
  ws: SdkWsClient
  engine: MlsSyncEngine
}

/* --------------------------------- Room ----------------------------------- */

class RoomImpl implements Room {
  private readonly groupIdBytes: Uint8Array
  private members_ = new Map<string, RoomMember>()
  private hostAppUserId = ''
  private closed = false

  private readonly intentCbs = new Set<(m: IntentMessage) => void>()
  private readonly chatCbs = new Set<(m: ChatMessage) => void>()
  private readonly ephemeralCbs = new Set<(m: EphemeralMessage) => void>()
  private readonly memberCbs = new Set<(m: RoomMember[]) => void>()
  private readonly closedCbs = new Set<(reason: string) => void>()

  constructor(
    private readonly ctx: Ready,
    private readonly http: HttpClient,
    private readonly self: () => { appUserId: string; displayName: string },
    readonly roomId: string,
    readonly code: string,
  ) {
    this.groupIdBytes = hexToBytes(roomId)
  }

  members(): RoomMember[] {
    return [...this.members_.values()]
  }

  onMembers(cb: (members: RoomMember[]) => void): () => void {
    this.memberCbs.add(cb)
    return () => this.memberCbs.delete(cb)
  }

  async send(payload: unknown): Promise<void> {
    await this.ctx.engine.sendApplication(this.roomId, encodeIntent(payload))
    // MLS senders can't decrypt their own ciphertext and the server excludes
    // them from fan-out, so echo locally for a uniform, converged stream.
    this.emitIntent({ from: this.self().appUserId, payload })
  }

  onMessage(cb: (message: IntentMessage) => void): () => void {
    this.intentCbs.add(cb)
    return () => this.intentCbs.delete(cb)
  }

  readonly chat = {
    send: async (text: string): Promise<void> => {
      await this.ctx.engine.sendApplication(this.roomId, encodeChat(text))
      this.emitChat({ from: this.self().appUserId, text })
    },
    onMessage: (cb: (message: ChatMessage) => void): (() => void) => {
      this.chatCbs.add(cb)
      return () => this.chatCbs.delete(cb)
    },
  }

  readonly ephemeral = {
    send: async (payload: Uint8Array): Promise<void> => {
      const epoch = this.ctx.device.device.currentEpoch(this.groupIdBytes)
      const sealed = sealEphemeral(
        this.ctx.mls,
        this.ctx.device.device,
        this.groupIdBytes,
        this.roomId,
        epoch,
        payload,
      )
      await this.ctx.ws.send('room.ephemeral', {
        groupId: this.roomId,
        epoch,
        payload: b64(sealed),
      })
    },
    on: (cb: (message: EphemeralMessage) => void): (() => void) => {
      this.ephemeralCbs.add(cb)
      return () => this.ephemeralCbs.delete(cb)
    },
  }

  readonly host = {
    kick: async (appUserId: string): Promise<void> => {
      await this.http.request('POST', `/api/v1/app/rooms/${this.roomId}/kick`, {
        json: { appUserId },
      })
      // Cryptographically evict the kicked member's MLS leaves too (cert name
      // == appUserId). Best-effort — the server already revoked membership.
      const leaves = this.ctx.device.device
        .members(this.groupIdBytes)
        .filter((m) => m.name === appUserId)
        .map((m) => m.deviceId)
      if (leaves.length > 0) {
        await this.ctx.engine.removeAccountDevices(this.roomId, leaves).catch(() => undefined)
      }
    },
    close: async (): Promise<void> => {
      await this.http.request('POST', `/api/v1/app/rooms/${this.roomId}/close`)
    },
  }

  async leave(): Promise<void> {
    await this.http.request('POST', `/api/v1/app/rooms/${this.roomId}/leave`)
  }

  onClosed(cb: (reason: string) => void): () => void {
    this.closedCbs.add(cb)
    return () => this.closedCbs.delete(cb)
  }

  /* ---------------------- events from RoomsClient ----------------------- */

  async refreshMembers(): Promise<void> {
    const { data } = await this.http.request<RoomDetailResponse>(
      'GET',
      `/api/v1/app/rooms/${this.roomId}`,
    )
    this.hostAppUserId = data.hostAppUserId
    this.members_ = new Map(
      data.members.map((m) => [
        m.appUserId,
        { appUserId: m.appUserId, displayName: m.displayName, isHost: m.isHost },
      ]),
    )
    this.emitMembers()
  }

  onIncoming(senderDeviceId: string, plaintext: Uint8Array): void {
    const env = decodeEnvelope(plaintext)
    if (!env) return
    const from = this.appUserIdOf(senderDeviceId) ?? ''
    if (env.c === 'chat') this.emitChat({ from, text: env.d })
    else this.emitIntent({ from, payload: intentPayload(env) })
  }

  onEphemeral(senderDeviceId: string, epoch: number, sealedB64: string): void {
    let payload: Uint8Array
    try {
      payload = openEphemeral(
        this.ctx.mls,
        this.ctx.device.device,
        this.groupIdBytes,
        this.roomId,
        epoch,
        fromB64(sealedB64),
      )
    } catch {
      return // wrong epoch or tampered — drop silently
    }
    const from = this.appUserIdOf(senderDeviceId) ?? ''
    for (const cb of this.ephemeralCbs) cb({ from, payload })
  }

  onMemberJoined(appUserId: string, displayName: string): void {
    this.members_.set(appUserId, {
      appUserId,
      displayName,
      isHost: appUserId === this.hostAppUserId,
    })
    this.emitMembers()
  }

  onMemberGone(appUserId: string): void {
    this.members_.delete(appUserId)
    this.emitMembers()
  }

  onHostChanged(hostAppUserId: string): void {
    this.hostAppUserId = hostAppUserId
    for (const [id, m] of this.members_) {
      this.members_.set(id, { ...m, isHost: id === hostAppUserId })
    }
    this.emitMembers()
  }

  onClosedByServer(reason: string): void {
    if (this.closed) return
    this.closed = true
    for (const cb of this.closedCbs) cb(reason)
  }

  private appUserIdOf(deviceId: string): string | undefined {
    return this.ctx.device.device.members(this.groupIdBytes).find((m) => m.deviceId === deviceId)
      ?.name
  }

  private emitIntent(message: IntentMessage): void {
    for (const cb of this.intentCbs) cb(message)
  }

  private emitChat(message: ChatMessage): void {
    for (const cb of this.chatCbs) cb(message)
  }

  private emitMembers(): void {
    const list = this.members()
    for (const cb of this.memberCbs) cb(list)
  }
}
