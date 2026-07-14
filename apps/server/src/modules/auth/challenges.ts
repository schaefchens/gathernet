import { and, eq, gt, lt } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { authChallenges } from '../../db/schema.ts'
import { newChallenge } from '../../lib/crypto.ts'

export const CHALLENGE_TTL_MS = 2 * 60 * 1000

export async function issueChallenge(
  db: Db,
  purpose: 'enroll' | 'login',
): Promise<{ challenge: Buffer; expiresAt: Date }> {
  const challenge = newChallenge()
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS)
  await db.insert(authChallenges).values({ challenge, purpose, expiresAt })
  return { challenge, expiresAt }
}

/** Single-use: the row is deleted on consumption; expired rows never match. */
export async function consumeChallenge(
  db: Db,
  challenge: Buffer,
  purpose: 'enroll' | 'login',
): Promise<boolean> {
  const deleted = await db
    .delete(authChallenges)
    .where(
      and(
        eq(authChallenges.challenge, challenge),
        eq(authChallenges.purpose, purpose),
        gt(authChallenges.expiresAt, new Date()),
      ),
    )
    .returning({ challenge: authChallenges.challenge })
  return deleted.length === 1
}

/** Housekeeping — callable from a periodic job. */
export async function pruneExpiredChallenges(db: Db): Promise<void> {
  await db.delete(authChallenges).where(lt(authChallenges.expiresAt, new Date()))
}
