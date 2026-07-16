import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { pruneCommunityInvites } from '../src/modules/communities/service.ts'
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

const fakeB64 = (n = 64) => randomBytes(n).toString('base64')

interface TestUser {
  accountId: string
  deviceId: string
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
  const json = res.json()
  return { accountId: json.accountId, deviceId: json.deviceId, token: json.token, identity }
}

/** Enroll a second device onto an existing account. */
async function enrollDevice(user: TestUser, name = 'Second'): Promise<TestUser> {
  const device = generateEd25519()
  const challengeRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/challenge',
    payload: { purpose: 'enroll' },
  })
  const { body } = buildEnrollment(user.identity, device, challengeRes.json().challenge, name)
  const res = await app.inject({ method: 'POST', url: '/api/v1/devices', payload: body })
  expect(res.statusCode).toBe(201)
  const json = res.json()
  return { ...user, deviceId: json.deviceId, token: json.token }
}

function auth(user: TestUser) {
  return { authorization: `Bearer ${user.token}` }
}

async function createCommunity(owner: TestUser, name = 'Fellowship'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/communities',
    headers: auth(owner),
    payload: { name },
  })
  expect(res.statusCode).toBe(201)
  return res.json().communityId
}

async function makeInvite(user: TestUser, communityId: string, opts: object = {}): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/communities/${communityId}/invites`,
    headers: auth(user),
    payload: opts,
  })
  expect(res.statusCode).toBe(201)
  return res.json().code
}

async function join(user: TestUser, code: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/communities/invites/accept',
    headers: auth(user),
    payload: { code },
  })
}

/** Invite user into community as a member and return the response. */
async function addMember(owner: TestUser, communityId: string, user: TestUser) {
  const code = await makeInvite(owner, communityId, { maxUses: 10 })
  const res = await join(user, code)
  expect(res.statusCode).toBe(200)
  return res
}

async function createChannel(
  leader: TestUser,
  communityId: string,
  opts: { name?: string; access?: 'members' | 'leaders' } = {},
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/communities/${communityId}/channels`,
    headers: auth(leader),
    payload: { name: opts.name ?? 'general', access: opts.access ?? 'members' },
  })
  expect(res.statusCode).toBe(201)
  const channelId = res.json().channelId
  // Creator publishes epoch-0 GroupInfo (its device becomes the first leaf).
  const gi = await app.inject({
    method: 'POST',
    url: `/api/v1/communities/channels/${channelId}/group-info`,
    headers: auth(leader),
    payload: { groupInfo: fakeB64(128), deviceId: leader.deviceId },
  })
  expect(gi.statusCode).toBe(200)
  return channelId
}

async function getChannel(user: TestUser, channelId: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/communities/channels/${channelId}`,
    headers: auth(user),
  })
}

/** GET join info then external-join commit so the device lands in group_members. */
async function joinChannel(user: TestUser, channelId: string) {
  const info = await getChannel(user, channelId)
  expect(info.statusCode).toBe(200)
  const epoch = info.json().epoch as number
  const commit = await app.inject({
    method: 'POST',
    url: `/api/v1/communities/channels/${channelId}/commits`,
    headers: auth(user),
    payload: {
      epoch,
      commit: fakeB64(96),
      groupInfo: fakeB64(128),
      welcomes: [],
      memberChanges: { adds: [user.deviceId], removes: [] },
      deviceId: user.deviceId,
    },
  })
  return commit
}

async function detail(user: TestUser, communityId: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/communities/${communityId}`,
    headers: auth(user),
  })
}

