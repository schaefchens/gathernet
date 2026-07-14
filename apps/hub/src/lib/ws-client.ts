import type { ClientMessage, ServerMessage } from '@gathernet/shared'
import {
  PROTOCOL_VERSION,
  parseServerMessage,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  REQUEST_TIMEOUT_MS,
  ulid,
} from '@gathernet/shared'

export type WsStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting'

type EventHandler<T extends ServerMessage['type']> = (
  message: Extract<ServerMessage, { type: T }>,
) => void

interface Pending {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * The one socket the Hub owns. Reconnects with jittered exponential backoff;
 * every send() resolves with the server's ack result or rejects on error.
 * Consumers re-sync state on each 'connected' transition (presence snapshot
 * arrives server-side; mailbox catch-up is the chat store's job).
 */
export class WsClient {
  private socket: WebSocket | null = null
  private pending = new Map<string, Pending>()
  private handlers = new Map<string, Set<(message: ServerMessage) => void>>()
  private statusHandlers = new Set<(status: WsStatus) => void>()
  private backoff = RECONNECT_MIN_MS
  private tokenProvider: () => string | null = () => null
  private shouldRun = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  status: WsStatus = 'idle'

  start(tokenProvider: () => string | null): void {
    this.tokenProvider = tokenProvider
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

  private open(phase: 'connecting' | 'reconnecting'): void {
    if (!this.shouldRun) return
    const token = this.tokenProvider()
    if (!token) return
    this.setStatus(phase)

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(`${protocol}://${location.host}/ws`)
    this.socket = socket

    socket.onopen = () => {
      const id = ulid()
      socket.send(
        JSON.stringify({
          type: 'hello',
          id,
          payload: { token, protocolVersion: PROTOCOL_VERSION },
        } satisfies ClientMessage),
      )
    }

    socket.onmessage = (event) => {
      const parsed = parseServerMessage(event.data)
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
          if (message.type === 'ack') {
            pending.resolve(message.payload.result)
          } else {
            pending.reject(new WsRequestError(message.payload.code, message.payload.message))
          }
        }
      }

      for (const handler of this.handlers.get(message.type) ?? []) handler(message)
    }

    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(new WsRequestError('disconnected'))
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
      return Promise.reject(new WsRequestError('not_connected'))
    }
    const id = ulid()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new WsRequestError('timeout'))
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
    set.add(handler as (message: ServerMessage) => void)
    return () => set.delete(handler as (message: ServerMessage) => void)
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

export class WsRequestError extends Error {
  constructor(
    readonly code: string,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code)
  }
}

export const wsClient = new WsClient()
