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
  expect(res.statusCode).toBe(201)
  return { accountId: res.json().accountId, token: res.json().token }
}

const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` })

const DEMO_ORIGIN = 'http://localhost:5175'

async function registerApp(publisher: TestUser, name = 'Demo App'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/publications',
    headers: auth(publisher),
    payload: {
      kind: 'app',
      name,
      description: 'Test app',
      appConfig: { origins: [DEMO_ORIGIN], allowedScopes: ['identity', 'storage', 'rooms'] },
    },
  })
  expect(res.statusCode).toBe(201)
  return res.json().pubId
}

async function authorize(user: TestUser, appId: string, scopes: string[], origin = DEMO_ORIGIN) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/apps/${appId}/authorize`,
    headers: auth(user),
    payload: { scopes, origin },
  })
}

describe('publications', () => {
  it('any account can self-register an app; it starts unlisted and is usable', async () => {
    const dev = await createUser('Indie Dev')
    const pubId = await registerApp(dev, 'My Quiz')
    expect(pubId).toMatch(/^pub_[0-9a-f]{16}$/)

    const own = await app.inject({
      method: 'GET',
      url: `/api/v1/publications/${pubId}`,
      headers: auth(dev),
    })
    expect(own.json()).toMatchObject({ listing: 'unlisted', kind: 'app' })

    // Public consent card works without auth (unlisted ≠ unusable).
    const card = await app.inject({ method: 'GET', url: `/api/v1/apps/card/${pubId}` })
    expect(card.statusCode).toBe(200)
    expect(card.json()).toMatchObject({
      name: 'My Quiz',
      allowedScopes: ['identity', 'storage', 'rooms'],
    })
  })

  it('book publications need no app config and get no card', async () => {
    const author = await createUser('Author')
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/publications',
      headers: auth(author),
      payload: { kind: 'book', name: 'Devotional' },
    })
    expect(res.statusCode).toBe(201)
    const card = await app.inject({
      method: 'GET',
      url: `/api/v1/apps/card/${res.json().pubId}`,
    })
    expect(card.statusCode).toBe(404)
  })

  it('app registration without appConfig is rejected', async () => {
    const dev = await createUser('Dev2')
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/publications',
      headers: auth(dev),
      payload: { kind: 'game', name: 'No Config' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('publishers only see and edit their own publications', async () => {
    const a = await createUser('DevA')
    const b = await createUser('DevB')
    const pubId = await registerApp(a)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/publications/${pubId}`,
      headers: auth(b),
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('authorize + app sessions', () => {
  it('mints a working app session with pseudonymous identity', async () => {
    const dev = await createUser('Dev3')
    const user = await createUser('Player One')
    const appId = await registerApp(dev)

    const res = await authorize(user, appId, ['identity', 'storage'])
    expect(res.statusCode).toBe(200)
    const session = res.json()
    expect(session.token).toMatch(/^gna\./)
    expect(session.appUserId).toMatch(/^au_[0-9a-f]{32}$/)
    expect(session.displayName).toBe('Player One')
    expect(session.origin).toBe(DEMO_ORIGIN)

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/app/me',
      headers: { authorization: `Bearer ${session.token}` },
    })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({
      appUserId: session.appUserId,
      displayName: 'Player One',
      scopes: ['identity', 'storage'],
    })
  })

  it('appUserId is stable per app and different across apps', async () => {
    const dev = await createUser('Dev4')
    const user = await createUser('Player Two')
    const app1 = await registerApp(dev, 'App One')
    const app2 = await registerApp(dev, 'App Two')

    const s1a = (await authorize(user, app1, ['identity'])).json()
    const s1b = (await authorize(user, app1, ['identity'])).json()
    const s2 = (await authorize(user, app2, ['identity'])).json()
    expect(s1a.appUserId).toBe(s1b.appUserId)
    expect(s1a.appUserId).not.toBe(s2.appUserId)
  })

  it('rejects unregistered origins and disallowed scopes', async () => {
    const dev = await createUser('Dev5')
    const user = await createUser('Player Three')
    const appId = await registerApp(dev)

    const badOrigin = await authorize(user, appId, ['identity'], 'https://evil.example')
    expect(badOrigin.statusCode).toBe(403)
    expect(badOrigin.json().error).toBe('origin_not_registered')

    // friends:invite not in allowedScopes of the registered app
    const badScope = await authorize(user, appId, ['friends:invite'])
    expect(badScope.statusCode).toBe(403)
    expect(badScope.json().error).toBe('scope_not_allowed')
  })

  it('scope enforcement on app routes', async () => {
    const dev = await createUser('Dev6')
    const user = await createUser('Player Four')
    const appId = await registerApp(dev)
    const session = (await authorize(user, appId, ['storage'])).json()

    // /app/me requires 'identity'
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/app/me',
      headers: { authorization: `Bearer ${session.token}` },
    })
    expect(me.statusCode).toBe(403)
    expect(me.json().error).toBe('insufficient_scope')
  })

  it('revoking the grant instantly kills app sessions', async () => {
    const dev = await createUser('Dev7')
    const user = await createUser('Player Five')
    const appId = await registerApp(dev)
    const session = (await authorize(user, appId, ['identity'])).json()

    const grants = await app.inject({
      method: 'GET',
      url: '/api/v1/apps/grants',
      headers: auth(user),
    })
    expect(grants.json().grants).toHaveLength(1)

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/v1/apps/grants/${appId}`,
      headers: auth(user),
    })
    expect(revoke.statusCode).toBe(200)

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/app/me',
      headers: { authorization: `Bearer ${session.token}` },
    })
    expect(me.statusCode).toBe(401)

    // Re-grant works and yields the SAME appUserId (saves survive).
    const again = (await authorize(user, appId, ['identity'])).json()
    expect(again.appUserId).toBe(session.appUserId)
  })

  it('token types are strictly isolated', async () => {
    const dev = await createUser('Dev8')
    const user = await createUser('Player Six')
    const appId = await registerApp(dev)
    const appToken = (await authorize(user, appId, ['identity'])).json().token

    // App token on a device-session route → 401.
    const friends = await app.inject({
      method: 'GET',
      url: '/api/v1/friends',
      headers: { authorization: `Bearer ${appToken}` },
    })
    expect(friends.statusCode).toBe(401)

    // Device token on an app route → 401.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/app/me',
      headers: auth(user),
    })
    expect(me.statusCode).toBe(401)

    // logout deletes only the session, not the grant
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/app/logout',
      headers: { authorization: `Bearer ${appToken}` },
    })
    expect(logout.statusCode).toBe(200)
    const grants = await app.inject({
      method: 'GET',
      url: '/api/v1/apps/grants',
      headers: auth(user),
    })
    expect(grants.json().grants).toHaveLength(1)
  })
})

describe('CORS', () => {
  it('allows registered app origins and blocks others', async () => {
    const dev = await createUser('Dev9')
    await registerApp(dev)

    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/app/me',
      headers: {
        origin: DEMO_ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    })
    expect(allowed.headers['access-control-allow-origin']).toBe(DEMO_ORIGIN)

    const blocked = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/app/me',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'GET',
      },
    })
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined()
  })
})
