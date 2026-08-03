/**
 * Pure mapping between the decrypted {@link MessageBody} and the persisted/rendered
 * {@link StoredMessage}, shared by the DM store and the community store so all three
 * transports (DM-MLS, channel-MLS, group_key) handle rich messages identically.
 * No I/O — the caller owns persistence + UI state.
 */

import type { MessageBody } from './message-body.ts'
import { isDisplayKind } from './message-body.ts'
import { messageStore, type StoredMessage } from './storage.ts'

/**
 * Turn a DISPLAY-kind body (text/media/voice) into a StoredMessage. Returns null for
 * control kinds (reaction/edit/delete) — the caller applies those to existing messages.
 */
export function bodyToStored(
  groupId: string,
  seq: number,
  senderAccountId: string,
  outgoing: boolean,
  body: MessageBody,
): StoredMessage | null {
  if (!isDisplayKind(body.kind)) return null
  return {
    groupId,
    seq,
    id: body.id,
    senderAccountId,
    kind: body.kind,
    text: body.kind === 'text' ? body.text : body.kind === 'media' ? (body.text ?? '') : '',
    sentAt: body.ts,
    outgoing,
    ...(body.replyTo ? { replyTo: body.replyTo } : {}),
    ...(body.kind === 'media' || body.kind === 'voice' ? { media: body.media } : {}),
  }
}

/**
 * Apply a reaction to the target message in `list` (matched by its v2 `id`). Returns
 * the new list + the single changed message (for the caller to persist), or null if
 * the target isn't present (legacy/pruned/unknown — the reaction is dropped; ordered
 * delivery normally guarantees the message arrives before its reaction).
 */
export function applyReaction(
  list: StoredMessage[],
  targetId: string,
  emoji: string,
  actor: string,
  remove: boolean,
): { list: StoredMessage[]; changed: StoredMessage } | null {
  const idx = list.findIndex((m) => m.id === targetId)
  if (idx < 0) return null
  const msg = list[idx]
  if (!msg) return null
  const reactions: Record<string, string[]> = { ...(msg.reactions ?? {}) }
  const actors = new Set(reactions[emoji] ?? [])
  if (remove) actors.delete(actor)
  else actors.add(actor)
  if (actors.size === 0) delete reactions[emoji]
  else reactions[emoji] = [...actors]
  const changed: StoredMessage = { ...msg, reactions }
  const newList = [...list]
  newList[idx] = changed
  return { list: newList, changed }
}

/** Replace `idx` in `list` with `changed` (immutably) — small shared helper. */
function replaceAt(list: StoredMessage[], idx: number, changed: StoredMessage) {
  const newList = [...list]
  newList[idx] = changed
  return { list: newList, changed }
}

/**
 * Apply an edit to the target — ONLY if `actor` is the original author (the control
 * message's authenticated sender must match the target's sender) and it isn't already
 * deleted. Returns the new list + changed message, or null.
 */
export function applyEdit(
  list: StoredMessage[],
  targetId: string,
  text: string,
  ts: number,
  actor: string,
): { list: StoredMessage[]; changed: StoredMessage } | null {
  const idx = list.findIndex((m) => m.id === targetId)
  const msg = idx >= 0 ? list[idx] : undefined
  if (!msg || msg.senderAccountId !== actor || msg.deletedAt) return null
  return replaceAt(list, idx, { ...msg, text, editedAt: ts })
}

/**
 * Apply a delete-for-everyone tombstone — ONLY if `actor` is the original author. The
 * row is KEPT (a tombstone) but its content is cleared so the UI can render a
 * "deleted" placeholder while preserving ordering. Returns the new list + changed, or null.
 */
export function applyDelete(
  list: StoredMessage[],
  targetId: string,
  ts: number,
  actor: string,
): { list: StoredMessage[]; changed: StoredMessage } | null {
  const idx = list.findIndex((m) => m.id === targetId)
  const msg = idx >= 0 ? list[idx] : undefined
  if (!msg || msg.senderAccountId !== actor) return null
  const changed: StoredMessage = {
    groupId: msg.groupId,
    seq: msg.seq,
    ...(msg.id ? { id: msg.id } : {}),
    senderAccountId: msg.senderAccountId,
    kind: 'text',
    text: '',
    sentAt: msg.sentAt,
    outgoing: msg.outgoing,
    deletedAt: ts,
  }
  return replaceAt(list, idx, changed)
}

/**
 * Ingest one decrypted body into a message list (persist + UI), branching on kind:
 * a display message is stored + appended; a control message (reaction; edit/delete in
 * Slice 2) mutates an existing message. The store passes its own list get/set/append
 * so the DM + community + group_key paths share one implementation. Returns the
 * displayed message (if any) for callers that need it (e.g. senderSeq bookkeeping).
 */
export async function ingestBody(
  ctx: {
    groupId: string
    seq: number
    senderAccountId: string
    outgoing: boolean
    getList: () => StoredMessage[]
    setList: (list: StoredMessage[]) => void
    append: (m: StoredMessage) => void
  },
  body: MessageBody,
): Promise<StoredMessage | null> {
  if (isDisplayKind(body.kind)) {
    const stored = bodyToStored(ctx.groupId, ctx.seq, ctx.senderAccountId, ctx.outgoing, body)
    if (!stored) return null
    await messageStore.put(stored)
    ctx.append(stored)
    return stored
  }
  let res: { list: StoredMessage[]; changed: StoredMessage } | null = null
  if (body.kind === 'reaction') {
    res = applyReaction(
      ctx.getList(),
      body.targetId,
      body.emoji,
      ctx.senderAccountId,
      !!body.remove,
    )
  } else if (body.kind === 'edit') {
    res = applyEdit(ctx.getList(), body.targetId, body.text, body.ts, ctx.senderAccountId)
  } else if (body.kind === 'delete') {
    res = applyDelete(ctx.getList(), body.targetId, body.ts, ctx.senderAccountId)
  }
  if (res) {
    ctx.setList(res.list)
    await messageStore.put(res.changed)
  }
  return null
}
