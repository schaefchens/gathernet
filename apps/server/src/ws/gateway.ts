import fastifyWebsocket from '@fastify/websocket'
import type {
  AccountId,
  AppId,
  AppScope,
  AppUserId,
  ClientMessage,
  DeviceId,
  ServerMessage,
} from '@gathernet/shared'
import {
  HELLO_TIMEOUT_MS,
  PROTOCOL_VERSION,
  parseClientMessage,
  WS_PING_INTERVAL_MS,
} from '@gathernet/shared'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'

export type WsSessionKind = 'user' | 'app'

/** Hub device session (`gn.` token). */
export interface WsUserIdentity {
  kind: 'user'
  accountId: AccountId
  deviceId: DeviceId
}

/**
 * App session (`gna.` token, scope 'rooms'). Account-scoped tokens carry no
 * device, so the socket binds to a registered app_devices row — either the
 * one named in the hello payload or the account's newest one.
 */
export interface WsAppIdentity {
  kind: 'app'
  accountId: AccountId
  /** the app_devices id this socket speaks MLS as */
  deviceId: DeviceId
  appId: AppId
  appUserId: AppUserId
  scopes: AppScope[]
}

export type WsIdentity = WsUserIdentity | WsAppIdentity

/** Resolves a hello token (`gn.` or `gna.`) to an identity. */
export interface WsAuthenticator {
  verifyToken(token: string, hello?: { deviceId?: string }): Promise<WsIdentity | null>
}

export type WsSession = WsIdentity & {
  socket: WebSocket
  send(message: ServerMessage): void
}

export type WsMessageHandler = (
  session: WsSession,
  message: Extract<ClientMessage, { type: string }>,
) => Promise<void>

/** Handler plus the session kinds allowed to invoke it. */
export interface WsHandlerEntry {
  kinds: readonly WsSessionKind[]
  handler: WsMessageHandler
}

export interface HelloInfo {
  kpRemaining: number
  pending: { welcomes: number; messages: number }
}

export interface WsGatewayOptions {
  authenticator: WsAuthenticator
  /** Called once a socket completes the hello handshake. */
  onSessionOpen?: (session: WsSession) => void
  onSessionClose?: (session: WsSession) => void
  /** Per-type handlers for post-hello messages, gated by session kind. */
  handlers?: Partial<Record<ClientMessage['type'], WsHandlerEntry>>
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
          const identity = await options.authenticator.verifyToken(
            message.payload.token,
            message.payload.deviceId ? { deviceId: message.payload.deviceId } : {},
          )
          if (
            !identity ||
            identity.kind !== session.kind ||
            identity.deviceId !== session.deviceId
          ) {
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
        const identity = await options.authenticator.verifyToken(
          message.payload.token,
          message.payload.deviceId ? { deviceId: message.payload.deviceId } : {},
        )
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

      const entry = options.handlers?.[message.type]
      // A message type not allowed for this session kind behaves exactly
      // like an unimplemented type.
      if (!entry || !entry.kinds.includes(session.kind)) {
        sendMessage(socket, {
          type: 'error',
          replyTo: message.id,
          payload: { code: 'not_implemented' },
        })
        return
      }
      try {
        await entry.handler(session, message)
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
