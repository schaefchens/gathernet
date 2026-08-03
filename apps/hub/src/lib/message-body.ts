/**
 * The versioned, typed message BODY — the end-to-end-encrypted plaintext of a chat
 * message. This is what goes INSIDE an MLS application message or a group_key sealed
 * envelope, so the server never sees any of it. All rich-message features (reply,
 * reactions, edit, delete, media, voice) are expressed here rather than as new server
 * state, keeping the server ciphertext-only.
 *
 * Wire form: `JSON.stringify(body)` → UTF-8 bytes → sealed by the transport.
 *
 * Back-compat: pre-v2 messages were the bare `{ t, ts }` text shape; `parseBody`
 * still reads them (as text). Every NEW message carries `v:2`, a client-generated
 * stable `id` (the target for reactions/edits/deletes), and a `kind`.
 */

export interface MediaRef {
  /** opaque server blob id holding the CIPHERTEXT only */
  mediaId: string
  /** base64 per-file symmetric key — lives ONLY in this (encrypted) body, never server-side */
  key: string
  mime: string
  size: number
  width?: number
  height?: number
  durationMs?: number
  name?: string
}

interface Base {
  v: 2
  /** client-generated message id — stable across devices; the target of reactions/edits/deletes */
  id: string
  ts: number
  /** optional: the id of the message this one replies to */
  replyTo?: string
}

export type MessageBody =
  | (Base & { kind: 'text'; text: string })
  | (Base & { kind: 'media'; media: MediaRef; text?: string })
  | (Base & { kind: 'voice'; media: MediaRef; durationMs: number })
  | (Base & { kind: 'reaction'; targetId: string; emoji: string; remove?: boolean })
  | (Base & { kind: 'edit'; targetId: string; text: string })
  | (Base & { kind: 'delete'; targetId: string })

/** The kinds that produce a DISPLAYED message (vs a control op on an existing one). */
export type DisplayKind = 'text' | 'media' | 'voice'
export function isDisplayKind(kind: MessageBody['kind']): kind is DisplayKind {
  return kind === 'text' || kind === 'media' || kind === 'voice'
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function newMessageId(): string {
  return crypto.randomUUID()
}

export function encodeBody(body: MessageBody): Uint8Array {
  return encoder.encode(JSON.stringify(body))
}

/** Build a plain text (optionally reply) message body. */
export function textBody(text: string, replyTo?: string): MessageBody {
  return {
    v: 2,
    id: newMessageId(),
    ts: Date.now(),
    kind: 'text',
    text,
    ...(replyTo ? { replyTo } : {}),
  }
}

/** Build a reaction control message targeting `targetId`. */
export function reactionBody(targetId: string, emoji: string, remove: boolean): MessageBody {
  return { v: 2, id: newMessageId(), ts: Date.now(), kind: 'reaction', targetId, emoji, remove }
}

/**
 * Parse a decrypted plaintext into a MessageBody, tolerating the legacy `{ t, ts }`
 * text shape. Returns null on garbage (caller drops it).
 */
export function parseBody(plaintext: Uint8Array | undefined): MessageBody | null {
  if (!plaintext) return null
  try {
    const o = JSON.parse(decoder.decode(plaintext)) as Record<string, unknown>
    if (o && o.v === 2 && typeof o.kind === 'string' && typeof o.id === 'string') {
      return o as unknown as MessageBody
    }
    // Legacy v1: bare { t, ts } → treat as text with a derived stable id.
    if (o && typeof o.t === 'string') {
      const ts = typeof o.ts === 'number' ? o.ts : Date.now()
      return { v: 2, id: `legacy:${ts}`, ts, kind: 'text', text: o.t }
    }
    return null
  } catch {
    return null
  }
}
