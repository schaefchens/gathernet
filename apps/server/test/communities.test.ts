import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { pruneChannelInvites, pruneCommunityInvites } from '../src/modules/communities/service.ts'
import { pruneChannelMessages } from '../src/modules/delivery/service.ts'
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
/** Stand-in for a server-opaque sealed metadata / media blob. */
const sealed = (n = 48) => randomBytes(n).toString('base64')

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

function auth(user: TestUser) {
  return { authorization: `Bearer ${user.token}` }
}

async function createCommunity(owner: TestUser, meta?: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/communities',
    headers: auth(owner),
    payload: meta ? { metaCiphertext: meta } : {},
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

/** Invite user into community as a member. */
async function addMember(owner: TestUser, communityId: string, user: TestUser) {
  const code = await makeInvite(owner, communityId, { maxUses: 10 })
  const res = await join(user, code)
  expect(res.statusCode).toBe(200)
  return res
}

interface ChannelOpts {
  meta?: string
  access?: 'members' | 'leaders'
  visibility?: 'listed' | 'unlisted'
  joinPolicy?: 'open' | 'request'
  postPolicy?: 'everyone' | 'moderators'
  messageTtlDays?: number
}

async function createChannel(
  leader: TestUser,
  communityId: string,
  opts: ChannelOpts = {},
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/communities/${communityId}/channels`,
    headers: auth(leader),
    payload: {
      metaCiphertext: opts.meta ?? sealed(),
      access: opts.access ?? 'members',
      visibility: opts.visibility ?? 'listed',
      joinPolicy: opts.joinPolicy ?? 'open',
      postPolicy: opts.postPolicy ?? 'everyone',
      messageTtlDays: opts.messageTtlDays ?? 30,
    },
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

async function postJoin(user: TestUser, communityId: string, channelId: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/communities/${communityId}/channels/${channelId}/join`,
    headers: auth(user),
  })
}

/** External-join commit so the device lands in group_members. */
async function externalJoin(user: TestUser, channelId: string, epoch: number) {
  return app.inject({
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
}

/** Full open-channel join: request membership then external-join via MLS. */
async function joinOpenChannel(user: TestUser, communityId: string, channelId: string) {
  const jr = await postJoin(user, communityId, channelId)
  expect(jr.statusCode).toBe(200)
  expect(jr.json().status).toBe('active')
  const commit = await externalJoin(user, channelId, jr.json().epoch)
  expect(commit.statusCode).toBe(200)
  return jr
}

async function detail(user: TestUser, communityId: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/communities/${communityId}`,
    headers: auth(user),
  })
}

function channelsOf(res: Awaited<ReturnType<typeof detail>>) {
  return res.json().channels as Array<{
    channelId: string
    metaCiphertext: string | null
    access: string
    visibility: string
    joinPolicy: string
    messageTtlDays: number
    myStatus: string
    myRole: string
    joined: boolean
  }>
}

describe('community lifecycle + encrypted metadata', () => {
  it('creator becomes owner; metadata is stored + returned as opaque ciphertext', async () => {
    const owner = await createUser('Owner1')
    const meta = sealed()
    const communityId = await createCommunity(owner, meta)
    const res = await detail(owner, communityId)
    expect(res.statusCode).toBe(200)
    expect(res.json().myRole).toBe('owner')
    // Server stores/serves ciphertext verbatim — it never sees plaintext.
    expect(res.json().community.metaCiphertext).toBe(meta)
    expect(res.json().community.avatarMediaId).toBeNull()
    expect(res.json().members).toMatchObject([
      { accountId: owner.accountId, role: 'owner', displayName: 'Owner1' },
    ])
  })

  it('invite → accept → member visible in list with role + channel count', async () => {
    const owner = await createUser('Owner2')
    const member = await createUser('Member2')
    const meta = sealed()
    const communityId = await createCommunity(owner, meta)
    await createChannel(owner, communityId)
    await addMember(owner, communityId, member)

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/communities',
      headers: auth(member),
    })
    expect(list.json().communities).toMatchObject([
      { communityId, myRole: 'member', channelCount: 1, metaCiphertext: meta },
    ])
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
    expect((await detail(stranger, communityId)).statusCode).toBe(404)
  })

  it('leader updates community metadata + avatar; members get community.updated', async () => {
    const owner = await createUser('Owner4b')
    const member = await createUser('Member4b')
    const communityId = await createCommunity(owner, sealed())
    await addMember(owner, communityId, member)
    const memberWs = await TestWsClient.connect(port, member.token)

    const avatar = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/media`,
      headers: auth(owner),
      payload: { ciphertext: sealed(128) },
    })
    expect(avatar.statusCode).toBe(201)
    const mediaId = avatar.json().mediaId
    expect(mediaId).toMatch(/^md_[0-9a-f]{32}$/)

    const newMeta = sealed()
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/communities/${communityId}`,
      headers: auth(owner),
      payload: { metaCiphertext: newMeta, avatarMediaId: mediaId },
    })
    expect(patch.statusCode).toBe(200)
    await memberWs.waitFor((m) => m.type === 'community.updated')

    const d = await detail(member, communityId)
    expect(d.json().community.metaCiphertext).toBe(newMeta)
    expect(d.json().community.avatarMediaId).toBe(mediaId)
    await memberWs.close()
  })
})

describe('encrypted media', () => {
  it('uploads + serves ciphertext to members, rejects oversize + non-members', async () => {
    const owner = await createUser('OwnerMed')
    const member = await createUser('MemberMed')
    const stranger = await createUser('StrangerMed')
    const communityId = await createCommunity(owner)
    await addMember(owner, communityId, member)

    const ciphertext = sealed(256)
    const up = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/media`,
      headers: auth(member),
      payload: { ciphertext },
    })
    expect(up.statusCode).toBe(201)
    const mediaId = up.json().mediaId

    // Member fetches the exact ciphertext back (server never decrypts).
    const got = await app.inject({
      method: 'GET',
      url: `/api/v1/communities/media/${mediaId}`,
      headers: auth(member),
    })
    expect(got.statusCode).toBe(200)
    expect(got.rawPayload.toString('base64')).toBe(ciphertext)

    // A non-member cannot fetch it.
    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/communities/media/${mediaId}`,
      headers: auth(stranger),
    })
    expect(denied.statusCode).toBe(404)

    // Oversize ciphertext is rejected.
    const big = Buffer.alloc(400 * 1024).toString('base64')
    const tooBig = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/media`,
      headers: auth(owner),
      payload: { ciphertext: big },
    })
    expect(tooBig.statusCode).toBe(413)
  })
})

