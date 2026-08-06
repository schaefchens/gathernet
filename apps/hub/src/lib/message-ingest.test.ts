import { describe, expect, it } from 'vitest'
import { applyConsume, consumeLocally } from './message-ingest.ts'
import type { StoredMessage } from './storage.ts'

/** A minimal view-once display message from `sender` to seed a list. */
function onceMsg(id: string, sender: string, outgoing: boolean): StoredMessage {
  return {
    groupId: 'g1',
    seq: 1,
    id,
    senderAccountId: sender,
    kind: 'text',
    text: 'secret',
    once: true,
    sentAt: 1000,
    outgoing,
  }
}

const ALICE = 'alice'
const BOB = 'bob'
const MALLORY = 'mallory'

describe('view-once consume (anti-grief)', () => {
  it('destroys the message when the recipient (I am the author) consumes it', () => {
    // Alice authored the message; Bob (the recipient) sends the consume. On Alice's
    // device (myAccountId = alice, iAmAuthor) the copy collapses to a tombstone.
    const list = [onceMsg('m1', ALICE, true)]
    const res = applyConsume(list, 'm1', BOB, ALICE)
    expect(res).not.toBeNull()
    expect(res?.changed.viewOnceOpened).toBe(true)
    expect(res?.changed.text).toBe('')
    expect(res?.target.text).toBe('secret') // pre-clear copy returned for blob cleanup
  })

  it('destroys my own copy when a consume comes from my other device', () => {
    // I (Bob) received the message; my other device opened + broadcast the consume.
    const list = [onceMsg('m1', ALICE, false)]
    const res = applyConsume(list, 'm1', BOB, BOB)
    expect(res).not.toBeNull()
    expect(res?.changed.viewOnceOpened).toBe(true)
  })

  it('IGNORES a consume from an unrelated member (cannot destroy others’ copies)', () => {
    // Bob received Alice's message. Mallory (neither author nor Bob) forges a consume.
    const list = [onceMsg('m1', ALICE, false)]
    const res = applyConsume(list, 'm1', MALLORY, BOB)
    expect(res).toBeNull()
  })

  it('is idempotent — a second consume on an already-opened message is a no-op', () => {
    const list = [{ ...onceMsg('m1', ALICE, true), viewOnceOpened: true, text: '' }]
    const res = applyConsume(list, 'm1', BOB, ALICE)
    expect(res).toBeNull()
  })

  it('returns null when the target is unknown', () => {
    expect(applyConsume([], 'missing', BOB, ALICE)).toBeNull()
  })

  it('consumeLocally destroys the viewer’s copy immediately on open', () => {
    const list = [onceMsg('m1', ALICE, false)]
    const res = consumeLocally(list, 'm1')
    expect(res?.changed.viewOnceOpened).toBe(true)
    expect(res?.changed.text).toBe('')
    expect(res?.target.text).toBe('secret')
  })
})
