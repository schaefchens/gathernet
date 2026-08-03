import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { blocks } from '../src/db/schema.ts'
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

function auth(user: TestUser) {
  return { authorization: `Bearer ${user.token}` }
}

async function makeInvite(user: TestUser, options: object = {}): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/friends/invites',
    headers: auth(user),
    payload: options,
  })
  expect(res.statusCode).toBe(201)
  return res.json().code
}

async function accept(user: TestUser, code: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/friends/invites/accept',
    headers: auth(user),
    payload: { code },
  })
}

describe('friend invites', () => {
  it('full flow: invite → accept → both see the friendship', async () => {
    const alice = await createUser('Alice')
    const bob = await createUser('Bob')

    const code = await makeInvite(alice)
    expect(code).toHaveLength(10)

    const res = await accept(bob, code)
    expect(res.statusCode).toBe(200)
    expect(res.json().friend.displayName).toBe('Alice')

    const aliceFriends = await app.inject({
      method: 'GET',
      url: '/api/v1/friends',
      headers: auth(alice),
    })
    expect(aliceFriends.json().friends).toMatchObject([
      { accountId: bob.accountId, displayName: 'Bob' },
    ])

    const bobFriends = await app.inject({
      method: 'GET',
      url: '/api/v1/friends',
      headers: auth(bob),
    })
    expect(bobFriends.json().friends).toMatchObject([
      { accountId: alice.accountId, displayName: 'Alice' },
    ])
  })

  it('single-use invites are consumed', async () => {
    const alice = await createUser('Alice2')
    const bob = await createUser('Bob2')
    const carol = await createUser('Carol2')

    const code = await makeInvite(alice)
    expect((await accept(bob, code)).statusCode).toBe(200)
    const second = await accept(carol, code)
    expect(second.statusCode).toBe(404)
    expect(second.json().error).toBe('invite_invalid')
  })

  it('multi-use invites allow several friends', async () => {
    const alice = await createUser('Alice3')
    const bob = await createUser('Bob3')
    const carol = await createUser('Carol3')

    const code = await makeInvite(alice, { maxUses: 2 })
    expect((await accept(bob, code)).statusCode).toBe(200)
    expect((await accept(carol, code)).statusCode).toBe(200)

    const friends = await app.inject({
      method: 'GET',
      url: '/api/v1/friends',
      headers: auth(alice),
    })
    expect(friends.json().friends).toHaveLength(2)
  })

  it('rejects self-accept', async () => {
    const alice = await createUser('Alice4')
    const code = await makeInvite(alice)
    const res = await accept(alice, code)
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('self_invite')
  })

  it('rejects accepting the same friendship twice', async () => {
    const alice = await createUser('Alice5')
    const bob = await createUser('Bob5')
    const code = await makeInvite(alice, { maxUses: 5 })
    expect((await accept(bob, code)).statusCode).toBe(200)
    expect((await accept(bob, code)).statusCode).toBe(409)
  })

  it('normalizes ambiguous invite code characters', async () => {
    const alice = await createUser('Alice6')
    const bob = await createUser('Bob6')
    const code = await makeInvite(alice)
    // lowercase + o-for-0 substitution still resolves
    const mangled = code.toLowerCase().replaceAll('0', 'o')
    expect((await accept(bob, mangled)).statusCode).toBe(200)
  })

  it('revoked invites stop working', async () => {
    const alice = await createUser('Alice7')
    const bob = await createUser('Bob7')
    await makeInvite(alice)
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/friends/invites',
      headers: auth(alice),
    })
    const invite = list.json().invites[0]
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/friends/invites/${invite.id}`,
      headers: auth(alice),
    })
    expect(del.statusCode).toBe(200)
    expect((await accept(bob, invite.code)).statusCode).toBe(404)
  })
})

describe('remove and block', () => {
  it('removing a friend works and is mutual', async () => {
    const alice = await createUser('Alice8')
    const bob = await createUser('Bob8')
    await accept(bob, await makeInvite(alice))

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/friends/${bob.accountId}`,
      headers: auth(alice),
    })
    expect(res.statusCode).toBe(200)

    const bobFriends = await app.inject({
      method: 'GET',
      url: '/api/v1/friends',
      headers: auth(bob),
    })
    expect(bobFriends.json().friends).toHaveLength(0)
  })

  it('time-limited block severs friendship + prevents re-adding, listed + liftable', async () => {
    const alice = await createUser('Alice9')
    const bob = await createUser('Bob9')
    await accept(bob, await makeInvite(alice))

    const block = await app.inject({
      method: 'POST',
      url: `/api/v1/friends/${bob.accountId}/block`,
      headers: auth(alice),
      payload: { durationHours: 24 * 7 },
    })
    expect(block.statusCode).toBe(200)

    const aliceFriends = await app.inject({
      method: 'GET',
      url: '/api/v1/friends',
      headers: auth(alice),
    })
    expect(aliceFriends.json().friends).toHaveLength(0)

    // The active block is listed ("taking space from") with an expiry.
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/friends/blocks',
      headers: auth(alice),
    })
    expect(list.json().blocks).toHaveLength(1)
    expect(list.json().blocks[0]).toMatchObject({ accountId: bob.accountId })
    expect(list.json().blocks[0].expiresAt).toBeGreaterThan(Date.now())

    // Bob accepting a new alice invite fails exactly like an unknown code.
    const code2 = await makeInvite(alice)
    const res = await accept(bob, code2)
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('invite_invalid')

    // Bob inviting alice also fails (block is directionless for pairing).
    const bobCode = await makeInvite(bob)
    expect((await accept(alice, bobCode)).statusCode).toBe(404)

    // A block requires a valid duration.
    const bad = await app.inject({
      method: 'POST',
      url: `/api/v1/friends/${bob.accountId}/block`,
      headers: auth(alice),
      payload: {},
    })
    expect(bad.statusCode).toBe(400)

    // Lifting early (unblock) restores the ability to pair.
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/friends/${bob.accountId}/block`,
      headers: auth(alice),
    })
    expect((await accept(alice, bobCode)).statusCode).toBe(200)
  })

  it('an EXPIRED block no longer restricts (self-lifting; not listed)', async () => {
    const alice = await createUser('Alice10')
    const bob = await createUser('Bob10')

    // Insert a block that already expired (a season of space that has passed).
    await testDb.db.insert(blocks).values({
      blockerAccountId: alice.accountId,
      blockedAccountId: bob.accountId,
      expiresAt: new Date(Date.now() - 60_000),
    })

    // Not surfaced in the active-blocks list.
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/friends/blocks',
      headers: auth(alice),
    })
    expect(list.json().blocks).toHaveLength(0)

    // And it no longer suppresses invites — the door has reopened.
    expect((await accept(bob, await makeInvite(alice))).statusCode).toBe(200)
  })
})
