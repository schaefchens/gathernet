import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { pruneMailbox } from '../src/modules/delivery/service.ts'
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
  deviceId: string
  token: string
  identity: ReturnType<typeof generateEd25519>
}

const fakeBytes = (n = 64) => randomBytes(n).toString('base64')
const fakeRef = () => randomBytes(16).toString('hex')

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
  const json = res.json()
  return { accountId: json.accountId, deviceId: json.deviceId, token: json.token, identity }
}

async function enrollDevice(user: TestUser): Promise<TestUser> {
  const device = generateEd25519()
  const challengeRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/challenge',
    payload: { purpose: 'enroll' },
  })
  const { body } = buildEnrollment(user.identity, device, challengeRes.json().challenge, 'Second')
  const res = await app.inject({ method: 'POST', url: '/api/v1/devices', payload: body })
  expect(res.statusCode).toBe(201)
  const json = res.json()
  return { ...user, deviceId: json.deviceId, token: json.token }
}

function auth(user: TestUser) {
  return { authorization: `Bearer ${user.token}` }
}

async function befriend(a: TestUser, b: TestUser): Promise<string> {
  const invite = await app.inject({
    method: 'POST',
    url: '/api/v1/friends/invites',
    headers: auth(a),
    payload: {},
  })
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/friends/invites/accept',
    headers: auth(b),
    payload: { code: invite.json().code },
  })
  expect(res.statusCode).toBe(200)
  const groups = await app.inject({ method: 'GET', url: '/api/v1/mls/groups', headers: auth(a) })
  const group = groups
    .json()
    .groups.find((g: { friendAccountId: string }) => g.friendAccountId === b.accountId)
  expect(group).toBeDefined()
  return group.groupId
}

async function uploadKps(user: TestUser, count: number) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/mls/key-packages',
    headers: auth(user),
    payload: {
      keyPackages: [
        ...Array.from({ length: count }, () => ({ ref: fakeRef(), data: fakeBytes() })),
        { ref: fakeRef(), data: fakeBytes(), isLastResort: true },
      ],
    },
  })
  expect(res.statusCode).toBe(200)
}

