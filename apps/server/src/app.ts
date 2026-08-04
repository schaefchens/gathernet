import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import type { AccountId, AppId, AppUserId, DeviceId, GroupId } from '@gathernet/shared'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Config } from './config.ts'
import type { Db } from './db/index.ts'
import { registerAccountRoutes } from './modules/accounts/routes.ts'
import { ServiceError } from './modules/accounts/service.ts'
import { allowedAppOrigins } from './modules/apps/origins.ts'
import { registerAppRoutes } from './modules/apps/routes.ts'
import { verifyAppSessionToken } from './modules/apps/sessions.ts'
import { verifySessionToken } from './modules/auth/sessions.ts'
import { registerCommunityRoutes } from './modules/communities/routes.ts'
import { isActiveChannelMember } from './modules/communities/service.ts'
import { registerDeliveryRoutes } from './modules/delivery/routes.ts'
import {
  ackCursor,
  ackWelcome,
  createDmGroup,
  EpochConflictError,
  helloInfo,
  postMessage,
} from './modules/delivery/service.ts'
import { registerFriendRoutes } from './modules/friends/routes.ts'
import { registerMediaRoutes } from './modules/media/routes.ts'
import { PresenceService } from './modules/presence/service.ts'
import { registerPublicationRoutes } from './modules/publications/routes.ts'
import { registerPushRoutes } from './modules/push/routes.ts'
import { configureWebPush, notifyMessageActivity } from './modules/push/service.ts'
import { makeRoomEphemeralHandler } from './modules/rooms/ephemeral.ts'
import { registerRoomRoutes } from './modules/rooms/routes.ts'
import { resolveAppDevice } from './modules/rooms/service.ts'
import { makeAppAuthenticate } from './plugins/app-auth.ts'
import { makeAuthenticate } from './plugins/auth.ts'
import { type BlobStore, S3BlobStore } from './storage/blob-store.ts'
import { registerWsGateway, type WsAuthenticator, type WsMessageHandler } from './ws/gateway.ts'
import { ConnectionRegistry } from './ws/registry.ts'

export interface BuildAppOptions {
  config: Config
  db: Db
  /** Test seam; defaults to real session-token verification. */
  authenticator?: WsAuthenticator
  /** Test seam; defaults to the S3/RustFS store. Tests inject an in-memory one. */
  blobStore?: BlobStore
}

export interface GathernetApp {
  app: FastifyInstance
  registry: ConnectionRegistry
  presence: PresenceService
}

