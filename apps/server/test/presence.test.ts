import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { buildEnrollment, generateEd25519 } from './helpers/client-crypto.ts'
import { makeTestDb, type TestDb } from './helpers/db.ts'
import { TestWsClient } from './helpers/ws-client.ts'

let testDb: TestDb
let app: FastifyInstance
let port: number

beforeAll(async () => {
  testDb = await makeTestDb()
  const built = await buildApp({
    config: loadConfig({ LOG_LEVEL: 'error', RATE_LIMIT_ENABLED: 'false' }),
    db: testDb.db,
  })
  app = built.app
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (typeof address === 'string' || address === null) throw new Error('no port')
  port = address.port
})

afterAll(async () => {
  await app.close()
  await testDb.teardown()
})

interface TestUser {
  accountId: string
  token: string
  identity: ReturnType<typeof generateEd25519>
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
  return { accountId: res.json().accountId, token: res.json().token, identity }
}

async function enrollDevice(user: TestUser): Promise<string> {
  const device = generateEd25519()
  const challengeRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/challenge',
    payload: { purpose: 'enroll' },
  })
  const { body } = buildEnrollment(user.identity, device, challengeRes.json().challenge, 'Second')
  const res = await app.inject({ method: 'POST', url: '/api/v1/devices', payload: body })
  expect(res.statusCode).toBe(201)
  return res.json().token
}

async function befriend(a: TestUser, b: TestUser): Promise<void> {
  const invite = await app.inject({
    method: 'POST',
    url: '/api/v1/friends/invites',
    headers: { authorization: `Bearer ${a.token}` },
    payload: {},
  })
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/friends/invites/accept',
    headers: { authorization: `Bearer ${b.token}` },
    payload: { code: invite.json().code },
  })
  expect(res.statusCode).toBe(200)
}

const presenceOf =
  (accountId: string, status?: string) =>
  (m: { type: string; payload?: unknown }): boolean =>
    m.type === 'presence.update' &&
    (m as { payload: { accountId: string; status: string } }).payload.accountId === accountId &&
    (status === undefined || (m as { payload: { status: string } }).payload.status === status)

describe('presence', () => {
  it('snapshot on connect, updates on friend connect/disconnect', async () => {
    const alice = await createUser('Alice')
    const bob = await createUser('Bob')
    await befriend(alice, bob)

    const bobWs = await TestWsClient.connect(port, bob.token)
    const snapshot = await bobWs.waitFor((m) => m.type === 'presence.snapshot')
    expect(snapshot).toMatchObject({
      payload: { friends: [{ accountId: alice.accountId, status: 'offline' }] },
    })

    const aliceWs = await TestWsClient.connect(port, alice.token)
    await bobWs.waitFor(presenceOf(alice.accountId, 'online'))

    const aliceSnapshot = await aliceWs.waitFor((m) => m.type === 'presence.snapshot')
    expect(aliceSnapshot).toMatchObject({
      payload: { friends: [{ accountId: bob.accountId, status: 'online' }] },
    })

    await aliceWs.close()
    await bobWs.waitFor(presenceOf(alice.accountId, 'offline'))
    await bobWs.close()
  })

  it('presence.set away and invisible are filtered server-side', async () => {
    const alice = await createUser('Alice2')
    const bob = await createUser('Bob2')
    await befriend(alice, bob)

    const bobWs = await TestWsClient.connect(port, bob.token)
    const aliceWs = await TestWsClient.connect(port, alice.token)
    await bobWs.waitFor(presenceOf(alice.accountId, 'online'))

    aliceWs.send('presence.set', { status: 'away' })
    await bobWs.waitFor(presenceOf(alice.accountId, 'away'))

    aliceWs.send('presence.set', { status: 'invisible' })
    await bobWs.waitFor(presenceOf(alice.accountId, 'offline'))

    // While invisible, disconnect produces no further updates.
    aliceWs.send('presence.set', { status: 'online' })
    await bobWs.waitFor(presenceOf(alice.accountId, 'online'))

    await aliceWs.close()
    await bobWs.waitFor(presenceOf(alice.accountId, 'offline'))
    await bobWs.close()
  })

  it('non-friends receive no presence', async () => {
    const alice = await createUser('Alice3')
    const carol = await createUser('Carol3')
    const carolWs = await TestWsClient.connect(port, carol.token)
    const aliceWs = await TestWsClient.connect(port, alice.token)

    await carolWs.expectSilence(presenceOf(alice.accountId))
    await aliceWs.close()
    await carolWs.close()
  })

  it('multi-device: offline only after the last socket closes', async () => {
    const alice = await createUser('Alice4')
    const bob = await createUser('Bob4')
    await befriend(alice, bob)
    const secondToken = await enrollDevice(alice)

    const bobWs = await TestWsClient.connect(port, bob.token)
    const aliceWs1 = await TestWsClient.connect(port, alice.token)
    await bobWs.waitFor(presenceOf(alice.accountId, 'online'))

    const aliceWs2 = await TestWsClient.connect(port, secondToken)
    await aliceWs1.close()
    await bobWs.expectSilence(presenceOf(alice.accountId, 'offline'))

    await aliceWs2.close()
    await bobWs.waitFor(presenceOf(alice.accountId, 'offline'))
    await bobWs.close()
  })

  it('invisible default pref never announces', async () => {
    const alice = await createUser('Alice5')
    const bob = await createUser('Bob5')
    await befriend(alice, bob)
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { presencePref: 'invisible' },
    })

    const bobWs = await TestWsClient.connect(port, bob.token)
    const aliceWs = await TestWsClient.connect(port, alice.token)

    await bobWs.expectSilence(presenceOf(alice.accountId))
    const snapshot = await bobWs.waitFor((m) => m.type === 'presence.snapshot')
    expect(snapshot).toMatchObject({
      payload: { friends: [{ accountId: alice.accountId, status: 'offline' }] },
    })

    await aliceWs.close()
    await bobWs.close()
  })
})