async function postCommit(user: TestUser, groupId: string, body: object) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/mls/groups/${groupId}/commits`,
    headers: auth(user),
    payload: { commit: fakeBytes(), groupInfo: fakeBytes(), ...body },
  })
}

describe('group lifecycle', () => {
  it('friendship accept creates a dm group; accepter is creator', async () => {
    const alice = await createUser('Alice')
    const bob = await createUser('Bob')
    const aliceWs = await TestWsClient.connect(port, alice.token)
    const bobWs = await TestWsClient.connect(port, bob.token)

    const groupId = await befriend(alice, bob)

    const aliceEvt = await aliceWs.waitFor((m) => m.type === 'group.created')
    expect(aliceEvt).toMatchObject({
      payload: { groupId, friendAccountId: bob.accountId, creator: false },
    })
    const bobEvt = await bobWs.waitFor((m) => m.type === 'group.created')
    expect(bobEvt).toMatchObject({ payload: { creator: true } })

    const bobGroups = await app.inject({
      method: 'GET',
      url: '/api/v1/mls/groups',
      headers: auth(bob),
    })
    expect(bobGroups.json().groups[0]).toMatchObject({
      groupId,
      creator: true,
      currentEpoch: 0,
      isMember: false,
      groupInfo: null,
    })

    await aliceWs.close()
    await bobWs.close()
  })

  it('key package claim: pool consumption then last-resort fallback', async () => {
    const alice = await createUser('Alice2')
    const bob = await createUser('Bob2')
    await befriend(alice, bob)
    await uploadKps(bob, 2)

    const claim = async () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/mls/key-packages/claim',
        headers: auth(alice),
        payload: { accountIds: [bob.accountId] },
      })

    const first = (await claim()).json().keyPackages
    const second = (await claim()).json().keyPackages
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(first[0].ref).not.toBe(second[0].ref)

    // Pool exhausted → the last-resort KP is served (repeatedly).
    const third = (await claim()).json().keyPackages
    const fourth = (await claim()).json().keyPackages
    expect(third[0].ref).toBe(fourth[0].ref)

    // A stranger cannot claim.
    const carol = await createUser('Carol2')
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/v1/mls/key-packages/claim',
      headers: auth(carol),
      payload: { accountIds: [bob.accountId] },
    })
    expect(forbidden.statusCode).toBe(403)
  })

  it('commit sequencing: first commit, welcomes, stale epoch 409', async () => {
    const alice = await createUser('Alice3')
    const bob = await createUser('Bob3')
    const groupId = await befriend(alice, bob)

    const aliceWs = await TestWsClient.connect(port, alice.token)

    // Bob (creator) commits epoch 0: adds alice's device, sends her a welcome.
    const commit1 = await postCommit(bob, groupId, {
      epoch: 0,
      welcomes: [{ deviceId: alice.deviceId, payload: fakeBytes() }],
      memberChanges: { adds: [alice.deviceId], removes: [] },
    })
    expect(commit1.statusCode).toBe(200)
    expect(commit1.json()).toMatchObject({ seq: 1, newEpoch: 1 })

    // Alice's live socket receives the welcome.
    const welcome = await aliceWs.waitFor((m) => m.type === 'welcome')
    expect(welcome).toMatchObject({ payload: { groupId } })

    // Replaying epoch 0 → 409 with the real current epoch.
    const stale = await postCommit(bob, groupId, { epoch: 0 })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({ error: 'epoch_conflict', currentEpoch: 1 })

    // Alice, now a member, commits at epoch 1 and the group advances.
    const commit2 = await postCommit(alice, groupId, { epoch: 1 })
    expect(commit2.statusCode).toBe(200)
    expect(commit2.json()).toMatchObject({ newEpoch: 2 })

    // GroupInfo is now present for external joiners.
    const groups = await app.inject({
      method: 'GET',
      url: '/api/v1/mls/groups',
      headers: auth(alice),
    })
    expect(groups.json().groups[0].groupInfo).not.toBeNull()
    expect(groups.json().groups[0].isMember).toBe(true)

    await aliceWs.close()
  })

  it('external join: a freshly enrolled device commits itself in', async () => {
    const alice = await createUser('Alice4')
    const bob = await createUser('Bob4')
    const groupId = await befriend(alice, bob)
    await postCommit(bob, groupId, {
      epoch: 0,
      memberChanges: { adds: [alice.deviceId], removes: [] },
    })

    const aliceB = await enrollDevice(alice)
    const res = await postCommit(aliceB, groupId, {
      epoch: 1,
      memberChanges: { adds: [aliceB.deviceId], removes: [] },
    })
    expect(res.statusCode).toBe(200)

    const groups = await app.inject({
      method: 'GET',
      url: '/api/v1/mls/groups',
      headers: auth(aliceB),
    })
    expect(groups.json().groups[0].isMember).toBe(true)
  })

  it('a non-member stranger cannot commit or send', async () => {
    const alice = await createUser('Alice5')
    const bob = await createUser('Bob5')
    const carol = await createUser('Carol5')
    const groupId = await befriend(alice, bob)

    const res = await postCommit(carol, groupId, { epoch: 0 })
    expect(res.statusCode).toBe(404)
  })
})

describe('messages', () => {
  async function setupChat() {
    const alice = await createUser(`Alice-${fakeRef().slice(0, 6)}`)
    const bob = await createUser(`Bob-${fakeRef().slice(0, 6)}`)
    const groupId = await befriend(alice, bob)
    await postCommit(bob, groupId, {
      epoch: 0,
      memberChanges: { adds: [alice.deviceId], removes: [] },
    })
    return { alice, bob, groupId }
  }

  it('chat.send fans out live and lands in the mailbox', async () => {
    const { alice, bob, groupId } = await setupChat()
    const aliceWs = await TestWsClient.connect(port, alice.token)
    const bobWs = await TestWsClient.connect(port, bob.token)

    const ciphertext = fakeBytes(128)
    const msgId = bobWs.send('chat.send', { groupId, epoch: 1, ciphertext })
    const ack = await bobWs.waitFor((m) => m.type === 'ack' && m.replyTo === msgId)
    expect(ack).toMatchObject({ payload: { result: { seq: 2 } } })

    const received = await aliceWs.waitFor((m) => m.type === 'chat.message')
    expect(received).toMatchObject({
      payload: { groupId, seq: 2, kind: 'application', epoch: 1, payload: ciphertext },
    })

    // Mailbox catch-up sees commit (seq 1) + message (seq 2).
    const mailbox = await app.inject({
      method: 'GET',
      url: `/api/v1/mls/groups/${groupId}/messages?after=0`,
      headers: auth(alice),
    })
    expect(mailbox.json().messages.map((m: { seq: number }) => m.seq)).toEqual([1, 2])

    // After=1 skips the commit.
    const partial = await app.inject({
      method: 'GET',
      url: `/api/v1/mls/groups/${groupId}/messages?after=1`,
      headers: auth(alice),
    })
    expect(partial.json().messages).toHaveLength(1)

    await aliceWs.close()
    await bobWs.close()
  })

  it('wrong epoch is rejected; one epoch behind is tolerated', async () => {
    const { alice, bob, groupId } = await setupChat()
    const bobWs = await TestWsClient.connect(port, bob.token)

    // current epoch is 1; epoch 0 (one behind) tolerated
    const okId = bobWs.send('chat.send', { groupId, epoch: 0, ciphertext: fakeBytes() })
    await bobWs.waitFor((m) => m.type === 'ack' && m.replyTo === okId)

    // epoch 5 (future) rejected
    const badId = bobWs.send('chat.send', { groupId, epoch: 5, ciphertext: fakeBytes() })
    const err = await bobWs.waitFor((m) => m.type === 'error' && m.replyTo === badId)
    expect(err).toMatchObject({ payload: { code: 'epoch_conflict' } })

    await bobWs.close()
    void alice
  })

  it('acks drive mailbox pruning', async () => {
    const { alice, bob, groupId } = await setupChat()
    const aliceWs = await TestWsClient.connect(port, alice.token)
    const bobWs = await TestWsClient.connect(port, bob.token)

    const sendId = bobWs.send('chat.send', { groupId, epoch: 1, ciphertext: fakeBytes() })
    await bobWs.waitFor((m) => m.type === 'ack' && m.replyTo === sendId)

    // Nothing prunable yet — alice hasn't acked.
    await pruneMailbox(testDb.db)
    let mailbox = await app.inject({
      method: 'GET',
      url: `/api/v1/mls/groups/${groupId}/messages?after=0`,
      headers: auth(alice),
    })
    expect(mailbox.json().messages).toHaveLength(2)

    // Alice acks everything; bob acks too (commit sender was bob, message sender bob).
    const ackId = aliceWs.send('chat.ack', { groupId, seq: 2 })
    await aliceWs.waitFor((m) => m.type === 'ack' && m.replyTo === ackId)
    const bobAckId = bobWs.send('chat.ack', { groupId, seq: 2 })
    await bobWs.waitFor((m) => m.type === 'ack' && m.replyTo === bobAckId)

    const pruned = await pruneMailbox(testDb.db)
    expect(pruned).toBeGreaterThanOrEqual(2)
    mailbox = await app.inject({
      method: 'GET',
      url: `/api/v1/mls/groups/${groupId}/messages?after=0`,
      headers: auth(alice),
    })
    expect(mailbox.json().messages).toHaveLength(0)

    await aliceWs.close()
    await bobWs.close()
  })

  it('offline welcome is fetchable and ackable', async () => {
    const alice = await createUser('Alice8')
    const bob = await createUser('Bob8')
    const groupId = await befriend(alice, bob)

    await postCommit(bob, groupId, {
      epoch: 0,
      welcomes: [{ deviceId: alice.deviceId, payload: fakeBytes() }],
      memberChanges: { adds: [alice.deviceId], removes: [] },
    })

    const welcomes = await app.inject({
      method: 'GET',
      url: '/api/v1/mls/welcomes',
      headers: auth(alice),
    })
    expect(welcomes.json().welcomes).toHaveLength(1)
    const welcomeId = welcomes.json().welcomes[0].welcomeId

    const aliceWs = await TestWsClient.connect(port, alice.token)
    const ackId = aliceWs.send('welcome.ack', { welcomeId })
    await aliceWs.waitFor((m) => m.type === 'ack' && m.replyTo === ackId)

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/mls/welcomes',
      headers: auth(alice),
    })
    expect(after.json().welcomes).toHaveLength(0)
    await aliceWs.close()
  })

  it('hello.ok reports kp and pending counts', async () => {
    const { alice, bob, groupId } = await setupChat()
    await uploadKps(alice, 5)
    const bobWs = await TestWsClient.connect(port, bob.token)
    const sendId = bobWs.send('chat.send', { groupId, epoch: 1, ciphertext: fakeBytes() })
    await bobWs.waitFor((m) => m.type === 'ack' && m.replyTo === sendId)
    await bobWs.close()

    const aliceWs = await TestWsClient.connect(port, alice.token)
    const hello = aliceWs.received.find((m) => m.type === 'hello.ok')
    expect(hello).toMatchObject({
      payload: { kpRemaining: 5, pending: { messages: 2 } },
    })
    await aliceWs.close()
  })
})