describe('community lifecycle', () => {
  it('creator becomes owner', async () => {
    const owner = await createUser('Owner1')
    const communityId = await createCommunity(owner, 'Grace Church')
    const res = await detail(owner, communityId)
    expect(res.statusCode).toBe(200)
    expect(res.json().myRole).toBe('owner')
    expect(res.json().community.name).toBe('Grace Church')
    expect(res.json().members).toMatchObject([
      { accountId: owner.accountId, role: 'owner', displayName: 'Owner1' },
    ])
  })

  it('invite → accept → member, visible in list with role and channel count', async () => {
    const owner = await createUser('Owner2')
    const member = await createUser('Member2')
    const communityId = await createCommunity(owner)
    await createChannel(owner, communityId, { name: 'welcome' })
    const accepted = await addMember(owner, communityId, member)
    expect(accepted.json().communityId).toBe(communityId)

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/communities',
      headers: auth(member),
    })
    expect(list.json().communities).toMatchObject([
      { communityId, myRole: 'member', channelCount: 1 },
    ])

    const d = await detail(member, communityId)
    expect(d.json().members).toHaveLength(2)
    const roles = d
      .json()
      .members.map((m: { accountId: string; role: string }) => [m.accountId, m.role])
    expect(roles).toContainEqual([owner.accountId, 'owner'])
    expect(roles).toContainEqual([member.accountId, 'member'])
  })

  it('accepting again as an active member is rejected 409', async () => {
    const owner = await createUser('Owner3')
    const member = await createUser('Member3')
    const communityId = await createCommunity(owner)
    const code = await makeInvite(owner, communityId, { maxUses: 10 })
    expect((await join(member, code)).statusCode).toBe(200)
    const second = await join(member, code)
    expect(second.statusCode).toBe(409)
    expect(second.json().error).toBe('already_member')
  })

  it('non-member cannot read community detail', async () => {
    const owner = await createUser('Owner4')
    const stranger = await createUser('Stranger4')
    const communityId = await createCommunity(owner)
    const res = await detail(stranger, communityId)
    expect(res.statusCode).toBe(404)
  })
})

