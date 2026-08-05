import { randomBytes } from 'node:crypto'
import type {
  ConnectRecipientsResponse,
  ConnectRequestsResponse,
  PostConnectRequest,
} from '@gathernet/shared'
import { CROCKFORD_ALPHABET, INVITE_CODE_LENGTH } from '@gathernet/shared'
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import {
  accounts,
  blocks,
  communityMembers,
  devices,
  friendInvites,
  friendRequestRecipients,
  friendRequests,
  friendships,
} from '../../db/schema.ts'
import { ServiceError } from '../accounts/service.ts'

const bufOf = (b64: string): Buffer => Buffer.from(b64, 'base64')

function newInviteCode(): string {
  // Alphabet length 32 divides 256 evenly — no modulo bias.
  const bytes = randomBytes(INVITE_CODE_LENGTH)
  let code = ''
  for (const b of bytes) code += CROCKFORD_ALPHABET[b % 32]
  return code
}

/** Canonical friendship pair: lexicographically smaller id first. */
export function pairOf(a: string, b: string): { accountA: string; accountB: string } {
  return a < b ? { accountA: a, accountB: b } : { accountA: b, accountB: a }
}

export async function createInvite(
  db: Db,
  accountId: string,
  options: { maxUses: number; ttlHours: number },
) {
  const [row] = await db
    .insert(friendInvites)
    .values({
      inviterAccountId: accountId,
      code: newInviteCode(),
      maxUses: options.maxUses,
      expiresAt: new Date(Date.now() + options.ttlHours * 3600 * 1000),
    })
    .returning()
  if (!row) throw new ServiceError(500, 'internal')
  return toInviteDto(row)
}

export async function listInvites(db: Db, accountId: string) {
  const rows = await db
    .select()
    .from(friendInvites)
    .where(
      and(
        eq(friendInvites.inviterAccountId, accountId),
        isNull(friendInvites.revokedAt),
        gt(friendInvites.expiresAt, new Date()),
        lt(friendInvites.useCount, friendInvites.maxUses),
      ),
    )
    .orderBy(friendInvites.createdAt)
  return rows.map(toInviteDto)
}

export async function revokeInvite(db: Db, accountId: string, inviteId: string): Promise<void> {
  const updated = await db
    .update(friendInvites)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(friendInvites.id, inviteId),
        eq(friendInvites.inviterAccountId, accountId),
        isNull(friendInvites.revokedAt),
      ),
    )
    .returning({ id: friendInvites.id })
  if (updated.length === 0) throw new ServiceError(404, 'invite_not_found')
}

export interface AcceptResult {
  inviter: { accountId: string; displayName: string }
  accepter: { accountId: string; displayName: string }
}

export async function acceptInvite(
  db: Db,
  accepterId: string,
  code: string,
): Promise<AcceptResult> {
  return db.transaction(async (tx) => {
    const [invite] = await tx
      .select()
      .from(friendInvites)
      .where(eq(friendInvites.code, code))
      .for('update')
    if (
      !invite ||
      invite.revokedAt !== null ||
      invite.expiresAt <= new Date() ||
      invite.useCount >= invite.maxUses
    ) {
      throw new ServiceError(404, 'invite_invalid')
    }
    if (invite.inviterAccountId === accepterId) {
      throw new ServiceError(400, 'self_invite')
    }

    const blocked = await tx
      .select()
      .from(blocks)
      .where(
        and(
          gt(blocks.expiresAt, new Date()), // only ACTIVE blocks suppress invites
          or(
            and(
              eq(blocks.blockerAccountId, invite.inviterAccountId),
              eq(blocks.blockedAccountId, accepterId),
            ),
            and(
              eq(blocks.blockerAccountId, accepterId),
              eq(blocks.blockedAccountId, invite.inviterAccountId),
            ),
          ),
        ),
      )
      .limit(1)
    // Deliberately the same error as an unknown code — do not leak blocks.
    if (blocked.length > 0) throw new ServiceError(404, 'invite_invalid')

    const pair = pairOf(invite.inviterAccountId, accepterId)
    const existing = await tx
      .select()
      .from(friendships)
      .where(and(eq(friendships.accountA, pair.accountA), eq(friendships.accountB, pair.accountB)))
      .limit(1)
    if (existing.length > 0) throw new ServiceError(409, 'already_friends')

    await tx.insert(friendships).values({ ...pair, inviteId: invite.id })
    await tx
      .update(friendInvites)
      .set({ useCount: sql`${friendInvites.useCount} + 1` })
      .where(eq(friendInvites.id, invite.id))

    const [inviterAccount] = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.accountId, invite.inviterAccountId))
    const [accepterAccount] = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.accountId, accepterId))
    if (!inviterAccount || !accepterAccount) throw new ServiceError(500, 'internal')

    return {
      inviter: {
        accountId: inviterAccount.accountId,
        displayName: inviterAccount.displayName,
      },
      accepter: {
        accountId: accepterAccount.accountId,
        displayName: accepterAccount.displayName,
      },
    }
  })
}

