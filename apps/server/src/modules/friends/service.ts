import { randomBytes } from 'node:crypto'
import { CROCKFORD_ALPHABET, INVITE_CODE_LENGTH } from '@gathernet/shared'
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { accounts, blocks, friendInvites, friendships } from '../../db/schema.ts'
import { ServiceError } from '../accounts/service.ts'

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
