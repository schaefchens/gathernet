import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// web-push is mocked so tests never touch the network. sendNotification is a spy we
// can make throw a 410 to simulate a dead subscription.
const sendNotification = vi.fn(async (_sub?: unknown, _body?: unknown) => ({ statusCode: 201 }))
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: (sub: unknown, body: unknown) => sendNotification(sub, body),
  },
}))

import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { groups, pushSubscriptions } from '../src/db/schema.ts'
import {
  buildPushPayload,
  coalescedPush,
  notifyMessageActivity,
  sendToDevicePush,
} from '../src/modules/push/service.ts'
import { InMemoryBlobStore } from '../src/storage/blob-store.ts'
import { buildEnrollment, generateEd25519 } from './helpers/client-crypto.ts'
import { makeTestDb, type TestDb } from './helpers/db.ts'

let testDb: TestDb
let app: FastifyInstance

beforeAll(async () => {
  testDb = await makeTestDb()
  const built = await buildApp({
    config: loadConfig({ LOG_LEVEL: 'error', RATE_LIMIT_ENABLED: 'false' }),
    db: testDb.db,
    blobStore: new InMemoryBlobStore(),
  })
  app = built.app
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await testDb.teardown()
})

async function createUser(): Promise<{ accountId: string; deviceId: string; token: string }> {
  const identity = generateEd25519()
  const device = generateEd25519()
  const challenge = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/challenge',
    payload: { purpose: 'enroll' },
  })
  const { body } = buildEnrollment(identity, device, challenge.json().challenge, 'Browser')
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts',
    payload: { ...body, displayName: 'PushUser' },
  })
  expect(res.statusCode).toBe(201)
  return { accountId: res.json().accountId, deviceId: res.json().deviceId, token: res.json().token }
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` })
const sub = (endpoint: string) => ({
  subscription: { endpoint, p256dh: 'cDI1NmRo', auth: 'YXV0aA' },
})

describe('web push subscriptions + sending', () => {
  it('requires auth and the VAPID key is served', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/push/vapid-key' })).statusCode).toBe(
      401,
    )
    const u = await createUser()
    const key = await app.inject({
      method: 'GET',
      url: '/api/v1/push/vapid-key',
      headers: auth(u.token),
    })
    expect(key.statusCode).toBe(200)
    expect(typeof key.json().publicKey).toBe('string')
  })

  it('subscribe → prefs update → unsubscribe, bound to the caller device', async () => {
    const u = await createUser()
    const endpoint = 'https://push.example/ep-1'

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/push/subscriptions',
          headers: auth(u.token),
          payload: sub(endpoint),
        })
      ).statusCode,
    ).toBe(200)
    let rows = await testDb.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.deviceId).toBe(u.deviceId)
    expect(rows[0]?.dmEnabled).toBe(true)

    // Update prefs (disable channel pushes, mute a community).
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/push/subscriptions',
      headers: auth(u.token),
      payload: {
        categories: { dm: true, channel: false, moderation: true },
        mutedCommunityIds: ['cm_00000000000000aa'],
      },
    })
    expect(patch.statusCode).toBe(200)
    rows = await testDb.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint))
    expect(rows[0]?.channelEnabled).toBe(false)
    expect(rows[0]?.mutedCommunityIds).toEqual(['cm_00000000000000aa'])

    // Unsubscribe.
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/v1/push/subscriptions',
          headers: auth(u.token),
          payload: { endpoint },
        })
      ).statusCode,
    ).toBe(200)
    rows = await testDb.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint))
    expect(rows).toHaveLength(0)
  })

  it('sendToDevicePush respects category + mute gating and prunes dead subscriptions', async () => {
    const u = await createUser()
    const endpoint = 'https://push.example/ep-send'
    await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscriptions',
      headers: auth(u.token),
      payload: { ...sub(endpoint), categories: { dm: true, channel: false, moderation: true } },
    })

    // Enabled category → sent.
    sendNotification.mockClear()
    await sendToDevicePush(testDb.db, u.deviceId, buildPushPayload('dm'))
    expect(sendNotification).toHaveBeenCalledTimes(1)

    // Disabled category → not sent.
    sendNotification.mockClear()
    await sendToDevicePush(testDb.db, u.deviceId, buildPushPayload('channel'))
    expect(sendNotification).not.toHaveBeenCalled()

    // Muted community → not sent.
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/push/subscriptions',
      headers: auth(u.token),
      payload: { mutedCommunityIds: ['cm_00000000000000bb'] },
    })
    sendNotification.mockClear()
    await sendToDevicePush(
      testDb.db,
      u.deviceId,
      buildPushPayload('moderation', 'cm_00000000000000bb'),
    )
    expect(sendNotification).not.toHaveBeenCalled()

    // A 410 from the push service prunes the subscription.
    sendNotification.mockClear()
    sendNotification.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }))
    await sendToDevicePush(testDb.db, u.deviceId, buildPushPayload('dm'))
    const rows = await testDb.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint))
    expect(rows).toHaveLength(0)
  })

  it('payloads are padded to a constant size regardless of category', async () => {
    const a = JSON.stringify(buildPushPayload('dm'))
    const b = JSON.stringify(buildPushPayload('moderation', 'cm_somecommunityid'))
    expect(a.length).toBe(b.length)
  })

  it('coalesces: at most one push per device per window', async () => {
    const u = await createUser()
    await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscriptions',
      headers: auth(u.token),
      payload: sub('https://push.example/ep-coalesce'),
    })
    sendNotification.mockClear()
    const p = buildPushPayload('dm')
    const t0 = 1_700_000_000_000 // realistic epoch-ms base (first push always sends)
    await coalescedPush(testDb.db, u.deviceId, p, t0)
    await coalescedPush(testDb.db, u.deviceId, p, t0 + 500) // within 60s window → skipped
    expect(sendNotification).toHaveBeenCalledTimes(1)
    await coalescedPush(testDb.db, u.deviceId, p, t0 + 60_001) // window elapsed → sends
    expect(sendNotification).toHaveBeenCalledTimes(2)
  })

  it('notifyMessageActivity categorizes DM vs channel and skips rooms', async () => {
    const u = await createUser()
    await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscriptions',
      headers: auth(u.token),
      payload: sub('https://push.example/ep-notify'),
    })
    const mkGroup = async (kind: string) => {
      const groupId = randomBytes(16).toString('hex')
      await testDb.db.insert(groups).values({ groupId, kind, creatorAccountId: u.accountId })
      return groupId
    }

    // DM → a 'dm' push.
    sendNotification.mockClear()
    await notifyMessageActivity(testDb.db, await mkGroup('dm'), [u.deviceId])
    expect(sendNotification).toHaveBeenCalledTimes(1)
    expect(JSON.parse(sendNotification.mock.calls[0]?.[1] as string).category).toBe('dm')

    // A room group → no push (and reset the coalesce window via a fresh device would
    // be needed, so use a fresh user to avoid the throttle from the DM above).
    const u2 = await createUser()
    await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscriptions',
      headers: auth(u2.token),
      payload: sub('https://push.example/ep-room'),
    })
    const roomId = randomBytes(16).toString('hex')
    await testDb.db
      .insert(groups)
      .values({ groupId: roomId, kind: 'room', creatorAccountId: u2.accountId })
    sendNotification.mockClear()
    await notifyMessageActivity(testDb.db, roomId, [u2.deviceId])
    expect(sendNotification).not.toHaveBeenCalled()
  })
})