export async function listFriends(db: Db, accountId: string) {
  const rows = await db
    .select({
      accountA: friendships.accountA,
      accountB: friendships.accountB,
      createdAt: friendships.createdAt,
      displayNameA: sql<string>`a.display_name`,
      displayNameB: sql<string>`b.display_name`,
    })
    .from(friendships)
    .innerJoin(sql`${accounts} as a`, sql`a.account_id = ${friendships.accountA}`)
    .innerJoin(sql`${accounts} as b`, sql`b.account_id = ${friendships.accountB}`)
    .where(or(eq(friendships.accountA, accountId), eq(friendships.accountB, accountId)))
    .orderBy(friendships.createdAt)

  return rows.map((r) => {
    const isA = r.accountA === accountId
    return {
      accountId: isA ? r.accountB : r.accountA,
      displayName: isA ? r.displayNameB : r.displayNameA,
      since: r.createdAt.getTime(),
    }
  })
}

/** Returns true if a friendship existed and was removed. */
export async function removeFriend(db: Db, accountId: string, otherId: string): Promise<boolean> {
  const pair = pairOf(accountId, otherId)
  const deleted = await db
    .delete(friendships)
    .where(and(eq(friendships.accountA, pair.accountA), eq(friendships.accountB, pair.accountB)))
    .returning({ a: friendships.accountA })
  return deleted.length > 0
}

/**
 * Time-limited block: severs any existing friendship AND suppresses the blocked
 * account's invites until `expiresAt` (no permanent block by design — a season of
 * space, then the door reopens). Re-blocking refreshes the expiry. Returns true if a
 * friendship was removed. `unblockAccount` lifts it early (grace).
 */
export async function blockAccount(
  db: Db,
  blockerId: string,
  blockedId: string,
  expiresAt: Date,
): Promise<boolean> {
  if (blockerId === blockedId) throw new ServiceError(400, 'self_block')
  const target = await db.query.accounts.findFirst({ where: eq(accounts.accountId, blockedId) })
  if (!target) throw new ServiceError(404, 'account_not_found')
  await db
    .insert(blocks)
    .values({ blockerAccountId: blockerId, blockedAccountId: blockedId, expiresAt })
    .onConflictDoUpdate({
      target: [blocks.blockerAccountId, blocks.blockedAccountId],
      set: { expiresAt },
    })
  return removeFriend(db, blockerId, blockedId)
}

export async function unblockAccount(db: Db, blockerId: string, blockedId: string): Promise<void> {
  await db
    .delete(blocks)
    .where(and(eq(blocks.blockerAccountId, blockerId), eq(blocks.blockedAccountId, blockedId)))
}

/** The caller's ACTIVE (unexpired) blocks — the "taking space from" list. */
export async function listBlocks(db: Db, blockerId: string) {
  const rows = await db
    .select({
      accountId: blocks.blockedAccountId,
      displayName: accounts.displayName,
      expiresAt: blocks.expiresAt,
    })
    .from(blocks)
    .innerJoin(accounts, eq(accounts.accountId, blocks.blockedAccountId))
    .where(and(eq(blocks.blockerAccountId, blockerId), gt(blocks.expiresAt, new Date())))
    .orderBy(blocks.expiresAt)
  return rows.map((r) => ({
    accountId: r.accountId,
    displayName: r.displayName,
    expiresAt: r.expiresAt.getTime(),
  }))
}

