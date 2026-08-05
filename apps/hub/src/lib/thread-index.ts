/**
 * Client-side thread index over a channel's messages. A reply carries `replyTo` = its
 * parent message's client `id` (sealed in the body; the server never sees the structure),
 * so the whole thread tree is derived here. Handles the E2EE realities: a message may have
 * no `id` (legacy, can't be a parent/child) and a reply's parent may be absent locally
 * (expired TTL or not-yet-synced) — such a reply is treated as a DETACHED root so it's
 * never dropped from view.
 *
 * Pure + synchronous so it's trivially testable and cheap to memoize per render.
 */

import type { StoredMessage } from './storage.ts'

export interface ThreadIndex {
  /** Messages shown at the top level of the channel: non-replies, plus replies whose
   *  parent isn't present locally (detached). Chronological (input order preserved). */
  topLevel: StoredMessage[]
  /** parent message id → its direct replies, chronological. */
  childrenByParent: Map<string, StoredMessage[]>
  /** message id → total number of transitive descendants (the "N replies" count). */
  descendantCount: Map<string, number>
  /** message id → the id of its thread root (top of the reply chain, or itself). A
   *  detached reply is its own root. */
  rootId: Map<string, string>
  /** true when a message has `replyTo` set but its parent is not present locally. */
  detached: Set<string>
}

/** Build the thread index for a channel's message list (input order = chronological). */
export function buildThreadIndex(messages: StoredMessage[]): ThreadIndex {
  const byId = new Map<string, StoredMessage>()
  for (const m of messages) if (m.id) byId.set(m.id, m)

  const childrenByParent = new Map<string, StoredMessage[]>()
  const detached = new Set<string>()
  const topLevel: StoredMessage[] = []

  for (const m of messages) {
    const parentPresent = m.replyTo !== undefined && byId.has(m.replyTo)
    if (m.replyTo !== undefined && parentPresent) {
      const siblings = childrenByParent.get(m.replyTo)
      if (siblings) siblings.push(m)
      else childrenByParent.set(m.replyTo, [m])
    } else {
      // A non-reply, or a reply whose parent is missing → a (possibly detached) root.
      if (m.replyTo !== undefined && m.id) detached.add(m.id)
      topLevel.push(m)
    }
  }

  // rootId: walk `replyTo` up to the first message with no present parent. Guarded against
  // cycles by a bounded walk (reply chains are acyclic in practice: a parent must exist
  // before it can be replied to).
  const rootId = new Map<string, string>()
  const rootOf = (m: StoredMessage): string => {
    if (!m.id) return '' // no identity → can't be threaded
    const cached = rootId.get(m.id)
    if (cached) return cached
    let cur = m
    let depth = 0
    while (cur.replyTo !== undefined && byId.has(cur.replyTo) && depth < messages.length + 1) {
      const parent = byId.get(cur.replyTo)
      if (!parent?.id) break
      cur = parent
      depth++
    }
    const root = cur.id ?? m.id
    rootId.set(m.id, root)
    return root
  }
  for (const m of messages) if (m.id) rootOf(m)

  // descendantCount: post-order over the children map (each message counts all transitive
  // replies beneath it). Memoized to keep it linear.
  const descendantCount = new Map<string, number>()
  const countOf = (id: string, seen: Set<string>): number => {
    const cached = descendantCount.get(id)
    if (cached !== undefined) return cached
    if (seen.has(id)) return 0 // cycle guard
    seen.add(id)
    let total = 0
    for (const child of childrenByParent.get(id) ?? []) {
      if (child.id) total += 1 + countOf(child.id, seen)
    }
    descendantCount.set(id, total)
    return total
  }
  for (const m of messages) if (m.id) countOf(m.id, new Set())

  return { topLevel, childrenByParent, descendantCount, rootId, detached }
}
