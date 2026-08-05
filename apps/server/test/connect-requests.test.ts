import { randomBytes } from 'node:crypto'
import type { DeviceId } from '@gathernet/shared'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  accounts,
  blocks,
  communities,
  communityMembers,
  devices,
  friendships,
} from '../src/db/schema.ts'
import {
  acceptConnectRequest,
  cancelConnectRequest,
  createConnectRequest,
  declineConnectRequest,
  listConnectRecipients,
  listConnectRequests,
} from '../src/modules/friends/service.ts'
import { makeTestDb, type TestDb } from './helpers/db.ts'

let testDb: TestDb
let db: TestDb['db']
let n = 0

beforeAll(async () => {
  testDb = await makeTestDb()
  db = testDb.db
})
afterAll(async () => {
  await testDb.teardown()
})

async function newAccount(): Promise<string> {
  const accountId = `ac_${(n++).toString(16).padStart(16, '0')}`
  await db
    .insert(accounts)
    .values({ accountId, accountPk: randomBytes(32), displayName: accountId })
  return accountId
}

async function newDevice(accountId: string, receipt = true): Promise<string> {
  const deviceId = `dv_${(n++).toString(16).padStart(16, '0')}`
  await db.insert(devices).values({
    deviceId,
    accountId,
    devicePk: randomBytes(32),
    cert: randomBytes(32),
    certSig: randomBytes(64),
    name: 'Browser',
    ...(receipt ? { receiptPk: randomBytes(32), receiptPkSig: randomBytes(64) } : {}),
  })
  return deviceId
}

/** Put two accounts into a shared active community. */
async function shareCommunity(a: string, b: string): Promise<void> {
  const communityId = `cm_${(n++).toString(16).padStart(16, '0')}`
  await db.insert(communities).values({ communityId, ownerAccountId: a })
  await db.insert(communityMembers).values([
    { communityId, accountId: a, role: 'owner', status: 'active' },
    { communityId, accountId: b, role: 'member', status: 'active' },
  ])
}

function sealedRecipient(deviceId: string) {
  return {
    recipientDeviceId: deviceId as DeviceId,
    sealed: randomBytes(48).toString('base64'),
    senderPkB64: randomBytes(32).toString('base64'),
  }
}

