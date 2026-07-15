import { eciesOpen, eciesSeal, generateEciesKeypair } from '@gathernet/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { buildEnrollment, generateEd25519 } from './helpers/client-crypto.ts'
import { makeTestDb, type TestDb } from './helpers/db.ts'

let testDb: TestDb
let app: FastifyInstance

beforeAll(async () => {
  testDb = await makeTestDb()
  const built = await buildApp({
    config: loadConfig({ LOG_LEVEL: 'error', RATE_LIMIT_ENABLED: 'false' }),
    db: testDb.db,
  })
  app = built.app
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await testDb.teardown()
})

interface TestUser {
  accountId: string
  token: string
}

async function createUser(displayName: string): Promise<TestUser> {
  const identity = generateEd25519()
  const device = generateEd25519()
  const challengeRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/challenge',
    payload: { purpose: 'enroll' },
  })
  const { body } = buildEnrollment(identity, device, challengeRes.json().challenge, 'Browser')
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts',
    payload: { ...body, displayName },
  })
  return { accountId: res.json().accountId, token: res.json().token }
}

const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` })
const DEMO_ORIGIN = 'http://localhost:5175'

async function registerApp(publisher: TestUser, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/publications',
    headers: auth(publisher),
    payload: {
      kind: 'app',
      name,
      appConfig: { origins: [DEMO_ORIGIN], allowedScopes: ['identity', 'storage', 'rooms'] },
    },
  })
  return res.json().pubId
}

async function createCode(appId: string, scopes: string[], ephemeralPk?: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/app/grant-codes',
    headers: { origin: DEMO_ORIGIN },
    payload: { appId, scopes, ...(ephemeralPk ? { ephemeralPk } : {}) },
  })
  expect(res.statusCode).toBe(201)
  return res.json() as { userCode: string; qrPayload: string; pollSecret: string }
}

async function poll(pollSecret: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/app/grant-codes/poll',
    payload: { pollSecret, waitSeconds: 0 },
  })
}

describe('device-code grant flow', () => {
  it('full happy path with sealed storage-key handoff', async () => {
    const dev = await createUser('Dev')
    const user = await createUser('TV User')
    const appId = await registerApp(dev, 'TV App')

    // App side: ephemeral keypair + code.
    const appKeys = await generateEciesKeypair()
    const code = await createCode(appId, ['identity', 'storage'], appKeys.publicKeyB64)
    expect(code.qrPayload).toBe(`gathernet:grant:${code.userCode}`)

    // Pending until approved.
    expect((await poll(code.pollSecret)).statusCode).toBe(202)

    // Hub side: preview shows the app card + the app's ephemeral key.
    const preview = await app.inject({
      method: 'GET',
      url: `/api/v1/apps/grant-codes/${code.userCode}`,
      headers: auth(user),
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.json().app.name).toBe('TV App')
    expect(preview.json().appEphemeralPk).toBe(appKeys.publicKeyB64)

    // Hub seals a fake per-app storage key to the app's ephemeral key.
    const storageKey = crypto.getRandomValues(new Uint8Array(32))
    const sealed = await eciesSeal(appKeys.publicKeyB64, storageKey)
    const approve = await app.inject({
      method: 'POST',
      url: `/api/v1/apps/grant-codes/${code.userCode}/approve`,
      headers: auth(user),
      payload: {
        scopes: ['identity', 'storage'],
        sealedStorageKey: sealed.sealedB64,
        hubEphemeralPk: sealed.senderPkB64,
      },
    })
    expect(approve.statusCode).toBe(200)

    // App polls → token + sealed key it can open.
    const granted = await poll(code.pollSecret)
    expect(granted.statusCode).toBe(200)
    const result = granted.json()
    expect(result.token).toMatch(/^gna\./)
    expect(result.displayName).toBe('TV User')
    const opened = await eciesOpen(
      appKeys.privateKey,
      result.hubEphemeralPk,
      result.sealedStorageKey,
    )
    expect(Buffer.from(opened)).toEqual(Buffer.from(storageKey))

    // Single use: second poll → 410.
    expect((await poll(code.pollSecret)).statusCode).toBe(410)

    // Token works.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/app/me',
      headers: { authorization: `Bearer ${result.token}` },
    })
    expect(me.statusCode).toBe(200)
  })

  it('normalizes user codes (lowercase, dashes, confusables)', async () => {
    const dev = await createUser('Dev2')
    const user = await createUser('User2')
    const appId = await registerApp(dev, 'App2')
    const code = await createCode(appId, ['identity'])
    const mangled = `${code.userCode.slice(0, 4).toLowerCase()}-${code.userCode.slice(4).replaceAll('0', 'o')}`
    const preview = await app.inject({
      method: 'GET',
      url: `/api/v1/apps/grant-codes/${encodeURIComponent(mangled)}`,
      headers: auth(user),
    })
    expect(preview.statusCode).toBe(200)
  })

  it('deny path returns 410 denied', async () => {
    const dev = await createUser('Dev3')
    const user = await createUser('User3')
    const appId = await registerApp(dev, 'App3')
    const code = await createCode(appId, ['identity'])
    await app.inject({
      method: 'POST',
      url: `/api/v1/apps/grant-codes/${code.userCode}/deny`,
      headers: auth(user),
    })
    const res = await poll(code.pollSecret)
    expect(res.statusCode).toBe(410)
    expect(res.json().error).toBe('denied')
  })

  it('rejects unregistered origins and scope escalation on approve', async () => {
    const dev = await createUser('Dev4')
    const user = await createUser('User4')
    const appId = await registerApp(dev, 'App4')

    const badOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/app/grant-codes',
      headers: { origin: 'https://evil.example' },
      payload: { appId, scopes: ['identity'] },
    })
    expect(badOrigin.statusCode).toBe(403)

    const code = await createCode(appId, ['identity'])
    const escalate = await app.inject({
      method: 'POST',
      url: `/api/v1/apps/grant-codes/${code.userCode}/approve`,
      headers: auth(user),
      payload: { scopes: ['identity', 'storage'] }, // storage wasn't requested
    })
    expect(escalate.statusCode).toBe(403)
  })
})

describe('encrypted app storage', () => {
  async function appSession(scopes: string[] = ['identity', 'storage']) {
    const dev = await createUser(`Dev-${Math.random().toString(36).slice(2, 7)}`)
    const user = await createUser(`User-${Math.random().toString(36).slice(2, 7)}`)
    const appId = await registerApp(dev, `App-${Math.random().toString(36).slice(2, 7)}`)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/authorize`,
      headers: auth(user),
      payload: { scopes, origin: DEMO_ORIGIN },
    })
    return { token: res.json().token as string, appId, user }
  }

  const put = (token: string, key: string, body: Buffer, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'PUT',
      url: `/api/v1/app/storage/${key}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        ...headers,
      },
      payload: body,
    })

  it('put/get/list/delete round-trip with ETags', async () => {
    const { token } = await appSession()
    const blob = Buffer.from('sealed-bytes-here')

    const created = await put(token, 'save', blob)
    expect(created.statusCode).toBe(200)
    expect(created.headers.etag).toBe('"1"')

    const got = await app.inject({
      method: 'GET',
      url: '/api/v1/app/storage/save',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(got.statusCode).toBe(200)
    expect(got.rawPayload).toEqual(blob)
    expect(got.headers.etag).toBe('"1"')

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/app/storage',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(list.json().entries).toMatchObject([{ key: 'save', version: 1, size: blob.length }])

    await app.inject({
      method: 'DELETE',
      url: '/api/v1/app/storage/save',
      headers: { authorization: `Bearer ${token}` },
    })
    const gone = await app.inject({
      method: 'GET',
      url: '/api/v1/app/storage/save',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(gone.statusCode).toBe(404)
  })

  it('version conflicts: If-Match mismatch → 412; If-None-Match:* create-only', async () => {
    const { token } = await appSession()
    await put(token, 'k', Buffer.from('v1'))
    const second = await put(token, 'k', Buffer.from('v2'), { 'if-match': '"1"' })
    expect(second.statusCode).toBe(200)
    expect(second.headers.etag).toBe('"2"')

    const stale = await put(token, 'k', Buffer.from('v3'), { 'if-match': '"1"' })
    expect(stale.statusCode).toBe(412)

    const createOnly = await put(token, 'k', Buffer.from('v3'), { 'if-none-match': '*' })
    expect(createOnly.statusCode).toBe(412)
  })

  it('enforces size and key quotas', async () => {
    const { token } = await appSession()
    const tooBig = await put(token, 'big', Buffer.alloc(64 * 1024 + 1, 1))
    expect(tooBig.statusCode).toBe(413)

    for (let i = 0; i < 100; i++) {
      const res = await put(token, `k${i}`, Buffer.from('x'))
      expect(res.statusCode).toBe(200)
    }
    const over = await put(token, 'k100', Buffer.from('x'))
    expect(over.statusCode).toBe(507)
    expect(over.json().error).toBe('quota_exceeded')

    // Overwrites still work at quota.
    const overwrite = await put(token, 'k0', Buffer.from('y'))
    expect(overwrite.statusCode).toBe(200)
  })

  it('requires the storage scope', async () => {
    const { token } = await appSession(['identity'])
    const res = await put(token, 'k', Buffer.from('x'))
    expect(res.statusCode).toBe(403)
  })
})