/** Only ACTIVE (unexpired) blocks count — an expired block no longer restricts. */
export async function isBlockedEitherWay(db: Db, a: string, b: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(blocks)
    .where(
      and(
        gt(blocks.expiresAt, new Date()),
        or(
          and(eq(blocks.blockerAccountId, a), eq(blocks.blockedAccountId, b)),
          and(eq(blocks.blockerAccountId, b), eq(blocks.blockedAccountId, a)),
        ),
      ),
    )
    .limit(1)
  return rows.length > 0
}

export async function friendAccountIds(db: Db, accountId: string): Promise<string[]> {
  const rows = await db
    .select({ accountA: friendships.accountA, accountB: friendships.accountB })
    .from(friendships)
    .where(or(eq(friendships.accountA, accountId), eq(friendships.accountB, accountId)))
  return rows.map((r) => (r.accountA === accountId ? r.accountB : r.accountA))
}

/* ------------------- connect requests (directed, in-community) ------------------ */

/** Whether A and B are both active members of at least one common community — the gate
 *  for a directed connect request (so seeing an accountId can't friend a stranger). */
async function shareActiveCommunity(db: Db, a: string, b: string): Promise<boolean> {
  const aRows = await db
    .select({ communityId: communityMembers.communityId })
    .from(communityMembers)
    .where(and(eq(communityMembers.accountId, a), eq(communityMembers.status, 'active')))
  if (aRows.length === 0) return false
  const shared = new Set(aRows.map((r) => r.communityId))
  const bRows = await db
    .select({ communityId: communityMembers.communityId })
    .from(communityMembers)
    .where(and(eq(communityMembers.accountId, b), eq(communityMembers.status, 'active')))
  return bRows.some((r) => shared.has(r.communityId))
}

async function areFriends(db: Db, a: string, b: string): Promise<boolean> {
  const pair = pairOf(a, b)
  const rows = await db
    .select({ a: friendships.accountA })
    .from(friendships)
    .where(and(eq(friendships.accountA, pair.accountA), eq(friendships.accountB, pair.accountB)))
    .limit(1)
  return rows.length > 0
}

/** The target's active, receipt-keyed devices — the envelopes a connect intro is sealed
 *  to. Gated: caller shares a community with the target, not blocked, not already friends.
 *  A directed lookup of one account's devices — never a browsable roster. */
export async function listConnectRecipients(
  db: Db,
  callerAccountId: string,
  targetAccountId: string,
): Promise<ConnectRecipientsResponse> {
  if (callerAccountId === targetAccountId) throw new ServiceError(400, 'self_connect')
  if (await isBlockedEitherWay(db, callerAccountId, targetAccountId)) {
    throw new ServiceError(404, 'not_connectable') // do not leak blocks
  }
  if (!(await shareActiveCommunity(db, callerAccountId, targetAccountId))) {
    throw new ServiceError(404, 'not_connectable')
  }
  if (await areFriends(db, callerAccountId, targetAccountId)) {
    throw new ServiceError(409, 'already_friends')
  }
  const rows = await db
    .select({
      accountId: devices.accountId,
      deviceId: devices.deviceId,
      cert: devices.cert,
      certSig: devices.certSig,
      receiptPk: devices.receiptPk,
      receiptPkSig: devices.receiptPkSig,
    })
    .from(devices)
    .where(and(eq(devices.accountId, targetAccountId), eq(devices.status, 'active')))
  return {
    devices: rows
      .filter((r) => r.receiptPk !== null)
      .map((r) => ({
        accountId: r.accountId as ConnectRecipientsResponse['devices'][number]['accountId'],
        deviceId: r.deviceId as ConnectRecipientsResponse['devices'][number]['deviceId'],
        deviceCert: r.cert.toString('base64'),
        certSig: r.certSig.toString('base64'),
        receiptPk: r.receiptPk ? r.receiptPk.toString('base64') : null,
        receiptPkSig: r.receiptPkSig ? r.receiptPkSig.toString('base64') : null,
      })),
  }
}