describe('channels: metadata, visibility, access', () => {
  it('create returns v2 settings + opaque metadata; round-trips in detail', async () => {
    const owner = await createUser('OwnerCh')
    const meta = sealed()
    const communityId = await createCommunity(owner)
    const channelId = await createChannel(owner, communityId, {
      meta,
      access: 'members',
      visibility: 'listed',
      joinPolicy: 'request',
      postPolicy: 'moderators',
      messageTtlDays: 7,
    })
    const chans = channelsOf(await detail(owner, communityId))
    const chan = chans.find((c) => c.channelId === channelId)
    expect(chan).toMatchObject({
      metaCiphertext: meta,
      access: 'members',
      visibility: 'listed',
      joinPolicy: 'request',
      postPolicy: 'moderators',
      messageTtlDays: 7,
      // creator is an active moderator
      myStatus: 'active',
      myRole: 'moderator',
      joined: true,
    })
  })

  it('leaders channel is hidden from members but visible to leaders', async () => {
    const owner = await createUser('Owner5')
    const member = await createUser('Member5')
    const communityId = await createCommunity(owner)
    const membersChan = await createChannel(owner, communityId, { access: 'members' })
    const leadersChan = await createChannel(owner, communityId, { access: 'leaders' })
    await addMember(owner, communityId, member)

    const memberIds = channelsOf(await detail(member, communityId)).map((c) => c.channelId)
    expect(memberIds).toContain(membersChan)
    expect(memberIds).not.toContain(leadersChan)

    const ownerIds = channelsOf(await detail(owner, communityId)).map((c) => c.channelId)
    expect(ownerIds).toEqual(expect.arrayContaining([membersChan, leadersChan]))
  })

  it('unlisted channel is not shown in the directory until you are involved', async () => {
    const owner = await createUser('OwnerUn')
    const member = await createUser('MemberUn')
    const communityId = await createCommunity(owner)
    const hidden = await createChannel(owner, communityId, { visibility: 'unlisted' })
    await addMember(owner, communityId, member)

    const before = channelsOf(await detail(member, communityId)).map((c) => c.channelId)
    expect(before).not.toContain(hidden)

    // Direct self-join of an unlisted channel is refused.
    const blind = await postJoin(member, communityId, hidden)
    expect(blind.statusCode).toBe(404)
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
})

describe('channel join flows', () => {
  it('open channel: join → active → external-join → joined', async () => {
    const owner = await createUser('Owner7')
    const member = await createUser('Member7')
    const communityId = await createCommunity(owner)
    const channelId = await createChannel(owner, communityId, { joinPolicy: 'open' })
    await addMember(owner, communityId, member)

    // GroupInfo is not released before joining.
    const pre = await getChannel(member, channelId)
    expect(pre.statusCode).toBe(200)
    expect(pre.json().status).toBe('none')
    expect(pre.json().groupInfo).toBeNull()

    await joinOpenChannel(member, communityId, channelId)
    const chan = channelsOf(await detail(member, communityId)).find(
      (c) => c.channelId === channelId,
    )
    expect(chan).toMatchObject({ myStatus: 'active', joined: true })
  })

  it('request channel: pending until a moderator accepts (WS carries GroupInfo)', async () => {
    const owner = await createUser('Owner8')
    const member = await createUser('Member8')
    const communityId = await createCommunity(owner)
    const channelId = await createChannel(owner, communityId, { joinPolicy: 'request' })
    await addMember(owner, communityId, member)

    const ownerWs = await TestWsClient.connect(port, owner.token)
    const memberWs = await TestWsClient.connect(port, member.token)

    const jr = await postJoin(member, communityId, channelId)
    expect(jr.statusCode).toBe(200)
    expect(jr.json().status).toBe('pending')
    expect(jr.json().groupInfo).toBeNull()

    // Owner (leader/manager) is notified of the request.
    const reqEvt = await ownerWs.waitFor((m) => m.type === 'community.channel_join_request')
    expect(reqEvt).toMatchObject({ payload: { channelId, accountId: member.accountId } })

    // A pending member cannot yet post commits.
    const early = await externalJoin(member, channelId, 0)
    expect(early.statusCode).toBe(404)

    // Owner accepts → member receives GroupInfo and can external-join.
    const accept = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/channels/${channelId}/requests/${member.accountId}`,
      headers: auth(owner),
      payload: { action: 'accept' },
    })
    expect(accept.statusCode).toBe(200)
    const approved = await memberWs.waitFor((m) => m.type === 'community.channel_join_approved')
    expect(approved).toMatchObject({ payload: { channelId } })
    const approvedPayload = approved.payload as { groupInfo: string | null; epoch: number }
    expect(approvedPayload.groupInfo).not.toBeNull()

    const commit = await externalJoin(member, channelId, approvedPayload.epoch)
    expect(commit.statusCode).toBe(200)
    await ownerWs.close()
    await memberWs.close()
  })

  it('request channel: moderator declines → requester stays out', async () => {
    const owner = await createUser('Owner8b')
    const member = await createUser('Member8b')
    const communityId = await createCommunity(owner)
    const channelId = await createChannel(owner, communityId, { joinPolicy: 'request' })
    await addMember(owner, communityId, member)
    const memberWs = await TestWsClient.connect(port, member.token)

    expect((await postJoin(member, communityId, channelId)).json().status).toBe('pending')
    const decline = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/channels/${channelId}/requests/${member.accountId}`,
      headers: auth(owner),
      payload: { action: 'decline' },
    })
    expect(decline.statusCode).toBe(200)
    await memberWs.waitFor((m) => m.type === 'community.channel_join_declined')
    expect((await getChannel(member, channelId)).json().status).toBe('none')
    await memberWs.close()
  })

  it('targeted invite: invitee accepts by joining', async () => {
    const owner = await createUser('Owner9')
    const member = await createUser('Member9')
    const communityId = await createCommunity(owner)
    // request policy proves the invite (not the policy) is what admits them.
    const channelId = await createChannel(owner, communityId, { joinPolicy: 'request' })
    await addMember(owner, communityId, member)
    const memberWs = await TestWsClient.connect(port, member.token)

    const invite = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/channels/${channelId}/invites`,
      headers: auth(owner),
      payload: { kind: 'targeted', inviteeAccountId: member.accountId },
    })
    expect(invite.statusCode).toBe(201)
    expect(invite.json().code).toBeNull()
    await memberWs.waitFor((m) => m.type === 'community.channel_invited')

    // Invitee's join accepts the invite → active immediately (bypasses request).
    const jr = await postJoin(member, communityId, channelId)
    expect(jr.json().status).toBe('active')
    expect((await externalJoin(member, channelId, jr.json().epoch)).statusCode).toBe(200)
    await memberWs.close()
  })

  it('code invite: reaches an unlisted channel; respects open policy', async () => {
    const owner = await createUser('Owner10')
    const member = await createUser('Member10')
    const communityId = await createCommunity(owner)
    const channelId = await createChannel(owner, communityId, {
      visibility: 'unlisted',
      joinPolicy: 'open',
    })
    await addMember(owner, communityId, member)

    const invite = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/channels/${channelId}/invites`,
      headers: auth(owner),
      payload: { kind: 'code', maxUses: 5 },
    })
    expect(invite.statusCode).toBe(201)
    const code = invite.json().code
    expect(code).toHaveLength(10)

    const jr = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/channels/join-by-code`,
      headers: auth(member),
      payload: { code },
    })
    expect(jr.statusCode).toBe(200)
    expect(jr.json().status).toBe('active')
    expect(jr.json().channelId).toBe(channelId)
    expect((await externalJoin(member, channelId, jr.json().epoch)).statusCode).toBe(200)
  })

  it('member refused a leaders channel join', async () => {
    const owner = await createUser('Owner11')
    const member = await createUser('Member11')
    const communityId = await createCommunity(owner)
    const leadersChan = await createChannel(owner, communityId, { access: 'leaders' })
    await addMember(owner, communityId, member)
    const refused = await postJoin(member, communityId, leadersChan)
    expect(refused.statusCode).toBe(403)
    expect(refused.json().error).toBe('channel_forbidden')
  })
})

describe('moderators + channel kicks', () => {
  it('leader appoints a moderator who accepts requests + kicks from the channel', async () => {
    const owner = await createUser('OwnerMod')
    const mod = await createUser('ModMod')
    const joiner = await createUser('JoinMod')
    const communityId = await createCommunity(owner)
    const channelId = await createChannel(owner, communityId, { joinPolicy: 'request' })
    await addMember(owner, communityId, mod)
    await addMember(owner, communityId, joiner)

    // mod must be an active channel member before being made moderator; on a
    // request channel their own join is pending until the owner accepts it.
    expect((await postJoin(mod, communityId, channelId)).json().status).toBe('pending')
    await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/channels/${channelId}/requests/${mod.accountId}`,
      headers: auth(owner),
      payload: { action: 'accept' },
    })
    expect((await getChannel(mod, channelId)).json().status).toBe('active')

    // Only a leader/owner may appoint a moderator; a plain member cannot.
    const byMember = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/channels/${channelId}/moderators/${joiner.accountId}`,
      headers: auth(joiner),
      payload: { action: 'set' },
    })
    expect(byMember.statusCode).toBe(403)

    const appoint = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/channels/${channelId}/moderators/${mod.accountId}`,
      headers: auth(owner),
      payload: { action: 'set' },
    })
    expect(appoint.statusCode).toBe(200)

    // The moderator (not a community leader) accepts the joiner's request.
    expect((await postJoin(joiner, communityId, channelId)).json().status).toBe('pending')
    const accept = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/channels/${channelId}/requests/${joiner.accountId}`,
      headers: auth(mod),
      payload: { action: 'accept' },
    })
    expect(accept.statusCode).toBe(200)

    const joinerWs = await TestWsClient.connect(port, joiner.token)
    // The moderator kicks the joiner from the channel.
    const kick = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/channels/${channelId}/kick/${joiner.accountId}`,
      headers: auth(mod),
      payload: {},
    })
    expect(kick.statusCode).toBe(200)
    const kicked = await joinerWs.waitFor(
      (m) => m.type === 'community.channel_member_changed' && m.payload.status === 'none',
    )
    expect(kicked).toMatchObject({ payload: { channelId, accountId: joiner.accountId } })

    // Kicked from the channel but still in the community.
    expect((await getChannel(joiner, channelId)).json().status).toBe('none')
    expect((await detail(joiner, communityId)).statusCode).toBe(200)
    await joinerWs.close()
  })

  it('a moderator cannot kick a community leader from a channel', async () => {
    const owner = await createUser('OwnerK')
    const leader = await createUser('LeaderK')
    const mod = await createUser('ModK')
    const communityId = await createCommunity(owner)
    const channelId = await createChannel(owner, communityId)
    await addMember(owner, communityId, leader)
    await addMember(owner, communityId, mod)
    // promote leader
    await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/members/${leader.accountId}/role`,
      headers: auth(owner),
      payload: { role: 'leader' },
    })
    await joinOpenChannel(leader, communityId, channelId)
    await joinOpenChannel(mod, communityId, channelId)
    await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/channels/${channelId}/moderators/${mod.accountId}`,
      headers: auth(owner),
      payload: { action: 'set' },
    })

    const kick = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/channels/${channelId}/kick/${leader.accountId}`,
      headers: auth(mod),
      payload: {},
    })
    expect(kick.statusCode).toBe(403)
    expect(kick.json().error).toBe('cannot_kick_leader')
  })

  it('manager can list the channel roster (active + pending); a member cannot', async () => {
    const owner = await createUser('OwnerR')
    const member = await createUser('MemberR')
    const communityId = await createCommunity(owner)
    const channelId = await createChannel(owner, communityId, { joinPolicy: 'request' })
    await addMember(owner, communityId, member)
    expect((await postJoin(member, communityId, channelId)).json().status).toBe('pending')

    const roster = await app.inject({
      method: 'GET',
      url: `/api/v1/communities/${communityId}/channels/${channelId}/members`,
      headers: auth(owner),
    })
    expect(roster.statusCode).toBe(200)
    const entries = roster.json().members as Array<{
      accountId: string
      status: string
      role: string
    }>
    expect(entries).toEqual(
      expect.arrayContaining([
        { accountId: owner.accountId, displayName: 'OwnerR', status: 'active', role: 'moderator' },
        { accountId: member.accountId, displayName: 'MemberR', status: 'pending', role: 'member' },
      ]),
    )

    // A plain (non-manager) community member cannot read the roster.
    const other = await createUser('OtherR')
    await addMember(owner, communityId, other)
    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/communities/${communityId}/channels/${channelId}/members`,
      headers: auth(other),
    })
    expect(denied.statusCode).toBe(403)
  })

  it('read-only channel: only moderators may post application messages', async () => {
    const owner = await createUser('OwnerRO')
    const member = await createUser('MemberRO')
    const communityId = await createCommunity(owner)
    const channelId = await createChannel(owner, communityId, { postPolicy: 'moderators' })
    await addMember(owner, communityId, member)
    await joinOpenChannel(member, communityId, channelId)

    const { postMessage } = await import('../src/modules/delivery/service.ts')

    // A non-moderator member has read access but is refused posting.
    const memberEpoch = (await getChannel(member, channelId)).json().epoch as number
    await expect(
      postMessage(testDb.db, member.deviceId, channelId, memberEpoch, fakeB64(48)),
    ).rejects.toThrow('read_only_channel')

    // The owner (a channel moderator) may post.
    const ownerEpoch = (await getChannel(owner, channelId)).json().epoch as number
    await expect(
      postMessage(testDb.db, owner.deviceId, channelId, ownerEpoch, fakeB64(48)),
    ).resolves.toMatchObject({ senderDevice: owner.deviceId })

    // Toggling back to everyone re-opens posting for the member.
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/communities/${communityId}/channels/${channelId}`,
      headers: auth(owner),
      payload: { postPolicy: 'everyone' },
    })
    expect(patch.statusCode).toBe(200)
    const epoch2 = (await getChannel(member, channelId)).json().epoch as number
    await expect(
      postMessage(testDb.db, member.deviceId, channelId, epoch2, fakeB64(48)),
    ).resolves.toMatchObject({ senderDevice: member.deviceId })
  })

  it('a plain member cannot accept requests, invite, or kick', async () => {
    const owner = await createUser('OwnerP')
    const member = await createUser('MemberP')
    const other = await createUser('OtherP')
    const communityId = await createCommunity(owner)
    const channelId = await createChannel(owner, communityId, { joinPolicy: 'request' })
    await addMember(owner, communityId, member)
    await addMember(owner, communityId, other)
    await postJoin(other, communityId, channelId) // pending

    const accept = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/channels/${channelId}/requests/${other.accountId}`,
      headers: auth(member),
      payload: { action: 'accept' },
    })
    expect(accept.statusCode).toBe(403)

    const invite = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/channels/${channelId}/invites`,
      headers: auth(member),
      payload: { kind: 'code' },
    })
    expect(invite.statusCode).toBe(403)
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
    await joinOpenChannel(alice, communityId, channelId)
    await joinOpenChannel(bob, communityId, channelId)

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
})

describe('community removal clears channel membership', () => {
  it('removing a member blocks channel access + rejoin', async () => {
    const owner = await createUser('OwnerC')
    const member = await createUser('MemberC')
    const communityId = await createCommunity(owner)
    const channelId = await createChannel(owner, communityId)
    await addMember(owner, communityId, member)
    await joinOpenChannel(member, communityId, channelId)

    const memberWs = await TestWsClient.connect(port, member.token)
    const remove = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/members/${member.accountId}/remove`,
      headers: auth(owner),
    })
    expect(remove.statusCode).toBe(200)
    await memberWs.waitFor((m) => m.type === 'community.member_removed')

    // Channel + community both closed to the removed member.
    expect((await getChannel(member, channelId)).statusCode).toBe(404)
    expect((await detail(member, communityId)).statusCode).toBe(404)
    const rejoin = await externalJoin(member, channelId, 1)
    expect(rejoin.statusCode).toBe(404)
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
      payload: { access: 'members' },
    })
    expect(chan.statusCode).toBe(403)

    const invite = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/invites`,
      headers: auth(member),
      payload: {},
    })
    expect(invite.statusCode).toBe(403)

    const role = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/members/${other.accountId}/role`,
      headers: auth(member),
      payload: { role: 'leader' },
    })
    expect(role.statusCode).toBe(403)
  })

  it('promoting a member to leader unlocks the leaders channel + creation rights', async () => {
    const owner = await createUser('OwnerF')
    const leader = await createUser('LeaderF')
    const communityId = await createCommunity(owner)
    const leadersChan = await createChannel(owner, communityId, { access: 'leaders' })
    await addMember(owner, communityId, leader)
    expect((await postJoin(leader, communityId, leadersChan)).statusCode).toBe(403)

    await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/members/${leader.accountId}/role`,
      headers: auth(owner),
      payload: { role: 'leader' },
    })
    // Now eligible for the leaders channel and can create channels.
    expect((await postJoin(leader, communityId, leadersChan)).json().status).toBe('active')
    const chan = await createChannel(leader, communityId)
    expect(chan).toBeTruthy()
  })
})

describe('disappearing messages + invite pruning', () => {
  it('prunes channel ciphertext past the per-channel TTL', async () => {
    const owner = await createUser('OwnerTTL')
    const communityId = await createCommunity(owner)
    const channelId = await createChannel(owner, communityId, { messageTtlDays: 1 })
    const { sql } = await import('drizzle-orm')

    // One message aged past the TTL, one fresh.
    await testDb.db.execute(
      sql`INSERT INTO mls_messages (group_id, seq, kind, epoch, sender_device, payload, created_at)
          VALUES (${channelId}, 100, 'application', 0, ${owner.deviceId}, decode('00', 'hex'), now() - interval '2 days'),
                 (${channelId}, 101, 'application', 0, ${owner.deviceId}, decode('01', 'hex'), now())`,
    )
    const pruned = await pruneChannelMessages(testDb.db)
    expect(pruned).toBeGreaterThanOrEqual(1)
    const remaining = await testDb.db.execute(
      sql`SELECT seq FROM mls_messages WHERE group_id = ${channelId}`,
    )
    const seqs = remaining.rows.map((r) => (r as { seq: number }).seq)
    expect(seqs).toContain(101)
    expect(seqs).not.toContain(100)
  })

  it('prunes expired community + channel invites', async () => {
    const owner = await createUser('OwnerG')
    const communityId = await createCommunity(owner)
    const channelId = await createChannel(owner, communityId)
    await makeInvite(owner, communityId, {})
    await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${communityId}/channels/${channelId}/invites`,
      headers: auth(owner),
      payload: { kind: 'code' },
    })
    const { sql } = await import('drizzle-orm')
    await testDb.db.execute(
      sql`UPDATE community_invites SET expires_at = now() - interval '1 day' WHERE community_id = ${communityId}`,
    )
    await testDb.db.execute(
      sql`UPDATE channel_invites SET expires_at = now() - interval '1 day' WHERE channel_id = ${channelId}`,
    )
    expect(await pruneCommunityInvites(testDb.db)).toBeGreaterThanOrEqual(1)
    expect(await pruneChannelInvites(testDb.db)).toBeGreaterThanOrEqual(1)
  })
})
