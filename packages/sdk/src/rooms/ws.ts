import type { ClientMessage, DeviceId, ServerMessage } from '@gathernet/shared'
import {
  PROTOCOL_VERSION,
  parseServerMessage,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  REQUEST_TIMEOUT_MS,
  ulid,
} from '@gathernet/shared'

/**
 * A transport-agnostic WebSocket client for the SDK, adapted from the Hub's
 * ws-client. Parameterized by URL + token + deviceId so it works for both the
 * browser SDK and the Node server SDK — both rely on the global `WebSocket`
 * (present in browsers and Node >= 22).
 */

export type WsStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting'

type EventHandler<T extends ServerMessage['type']> = (
  message: Extract<ServerMessage, { type: T }>,
) => void

interface Pending {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class SdkWsRequestError extends Error {
  constructor(
    readonly code: string,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'SdkWsRequestError'
  }
}

export interface SdkWsOptions {
  /** Full ws:// or wss:// URL of the /ws endpoint. */
  url: string
  /** Current `gna.` token, re-read on every (re)connect. */
  getToken: () => string | null
  /** The registered app device id this socket speaks MLS as. */
  deviceId: string
}

export class SdkWsClient {
  private socket: WebSocket | null = null
  private readonly pending = new Map<string, Pending>()
  private readonly handlers = new Map<string, Set<(message: ServerMessage) => void>>()
  private readonly statusHandlers = new Set<(status: WsStatus) => void>()
  private backoff = RECONNECT_MIN_MS
  private shouldRun = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  status: WsStatus = 'idle'

  constructor(private readonly options: SdkWsOptions) {}

  start(): void {
    this.shouldRun = true
    this.open('connecting')
  }

  stop(): void {
    this.shouldRun = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.socket?.close()
    this.socket = null
    this.setStatus('idle')
  }

  /** Resolves once the socket has completed the hello handshake. */
  whenConnected(): Promise<void> {
    if (this.status === 'connected') return Promise.resolve()
    return new Promise((resolve) => {
      const off = this.onStatus((status) => {
        if (status === 'connected') {
          off()
          resolve()
        }
      })
    })
  }

  private open(phase: 'connecting' | 'reconnecting'): void {
    if (!this.shouldRun) return
    const token = this.options.getToken()
    if (!token) return
    this.setStatus(phase)

    const socket = new WebSocket(this.options.url)
    this.socket = socket

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: 'hello',
          id: ulid(),
          payload: {
            token,
            protocolVersion: PROTOCOL_VERSION,
            deviceId: this.options.deviceId as DeviceId,
          },
        } satisfies ClientMessage),
      )
    }

    socket.onmessage = (event: MessageEvent) => {
      const parsed = parseServerMessage(
        typeof event.data === 'string' ? event.data : String(event.data),
      )
      if (!parsed.ok) return
      const message = parsed.message

      if (message.type === 'hello.ok') {
        this.backoff = RECONNECT_MIN_MS
        this.setStatus('connected')
      }
      if (message.type === 'hello.error' || message.type === 'session.revoked') {
        this.shouldRun = false
      }

      if ((message.type === 'ack' || message.type === 'error') && message.replyTo) {
        const pending = this.pending.get(message.replyTo)
        if (pending) {
          this.pending.delete(message.replyTo)
          clearTimeout(pending.timer)
          if (message.type === 'ack') pending.resolve(message.payload.result)
          else pending.reject(new SdkWsRequestError(message.payload.code, message.payload.message))
        }
      }

      for (const handler of this.handlers.get(message.type) ?? []) handler(message)
    }

    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(new SdkWsRequestError('disconnected'))
      }
      this.pending.clear()
      if (this.shouldRun) {
        const delay = this.backoff + Math.random() * this.backoff * 0.3
        this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS)
        this.setStatus('reconnecting')
        this.reconnectTimer = setTimeout(() => this.open('reconnecting'), delay)
      } else {
        this.setStatus('idle')
      }
    }
  }

  /** Sends a message and resolves with the ack's `result` payload. */
  send(type: ClientMessage['type'], payload: unknown): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN || this.status !== 'connected') {
      return Promise.reject(new SdkWsRequestError('not_connected'))
    }
    const id = ulid()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new SdkWsRequestError('timeout'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ type, id, payload }))
    })
  }

  on<T extends ServerMessage['type']>(type: T, handler: EventHandler<T>): () => void {
    let set = this.handlers.get(type)
    if (!set) {
      set = new Set()
      this.handlers.set(type, set)
    }
    const wrapped = handler as (message: ServerMessage) => void
    set.add(wrapped)
    return () => set.delete(wrapped)
  }

  onStatus(handler: (status: WsStatus) => void): () => void {
    this.statusHandlers.add(handler)
    return () => this.statusHandlers.delete(handler)
  }

  private setStatus(status: WsStatus): void {
    if (this.status === status) return
    this.status = status
    for (const handler of this.statusHandlers) handler(status)
  }
}
