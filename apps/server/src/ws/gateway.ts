import fastifyWebsocket from '@fastify/websocket'
import type { AccountId, ClientMessage, DeviceId, ServerMessage } from '@gathernet/shared'
import {
  HELLO_TIMEOUT_MS,
  PROTOCOL_VERSION,
  parseClientMessage,
  WS_PING_INTERVAL_MS,
} from '@gathernet/shared'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'

export interface WsIdentity {
  accountId: AccountId
  deviceId: DeviceId
}

/** Resolves a session token to an identity; stage 3 wires this to real sessions. */
export interface WsAuthenticator {
  verifyToken(token: string): Promise<WsIdentity | null>
}

export interface WsSession extends WsIdentity {
  socket: WebSocket
  send(message: ServerMessage): void
}

export type WsMessageHandler = (
  session: WsSession,
  message: Extract<ClientMessage, { type: string }>,
) => Promise<void>

export interface HelloInfo {
  kpRemaining: number
  pending: { welcomes: number; messages: number }
}

export interface WsGatewayOptions {
  authenticator: WsAuthenticator
  /** Called once a socket completes the hello handshake. */
  onSessionOpen?: (session: WsSession) => void
  onSessionClose?: (session: WsSession) => void
  /** Per-type handlers for post-hello messages. */
  handlers?: Partial<Record<ClientMessage['type'], WsMessageHandler>>
  /** Fills key-package + mailbox counts in hello.ok (stage 6). */
  helloInfo?: (identity: WsIdentity) => Promise<HelloInfo>
}

export function sendMessage(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message))
  }
}

export async function registerWsGateway(
  app: FastifyInstance,
  options: WsGatewayOptions,
): Promise<void> {
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 1024 * 1024 },
  })

  const getInfo = async (identity: WsIdentity): Promise<HelloInfo> =>
    options.helloInfo
      ? await options.helloInfo(identity)
      : { kpRemaining: 0, pending: { welcomes: 0, messages: 0 } }

  app.get('/ws', { websocket: true }, (socket: WebSocket, request) => {
    let session: WsSession | null = null

    const helloTimer = setTimeout(() => {
      if (!session) socket.close(4401, 'hello timeout')
    }, HELLO_TIMEOUT_MS)

    let alive = true
    const pingTimer = setInterval(() => {
      if (!alive) {
        socket.terminate()
        return
      }
      alive = false
      socket.ping()
    }, WS_PING_INTERVAL_MS)

    socket.on('pong', () => {
      alive = true
    })

    socket.on('message', async (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        sendMessage(socket, { type: 'error', payload: { code: 'binary_not_supported' } })
        return
      }
      const parsed = parseClientMessage(raw.toString('utf8'))
      if (!parsed.ok) {
        sendMessage(socket, {
          type: 'error',
          payload: { code: parsed.error === 'invalid_json' ? 'invalid_json' : 'unknown_type' },
        })
        return
      }
      const message = parsed.message

      if (message.type === 'hello') {
        if (session) {
          // Token refresh mid-connection: re-verify, keep the session.
          const identity = await options.authenticator.verifyToken(message.payload.token)
          if (!identity || identity.deviceId !== session.deviceId) {
            sendMessage(socket, {
              type: 'hello.error',
              replyTo: message.id,
              payload: { code: 'unauthorized' },
            })
            socket.close(4401, 'unauthorized')
            return
          }
          sendMessage(socket, helloOk(message.id, session, await getInfo(session)))
          return
        }
        if (message.payload.protocolVersion !== PROTOCOL_VERSION) {
          sendMessage(socket, {
            type: 'hello.error',
            replyTo: message.id,
            payload: { code: 'protocol_version' },
          })
          socket.close(4400, 'protocol version')
          return
        }
        const identity = await options.authenticator.verifyToken(message.payload.token)
        if (!identity) {
          sendMessage(socket, {
            type: 'hello.error',
            replyTo: message.id,
            payload: { code: 'unauthorized' },
          })
          socket.close(4401, 'unauthorized')
          return
        }
        clearTimeout(helloTimer)
        session = {
          ...identity,
          socket,
          send: (m) => sendMessage(socket, m),
        }
        sendMessage(socket, helloOk(message.id, session, await getInfo(session)))
        options.onSessionOpen?.(session)
        return
      }

      if (!session) {
        sendMessage(socket, {
          type: 'error',
          payload: { code: 'unauthenticated' },
        })
        socket.close(4401, 'hello required')
        return
      }

      const handler = options.handlers?.[message.type]
      if (!handler) {
        sendMessage(socket, {
          type: 'error',
          replyTo: message.id,
          payload: { code: 'not_implemented' },
        })
        return
      }
      try {
        await handler(session, message)
      } catch (err) {
        request.log.error({ err, type: message.type }, 'ws handler failed')
        sendMessage(socket, {
          type: 'error',
          replyTo: message.id,
          payload: { code: 'internal' },
        })
      }
    })

    socket.on('close', () => {
      clearTimeout(helloTimer)
      clearInterval(pingTimer)
      if (session) options.onSessionClose?.(session)
    })
  })
}

function helloOk(replyTo: string, session: WsIdentity, info: HelloInfo): ServerMessage {
  return {
    type: 'hello.ok',
    replyTo,
    payload: {
      accountId: session.accountId,
      deviceId: session.deviceId,
      serverTime: Date.now(),
      kpRemaining: info.kpRemaining,
      pending: info.pending,
    },
  }
}