/** Create a pending connect request with a sealed intro. Returns the target for WS notify. */
export async function createConnectRequest(
  db: Db,
  fromAccountId: string,
  input: PostConnectRequest,
): Promise<{ toAccountId: string }> {
  if (fromAccountId === input.toAccountId) throw new ServiceError(400, 'self_connect')
  // The signing device must belong to the requester.
  const dev = await db.query.devices.findFirst({
    where: and(
      eq(devices.deviceId, input.requesterDeviceId),
      eq(devices.accountId, fromAccountId),
      eq(devices.status, 'active'),
    ),
  })
  if (!dev) throw new ServiceError(403, 'not_own_device')
  if (await isBlockedEitherWay(db, fromAccountId, input.toAccountId)) {
    throw new ServiceError(404, 'not_connectable')
  }
  if (!(await shareActiveCommunity(db, fromAccountId, input.toAccountId))) {
    throw new ServiceError(404, 'not_connectable')
  }
  if (await areFriends(db, fromAccountId, input.toAccountId)) {
    throw new ServiceError(409, 'already_friends')
  }
  // One pending request per pair, either direction (if they already asked you, accept theirs).
  const existing = await db
    .select({ id: friendRequests.id })
    .from(friendRequests)
    .where(
      or(
        and(
          eq(friendRequests.fromAccountId, fromAccountId),
          eq(friendRequests.toAccountId, input.toAccountId),
        ),
        and(
          eq(friendRequests.fromAccountId, input.toAccountId),
          eq(friendRequests.toAccountId, fromAccountId),
        ),
      ),
    )
    .limit(1)
  if (existing.length > 0) throw new ServiceError(409, 'request_exists')

  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(friendRequests)
      .values({
        fromAccountId,
        toAccountId: input.toAccountId,
        requesterDeviceId: input.requesterDeviceId,
        requesterSig: bufOf(input.requesterSig),
      })
      .returning({ id: friendRequests.id })
    if (!row) throw new ServiceError(500, 'internal')
    await tx.insert(friendRequestRecipients).values(
      input.recipients.map((r) => ({
        requestId: row.id,
        recipientDeviceId: r.recipientDeviceId,
        sealed: bufOf(r.sealed),
        senderPkB64: r.senderPkB64,
      })),
    )
  })
  return { toAccountId: input.toAccountId }
}

/** The caller's pending connect requests: incoming (the envelope for THIS device) + outgoing. */
export async function listConnectRequests(
  db: Db,
  accountId: string,
  deviceId: string,
): Promise<ConnectRequestsResponse> {
  const incomingRows = await db
    .select({
      requestId: friendRequests.id,
      fromAccountId: friendRequests.fromAccountId,
      fromDisplayName: accounts.displayName,
      requesterDeviceId: friendRequests.requesterDeviceId,
      requesterDeviceCert: devices.cert,
      requesterCertSig: devices.certSig,
      requesterSig: friendRequests.requesterSig,
      sealed: friendRequestRecipients.sealed,
      senderPkB64: friendRequestRecipients.senderPkB64,
      createdAt: friendRequests.createdAt,
    })
    .from(friendRequests)
    .innerJoin(friendRequestRecipients, eq(friendRequestRecipients.requestId, friendRequests.id))
    .innerJoin(accounts, eq(accounts.accountId, friendRequests.fromAccountId))
    .innerJoin(devices, eq(devices.deviceId, friendRequests.requesterDeviceId))
    .where(
      and(
        eq(friendRequests.toAccountId, accountId),
        eq(friendRequestRecipients.recipientDeviceId, deviceId),
      ),
    )
    .orderBy(friendRequests.createdAt)

  const outgoingRows = await db
    .select({
      requestId: friendRequests.id,
      toAccountId: friendRequests.toAccountId,
      toDisplayName: accounts.displayName,
      createdAt: friendRequests.createdAt,
    })
    .from(friendRequests)
    .innerJoin(accounts, eq(accounts.accountId, friendRequests.toAccountId))
    .where(eq(friendRequests.fromAccountId, accountId))
    .orderBy(friendRequests.createdAt)

  return {
    incoming: incomingRows.map((r) => ({
      requestId: r.requestId,
      fromAccountId:
        r.fromAccountId as ConnectRequestsResponse['incoming'][number]['fromAccountId'],
      fromDisplayName: r.fromDisplayName,
      requesterDeviceId:
        r.requesterDeviceId as ConnectRequestsResponse['incoming'][number]['requesterDeviceId'],
      requesterDeviceCert: r.requesterDeviceCert.toString('base64'),
      requesterCertSig: r.requesterCertSig.toString('base64'),
      requesterSig: r.requesterSig.toString('base64'),
      sealed: r.sealed.toString('base64'),
      senderPkB64: r.senderPkB64,
      createdAt: r.createdAt.getTime(),
    })),
    outgoing: outgoingRows.map((r) => ({
      requestId: r.requestId,
      toAccountId: r.toAccountId as ConnectRequestsResponse['outgoing'][number]['toAccountId'],
      toDisplayName: r.toDisplayName,
      createdAt: r.createdAt.getTime(),
    })),
  }
}