describe('channels and access levels', () => {
  it('leaders channel is hidden from members but visible to leaders', async () => {
    const owner = await createUser('Owner5')
    const member = await createUser('Member5')
    const communityId = await createCommunity(owner)
    const membersChan = await createChannel(owner, communityId, {
      name: 'lobby',
      access: 'members',
    })
    const leadersChan = await createChannel(owner, communityId, {
      name: 'elders',
      access: 'leaders',
    })
    await addMember(owner, communityId, member)

    const memberView = await detail(member, communityId)
    const memberChannelIds = memberView
      .json()
      .channels.map((c: { channelId: string }) => c.channelId)
    expect(memberChannelIds).toContain(membersChan)
    expect(memberChannelIds).not.toContain(leadersChan)

    const ownerView = await detail(owner, communityId)
    const ownerChannelIds = ownerView.json().channels.map((c: { channelId: string }) => c.channelId)
    expect(ownerChannelIds).toContain(membersChan)
    expect(ownerChannelIds).toContain(leadersChan)
  })

  it('re-publishing epoch-0 group-info fails already_initialized', async () => {
    const owner = await createUser('Owner6')
    const communityId = await createCommunity(owner)
    const channelId = await createChannel(owner, communityId)
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/channels/${channelId}/group-info`,
      headers: auth(owner),
      payload: { groupInfo: fakeB64(128), deviceId: owner.deviceId },
    })
    expect(again.statusCode).toBe(409)
    expect(again.json().error).toBe('already_initialized')
  })

  it('member can join a members channel and gets GroupInfo', async () => {
    const owner = await createUser('Owner7')
    const member = await createUser('Member7')
    const communityId = await createCommunity(owner)
    const channelId = await createChannel(owner, communityId)
    await addMember(owner, communityId, member)

    const info = await getChannel(member, channelId)
    expect(info.statusCode).toBe(200)
    expect(info.json().groupInfo).not.toBeNull()
    expect(info.json().access).toBe('members')

    const commit = await joinChannel(member, channelId)
    expect(commit.statusCode).toBe(200)

    // The member's device is now a leaf → detail reports joined.
    const d = await detail(member, communityId)
    const chan = d.json().channels.find((c: { channelId: string }) => c.channelId === channelId)
    expect(chan.joined).toBe(true)
  })

  it('member is refused the leaders channel; a leader may join it', async () => {
    const owner = await createUser('Owner8')
    const member = await createUser('Member8')
    const communityId = await createCommunity(owner)
    const leadersChan = await createChannel(owner, communityId, { access: 'leaders' })
    await addMember(owner, communityId, member)

    const refused = await getChannel(member, leadersChan)
    expect(refused.statusCode).toBe(403)
    expect(refused.json().error).toBe('channel_forbidden')

    // Even a blind commit attempt is rejected (server refuses authorization).
    const blind = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/channels/${leadersChan}/commits`,
      headers: auth(member),
      payload: {
        epoch: 0,
        commit: fakeB64(96),
        groupInfo: fakeB64(128),
        welcomes: [],
        memberChanges: { adds: [member.deviceId], removes: [] },
        deviceId: member.deviceId,
      },
    })
    expect(blind.statusCode).toBe(404)

    // The owner (a leader) can join the leaders channel — it was created with
    // the owner's device already as leaf, so a second owner device joins.
    const owner2 = await enrollDevice(owner, 'OwnerLaptop')
    const join2 = await joinChannel(owner2, leadersChan)
    expect(join2.statusCode).toBe(200)
  })

  it('promoting a member to leader unlocks the leaders channel', async () => {
    const owner = await createUser('Owner9')
    const member = await createUser('Member9')
    const communityId = await createCommunity(owner)
    const leadersChan = await createChannel(owner, communityId, { access: 'leaders' })
    await addMember(owner, communityId, member)

    expect((await getChannel(member, leadersChan)).statusCode).toBe(403)

    const promote = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/members/${member.accountId}/role`,
      headers: auth(owner),
      payload: { role: 'leader' },
    })
    expect(promote.statusCode).toBe(200)

    const after = await getChannel(member, leadersChan)
    expect(after.statusCode).toBe(200)
  })
})

describe('channel messaging', () => {
  it('chat.send fans out between two joined member devices', async () => {
    const owner = await createUser('OwnerA')
    const alice = await createUser('AliceA')
    const bob = await createUser('BobA')
    const communityId = await createCommunity(owner)
    const channelId = await createChannel(owner, communityId)
    await addMember(owner, communityId, alice)
    await addMember(owner, communityId, bob)
    expect((await joinChannel(alice, channelId)).statusCode).toBe(200)
    expect((await joinChannel(bob, channelId)).statusCode).toBe(200)

    const aliceWs = await TestWsClient.connect(port, alice.token)
    const bobWs = await TestWsClient.connect(port, bob.token)

    const info = await getChannel(alice, channelId)
    const epoch = info.json().epoch as number
    const ciphertext = fakeB64(96)
    const msgId = aliceWs.send('chat.send', { groupId: channelId, epoch, ciphertext })
    await aliceWs.waitFor((m) => m.type === 'ack' && m.replyTo === msgId)

    const received = await bobWs.waitFor((m) => m.type === 'chat.message')
    expect(received).toMatchObject({
      payload: { groupId: channelId, kind: 'application', payload: ciphertext },
    })

    await aliceWs.close()
    await bobWs.close()
  })

  it('two devices of the same member both join a channel', async () => {
    const owner = await createUser('OwnerB')
    const member = await createUser('MemberB')
    const communityId = await createCommunity(owner)
    const channelId = await createChannel(owner, communityId)
    await addMember(owner, communityId, member)

    const member2 = await enrollDevice(member, 'Phone')
    expect((await joinChannel(member, channelId)).statusCode).toBe(200)
    expect((await joinChannel(member2, channelId)).statusCode).toBe(200)

    const { sql } = await import('drizzle-orm')
    const leaves = await testDb.db.execute(
      sql`SELECT device_id FROM group_members WHERE group_id = ${channelId} AND account_id = ${member.accountId} AND removed_epoch IS NULL`,
    )
    const ids = leaves.rows.map((r) => (r as { device_id: string }).device_id)
    expect(ids).toContain(member.deviceId)
    expect(ids).toContain(member2.deviceId)
  })
})

describe('roles, removal, and permissions', () => {
  it('removing a member emits the event and blocks channel access + rejoin', async () => {
    const owner = await createUser('OwnerC')
    const member = await createUser('MemberC')
    const communityId = await createCommunity(owner)
    const channelId = await createChannel(owner, communityId)
    await addMember(owner, communityId, member)
    expect((await joinChannel(member, channelId)).statusCode).toBe(200)

    const memberWs = await TestWsClient.connect(port, member.token)
    const remove = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/members/${member.accountId}/remove`,
      headers: auth(owner),
    })
    expect(remove.statusCode).toBe(200)
    const evt = await memberWs.waitFor((m) => m.type === 'community.member_removed')
    expect(evt).toMatchObject({ payload: { communityId, accountId: member.accountId } })

    // Removed user is refused the channel and cannot commit back in.
    expect((await getChannel(member, channelId)).statusCode).toBe(403)
    const rejoin = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/channels/${channelId}/commits`,
      headers: auth(member),
      payload: {
        epoch: 1,
        commit: fakeB64(96),
        groupInfo: fakeB64(128),
        welcomes: [],
        memberChanges: { adds: [member.deviceId], removes: [] },
        deviceId: member.deviceId,
      },
    })
    expect(rejoin.statusCode).toBe(404)
    // And the community itself is no longer visible.
    expect((await detail(member, communityId)).statusCode).toBe(404)
    await memberWs.close()
  })

  it('members cannot create channels, invites, or remove others', async () => {
    const owner = await createUser('OwnerD')
    const member = await createUser('MemberD')
    const other = await createUser('OtherD')
    const communityId = await createCommunity(owner)
    await addMember(owner, communityId, member)
    await addMember(owner, communityId, other)

    const chan = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/channels`,
      headers: auth(member),
      payload: { name: 'nope', access: 'members' },
    })
    expect(chan.statusCode).toBe(403)

    const invite = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/invites`,
      headers: auth(member),
      payload: {},
    })
    expect(invite.statusCode).toBe(403)

    const remove = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/members/${other.accountId}/remove`,
      headers: auth(member),
    })
    expect(remove.statusCode).toBe(403)

    // Only the owner may change roles.
    const role = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/members/${other.accountId}/role`,
      headers: auth(member),
      payload: { role: 'leader' },
    })
    expect(role.statusCode).toBe(403)
  })

  it('owner cannot leave; a member can', async () => {
    const owner = await createUser('OwnerE')
    const member = await createUser('MemberE')
    const communityId = await createCommunity(owner)
    await addMember(owner, communityId, member)

    const ownerLeave = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/leave`,
      headers: auth(owner),
    })
    expect(ownerLeave.statusCode).toBe(400)
    expect(ownerLeave.json().error).toBe('owner_cannot_leave')

    const ownerWs = await TestWsClient.connect(port, owner.token)
    const memberLeave = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/leave`,
      headers: auth(member),
    })
    expect(memberLeave.statusCode).toBe(200)
    const evt = await ownerWs.waitFor((m) => m.type === 'community.member_left')
    expect(evt).toMatchObject({ payload: { communityId, accountId: member.accountId } })
    expect((await detail(member, communityId)).statusCode).toBe(404)
    await ownerWs.close()
  })

  it('a promoted leader can create channels and invites', async () => {
    const owner = await createUser('OwnerF')
    const leader = await createUser('LeaderF')
    const communityId = await createCommunity(owner)
    await addMember(owner, communityId, leader)
    await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/members/${leader.accountId}/role`,
      headers: auth(owner),
      payload: { role: 'leader' },
    })

    const chan = await createChannel(leader, communityId, { name: 'leader-made' })
    expect(chan).toBeTruthy()
    const invite = await makeInvite(leader, communityId, { maxUses: 5 })
    expect(invite).toHaveLength(10)
  })
})

describe('invite pruning', () => {
  it('deletes expired invites', async () => {
    const owner = await createUser('OwnerG')
    const communityId = await createCommunity(owner)
    await makeInvite(owner, communityId, {})
    const { sql } = await import('drizzle-orm')
    await testDb.db.execute(
      sql`UPDATE community_invites SET expires_at = now() - interval '1 day' WHERE community_id = ${communityId}`,
    )
    const pruned = await pruneCommunityInvites(testDb.db)
    expect(pruned).toBeGreaterThanOrEqual(1)
  })
})