describe('connect requests', () => {
  it('lists a target’s receipt-keyed devices for a co-member, then delivers the request', async () => {
    const a = await newAccount()
    const aDevice = await newDevice(a, false)
    const b = await newAccount()
    const bDevice = await newDevice(b, true)
    await newDevice(b, false) // no receipt key → not a recipient
    await shareCommunity(a, b)

    const recips = await listConnectRecipients(db, a, b)
    expect(recips.devices.map((d) => d.deviceId)).toEqual([bDevice])

    const sealed = sealedRecipient(bDevice).sealed
    await createConnectRequest(db, a, {
      toAccountId: b as never,
      requesterDeviceId: aDevice as DeviceId,
      requesterSig: randomBytes(64).toString('base64'),
      recipients: [{ recipientDeviceId: bDevice as DeviceId, sealed, senderPkB64: 'pk' }],
    })

    // B (on bDevice) sees it incoming; A sees it outgoing.
    const bView = await listConnectRequests(db, b, bDevice)
    expect(bView.incoming).toHaveLength(1)
    expect(bView.incoming[0]?.fromAccountId).toBe(a)
    expect(bView.incoming[0]?.sealed).toBe(sealed)
    const aView = await listConnectRequests(db, a, aDevice)
    expect(aView.outgoing).toHaveLength(1)
    expect(aView.outgoing[0]?.toAccountId).toBe(b)
    expect(aView.incoming).toHaveLength(0)
  })

  it('refuses a request to a non-co-member', async () => {
    const a = await newAccount()
    const aDevice = await newDevice(a)
    const b = await newAccount()
    await newDevice(b)
    // no shared community
    await expect(
      createConnectRequest(db, a, {
        toAccountId: b as never,
        requesterDeviceId: aDevice as DeviceId,
        requesterSig: 'sig',
        recipients: [sealedRecipient(aDevice)],
      }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('accepting creates a friendship and clears the request', async () => {
    const a = await newAccount()
    const aDevice = await newDevice(a)
    const b = await newAccount()
    const bDevice = await newDevice(b)
    await shareCommunity(a, b)
    await createConnectRequest(db, a, {
      toAccountId: b as never,
      requesterDeviceId: aDevice as DeviceId,
      requesterSig: 'sig',
      recipients: [sealedRecipient(bDevice)],
    })
    const reqId = (await listConnectRequests(db, b, bDevice)).incoming[0]?.requestId
    if (!reqId) throw new Error('no request')

    const res = await acceptConnectRequest(db, b, reqId)
    expect(res.inviter.accountId).toBe(a)
    expect(res.accepter.accountId).toBe(b)

    const pair = a < b ? { x: a, y: b } : { x: b, y: a }
    const fr = await db
      .select()
      .from(friendships)
      .where(and(eq(friendships.accountA, pair.x), eq(friendships.accountB, pair.y)))
    expect(fr).toHaveLength(1)
    // request is gone
    expect((await listConnectRequests(db, b, bDevice)).incoming).toHaveLength(0)
  })

  it('only the target can accept; only the sender can cancel', async () => {
    const a = await newAccount()
    const aDevice = await newDevice(a)
    const b = await newAccount()
    const bDevice = await newDevice(b)
    await shareCommunity(a, b)
    await createConnectRequest(db, a, {
      toAccountId: b as never,
      requesterDeviceId: aDevice as DeviceId,
      requesterSig: 'sig',
      recipients: [sealedRecipient(bDevice)],
    })
    const reqId = (await listConnectRequests(db, b, bDevice)).incoming[0]?.requestId
    if (!reqId) throw new Error('no request')

    // The sender cannot accept their own request (not the target).
    await expect(acceptConnectRequest(db, a, reqId)).rejects.toMatchObject({ status: 404 })
    // The target cannot cancel (that's the sender's action).
    await expect(cancelConnectRequest(db, b, reqId)).rejects.toMatchObject({ status: 404 })
    // The sender cancels; it's gone.
    await cancelConnectRequest(db, a, reqId)
    expect((await listConnectRequests(db, b, bDevice)).incoming).toHaveLength(0)
  })

  it('declining silently removes the request', async () => {
    const a = await newAccount()
    const aDevice = await newDevice(a)
    const b = await newAccount()
    const bDevice = await newDevice(b)
    await shareCommunity(a, b)
    await createConnectRequest(db, a, {
      toAccountId: b as never,
      requesterDeviceId: aDevice as DeviceId,
      requesterSig: 'sig',
      recipients: [sealedRecipient(bDevice)],
    })
    const reqId = (await listConnectRequests(db, b, bDevice)).incoming[0]?.requestId
    if (!reqId) throw new Error('no request')
    await declineConnectRequest(db, b, reqId)
    expect((await listConnectRequests(db, b, bDevice)).incoming).toHaveLength(0)
    // no friendship formed
    const pair = a < b ? { x: a, y: b } : { x: b, y: a }
    const fr = await db
      .select()
      .from(friendships)
      .where(and(eq(friendships.accountA, pair.x), eq(friendships.accountB, pair.y)))
    expect(fr).toHaveLength(0)
  })

  it('a block prevents connecting (no leak — generic not_connectable)', async () => {
    const a = await newAccount()
    const aDevice = await newDevice(a)
    const b = await newAccount()
    await newDevice(b)
    await shareCommunity(a, b)
    await db.insert(blocks).values({
      blockerAccountId: b,
      blockedAccountId: a,
      expiresAt: new Date(Date.now() + 3600_000),
    })
    await expect(listConnectRecipients(db, a, b)).rejects.toMatchObject({ status: 404 })
    await expect(
      createConnectRequest(db, a, {
        toAccountId: b as never,
        requesterDeviceId: aDevice as DeviceId,
        requesterSig: 'sig',
        recipients: [sealedRecipient(aDevice)],
      }),
    ).rejects.toMatchObject({ status: 404 })
  })
})
