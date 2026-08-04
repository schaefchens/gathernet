import {
  subscribePushRequestSchema,
  unsubscribePushRequestSchema,
  updatePushPrefsRequestSchema,
} from '@gathernet/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../../db/index.ts'
import { ServiceError } from '../accounts/service.ts'
import { subscribePush, unsubscribePush, updatePushPrefs } from './service.ts'

export interface PushRoutesOptions {
  db: Db
  vapidPublicKey: string
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
}

function requireSession(request: FastifyRequest) {
  const session = request.session
  if (!session) throw new ServiceError(401, 'unauthorized')
  return session
}

export function registerPushRoutes(
  app: FastifyInstance,
  { db, vapidPublicKey, authenticate }: PushRoutesOptions,
): void {
  const auth = { preHandler: authenticate }

  // The VAPID public key the client passes to pushManager.subscribe(). Public by design.
  app.get('/api/v1/push/vapid-key', auth, async () => ({ publicKey: vapidPublicKey }))

  app.post('/api/v1/push/subscriptions', auth, async (request) => {
    const session = requireSession(request)
    const body = subscribePushRequestSchema.parse(request.body)
    await subscribePush(db, session.accountId, session.deviceId, body)
    return { ok: true }
  })

  app.patch('/api/v1/push/subscriptions', auth, async (request) => {
    const session = requireSession(request)
    const body = updatePushPrefsRequestSchema.parse(request.body)
    await updatePushPrefs(db, session.deviceId, body)
    return { ok: true }
  })

  app.delete('/api/v1/push/subscriptions', auth, async (request) => {
    const session = requireSession(request)
    const body = unsubscribePushRequestSchema.parse(request.body)
    await unsubscribePush(db, session.deviceId, body.endpoint)
    return { ok: true }
  })
}