export async function buildApp(options: BuildAppOptions): Promise<GathernetApp> {
  const { config, db } = options
  // Object storage for encrypted media. Tests inject an in-memory store; otherwise
  // the S3/RustFS-backed store (bucket ensured to exist on boot).
  let blobStore: BlobStore
  if (options.blobStore) {
    blobStore = options.blobStore
  } else {
    const s3 = new S3BlobStore({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      accessKey: config.S3_ACCESS_KEY,
      secretKey: config.S3_SECRET_KEY,
      bucket: config.S3_BUCKET,
    })
    await s3.ensureBucket()
    blobStore = s3
  }
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
  })

  if (config.RATE_LIMIT_ENABLED) {
    await app.register(rateLimit, {
      global: true,
      max: 300,
      timeWindow: '1 minute',
    })
  }

  // Encrypted app-storage blobs arrive as raw bytes.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  )

  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('x-frame-options', 'DENY')
    reply.header('referrer-policy', 'no-referrer')
  })

  // Cross-origin access for SDK apps on registered origins only. The Hub is
  // same-origin (dev proxy / same host in prod) and never needs CORS.
  await app.register(cors, {
    origin: async (origin: string | undefined) => {
      if (!origin) return false
      const allowed = await allowedAppOrigins(db)
      return allowed.has(origin)
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'if-match', 'if-none-match'],
    exposedHeaders: ['etag'],
    credentials: false,
  })

  const registry = new ConnectionRegistry()
  const authenticate = makeAuthenticate(db)
  const appAuthenticate = (scope?: 'identity' | 'storage' | 'rooms') =>
    makeAppAuthenticate(db, scope)

  // One /ws endpoint, two token kinds: `gn.` device sessions (Hub) and
  // `gna.` app sessions (SDK, scope 'rooms'). App sessions are account-scoped
  // and bind to a registered app_devices row for their MLS leaf.
  const authenticator: WsAuthenticator = options.authenticator ?? {
    async verifyToken(token, hello) {
      if (token.startsWith('gna.')) {
        const identity = await verifyAppSessionToken(db, token)
        if (!identity || !identity.scopes.includes('rooms')) return null
        const device = await resolveAppDevice(
          db,
          identity.appId,
          identity.accountId,
          hello?.deviceId,
        )
        if (!device) return null
        return {
          kind: 'app',
          accountId: identity.accountId as AccountId,
          deviceId: device.deviceId as DeviceId,
          appId: identity.appId as AppId,
          appUserId: identity.appUserId as AppUserId,
          scopes: identity.scopes,
        }
      }
      const identity = await verifySessionToken(db, token)
      return identity
        ? { kind: 'user', accountId: identity.accountId, deviceId: identity.deviceId }
        : null
    },
  }

  app.get('/healthz', async () => ({ ok: true, now: Date.now() }))

  const presence = new PresenceService(db, registry)

  registerAccountRoutes(app, { db, registry, authenticate })
  registerFriendRoutes(app, {
    db,
    registry,
    authenticate,
    onFriendshipCreated: async (inviterAccountId, accepterAccountId) => {
      await createDmGroup(db, registry, inviterAccountId, accepterAccountId)
      // New friends need each other's current presence — the connect-time
      // snapshot predates the friendship.
      for (const [self, other] of [
        [inviterAccountId, accepterAccountId],
        [accepterAccountId, inviterAccountId],
      ] as const) {
        registry.sendToAccount(self, {
          type: 'presence.update',
          payload: {
            accountId: other as AccountId,
            status: presence.effectiveStatus(other),
          },
        })
      }
    },
  })
  registerDeliveryRoutes(app, { db, registry, authenticate })
  registerMediaRoutes(app, { db, blobStore, authenticate })
  registerPublicationRoutes(app, { db, authenticate })
  registerAppRoutes(app, { db, registry, authenticate, appAuthenticate })
  registerRoomRoutes(app, { db, registry, appAuthenticate })
  registerCommunityRoutes(app, { db, registry, blobStore, authenticate })
  configureWebPush(config)
  registerPushRoutes(app, { db, vapidPublicKey: config.VAPID_PUBLIC_KEY, authenticate })

  const chatSendHandler: WsMessageHandler = async (session, message) => {
    if (message.type !== 'chat.send') return
    try {
      const fanout = await postMessage(
        db,
        session.deviceId,
        message.payload.groupId,
        message.payload.epoch,
        message.payload.ciphertext,
      )
      if (fanout.mode === 'group_key') {
        // Scalable fan-out: nudge subscribed (currently-open) sockets with just
        // the seq; they pull the ciphertext from the mailbox. No per-member push.
        registry.nudgeChannel(message.payload.groupId, {
          type: 'channel.updated',
          payload: { channelId: message.payload.groupId as GroupId, seq: fanout.seq },
        })
      } else {
        for (const recipient of fanout.recipients) {
          registry.sendToDevice(recipient, {
            type: 'chat.message',
            payload: {
              groupId: message.payload.groupId,
              seq: fanout.seq,
              kind: 'application',
              epoch: fanout.epoch,
              senderDevice: fanout.senderDevice as DeviceId,
              payload: fanout.payload,
              sentAt: Date.now(),
            },
          })
        }
        // Offline-fallback Web Push: a recipient device with no live socket gets a
        // content-free category ping (coalesced). Fire-and-forget — never blocks/breaks
        // message delivery.
        const offline = fanout.recipients.filter((d) => !registry.isDeviceOnline(d))
        if (offline.length > 0) {
          void notifyMessageActivity(db, message.payload.groupId, offline)
        }
      }
      session.send({
        type: 'ack',
        replyTo: message.id,
        payload: { result: { seq: fanout.seq } },
      })
    } catch (err) {
      if (err instanceof EpochConflictError) {
        session.send({
          type: 'error',
          replyTo: message.id,
          payload: { code: 'epoch_conflict', message: String(err.currentEpoch) },
        })
        return
      }
      if (err instanceof ServiceError) {
        session.send({ type: 'error', replyTo: message.id, payload: { code: err.code } })
        return
      }
      throw err
    }
  }

  await registerWsGateway(app, {
    authenticator,
    helloInfo: (identity) => helloInfo(db, identity.deviceId),
    onSessionOpen: (session) => {
      registry.add(session)
      // Presence is a Hub concept — app sessions never join it.
      if (session.kind !== 'user') return
      void presence.onConnect(session).catch((err) => app.log.error({ err }, 'presence connect'))
    },
    onSessionClose: (session) => {
      registry.remove(session)
      if (session.kind !== 'user') return
      void presence
        .onDisconnect(session)
        .catch((err) => app.log.error({ err }, 'presence disconnect'))
    },
    handlers: {
      'presence.set': {
        kinds: ['user'],
        handler: async (session, message) => {
          if (message.type !== 'presence.set') return
          await presence.set(session, message.payload.status)
          session.send({ type: 'ack', replyTo: message.id, payload: {} })
        },
      },
      // App devices send room ciphertext through the same path; postMessage's
      // group_members check authorizes both kinds.
      'chat.send': { kinds: ['user', 'app'], handler: chatSendHandler },
      'chat.ack': {
        kinds: ['user', 'app'],
        handler: async (session, message) => {
          if (message.type !== 'chat.ack') return
          await ackCursor(db, session.deviceId, message.payload.groupId, message.payload.seq)
          session.send({ type: 'ack', replyTo: message.id, payload: {} })
        },
      },
      'welcome.ack': {
        kinds: ['user'],
        handler: async (session, message) => {
          if (message.type !== 'welcome.ack') return
          await ackWelcome(db, session.deviceId, message.payload.welcomeId)
          session.send({ type: 'ack', replyTo: message.id, payload: {} })
        },
      },
      // group_key channel delivery nudges — community channels are a Hub concept.
      'channel.subscribe': {
        kinds: ['user'],
        handler: async (session, message) => {
          if (message.type !== 'channel.subscribe') return
          if (await isActiveChannelMember(db, message.payload.channelId, session.accountId)) {
            registry.subscribeChannel(session, message.payload.channelId)
          }
          session.send({ type: 'ack', replyTo: message.id, payload: {} })
        },
      },
      'channel.unsubscribe': {
        kinds: ['user'],
        handler: async (session, message) => {
          if (message.type !== 'channel.unsubscribe') return
          registry.unsubscribeChannel(session, message.payload.channelId)
          session.send({ type: 'ack', replyTo: message.id, payload: {} })
        },
      },
      'room.ephemeral': {
        kinds: ['user', 'app'],
        handler: makeRoomEphemeralHandler(db, registry),
      },
    },
  })

  return { app, registry, presence }
}