/** Accept an incoming connect request → friendship (only the target may accept). Returns
 *  the two accounts so the route can fire friend.added + onFriendshipCreated. */
export async function acceptConnectRequest(
  db: Db,
  accountId: string,
  requestId: string,
): Promise<AcceptResult> {
  return db.transaction(async (tx) => {
    const [req] = await tx
      .select()
      .from(friendRequests)
      .where(and(eq(friendRequests.id, requestId), eq(friendRequests.toAccountId, accountId)))
      .for('update')
    if (!req) throw new ServiceError(404, 'request_not_found')
    // Re-check the gates at accept time (a block may have landed since).
    const blocked = await tx
      .select({ b: blocks.blockedAccountId })
      .from(blocks)
      .where(
        and(
          gt(blocks.expiresAt, new Date()),
          or(
            and(
              eq(blocks.blockerAccountId, req.fromAccountId),
              eq(blocks.blockedAccountId, accountId),
            ),
            and(
              eq(blocks.blockerAccountId, accountId),
              eq(blocks.blockedAccountId, req.fromAccountId),
            ),
          ),
        ),
      )
      .limit(1)
    if (blocked.length > 0) {
      await tx.delete(friendRequests).where(eq(friendRequests.id, requestId))
      throw new ServiceError(404, 'request_not_found')
    }
    const pair = pairOf(req.fromAccountId, accountId)
    await tx.insert(friendships).values(pair).onConflictDoNothing()
    await tx.delete(friendRequests).where(eq(friendRequests.id, requestId))

    const [fromAccount] = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.accountId, req.fromAccountId))
    const [toAccount] = await tx.select().from(accounts).where(eq(accounts.accountId, accountId))
    if (!fromAccount || !toAccount) throw new ServiceError(500, 'internal')
    return {
      inviter: { accountId: fromAccount.accountId, displayName: fromAccount.displayName },
      accepter: { accountId: toAccount.accountId, displayName: toAccount.displayName },
    }
  })
}

/** Decline an incoming request (silent — the sender is not told). Target-only. */
export async function declineConnectRequest(
  db: Db,
  accountId: string,
  requestId: string,
): Promise<void> {
  const deleted = await db
    .delete(friendRequests)
    .where(and(eq(friendRequests.id, requestId), eq(friendRequests.toAccountId, accountId)))
    .returning({ id: friendRequests.id })
  if (deleted.length === 0) throw new ServiceError(404, 'request_not_found')
}

/** Cancel an outgoing request. Sender-only. */
export async function cancelConnectRequest(
  db: Db,
  accountId: string,
  requestId: string,
): Promise<void> {
  const deleted = await db
    .delete(friendRequests)
    .where(and(eq(friendRequests.id, requestId), eq(friendRequests.fromAccountId, accountId)))
    .returning({ id: friendRequests.id })
  if (deleted.length === 0) throw new ServiceError(404, 'request_not_found')
}

interface InviteRow {
  id: string
  code: string
  maxUses: number
  useCount: number
  expiresAt: Date
  createdAt: Date
}

function toInviteDto(row: InviteRow) {
  return {
    id: row.id,
    code: row.code,
    maxUses: row.maxUses,
    useCount: row.useCount,
    expiresAt: row.expiresAt.getTime(),
    createdAt: row.createdAt.getTime(),
  }
}
