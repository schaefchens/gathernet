import { describe, expect, it } from 'vitest'
import type { StoredMessage } from './storage.ts'
import { buildThreadIndex } from './thread-index.ts'

let seq = 0
function msg(id: string | undefined, replyTo?: string): StoredMessage {
  seq++
  return {
    groupId: 'ch',
    seq,
    ...(id ? { id } : {}),
    senderAccountId: 'ac',
    text: id ?? `m${seq}`,
    sentAt: seq,
    outgoing: false,
    ...(replyTo ? { replyTo } : {}),
  }
}

describe('buildThreadIndex', () => {
  it('keeps non-replies at the top level, nests replies', () => {
    // a (root) ← b ← c (nested), and a ← d (sibling); plus standalone e
    const a = msg('a')
    const b = msg('b', 'a')
    const c = msg('c', 'b')
    const d = msg('d', 'a')
    const e = msg('e')
    const idx = buildThreadIndex([a, b, c, d, e])

    expect(idx.topLevel.map((m) => m.id)).toEqual(['a', 'e'])
    expect(idx.childrenByParent.get('a')?.map((m) => m.id)).toEqual(['b', 'd'])
    expect(idx.childrenByParent.get('b')?.map((m) => m.id)).toEqual(['c'])
  })

  it('counts all transitive descendants (the N-replies number)', () => {
    const a = msg('a')
    const b = msg('b', 'a')
    const c = msg('c', 'b')
    const d = msg('d', 'a')
    const idx = buildThreadIndex([a, b, c, d])
    // a has b, c, d beneath it → 3; b has c → 1; leaves → 0
    expect(idx.descendantCount.get('a')).toBe(3)
    expect(idx.descendantCount.get('b')).toBe(1)
    expect(idx.descendantCount.get('c')).toBe(0)
    expect(idx.descendantCount.get('d')).toBe(0)
  })

  it('resolves rootId up the chain', () => {
    const a = msg('a')
    const b = msg('b', 'a')
    const c = msg('c', 'b')
    const idx = buildThreadIndex([a, b, c])
    expect(idx.rootId.get('a')).toBe('a')
    expect(idx.rootId.get('b')).toBe('a')
    expect(idx.rootId.get('c')).toBe('a')
  })

  it('treats a reply with a missing parent as a detached top-level root', () => {
    // parent "x" is not in the list (expired / not synced)
    const orphan = msg('o', 'x')
    const child = msg('c', 'o')
    const idx = buildThreadIndex([orphan, child])
    expect(idx.topLevel.map((m) => m.id)).toEqual(['o'])
    expect(idx.detached.has('o')).toBe(true)
    expect(idx.childrenByParent.get('o')?.map((m) => m.id)).toEqual(['c'])
    expect(idx.rootId.get('c')).toBe('o') // root is the detached message, not the missing "x"
    expect(idx.descendantCount.get('o')).toBe(1)
  })

  it('ignores messages without an id (legacy) as parents/children', () => {
    const legacy = msg(undefined)
    const a = msg('a')
    const idx = buildThreadIndex([legacy, a])
    expect(idx.topLevel).toHaveLength(2) // both shown at top level
    expect(idx.descendantCount.get('a')).toBe(0)
  })

  it('does not loop on a self/cyclic replyTo', () => {
    const a = msg('a', 'a') // pathological self-reply
    const idx = buildThreadIndex([a])
    // parent "a" IS present (itself) → treated as a child of itself; must terminate.
    expect(idx.descendantCount.get('a')).toBeTypeOf('number')
    expect(idx.rootId.get('a')).toBe('a')
  })
})
