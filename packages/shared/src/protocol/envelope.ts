import { type ClientMessage, clientMessageSchema } from './client-messages.ts'
import { type ServerMessage, serverMessageSchema } from './server-messages.ts'

export type ParseResult<T> =
  | { ok: true; message: T }
  | { ok: false; error: 'invalid_json' | 'invalid_message'; detail?: string }

function parse<T>(
  raw: unknown,
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: unknown } },
): ParseResult<T> {
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_json' }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'invalid_json' }
  }
  const result = schema.safeParse(json)
  if (!result.success) {
    return { ok: false, error: 'invalid_message', detail: String(result.error) }
  }
  return { ok: true, message: result.data as T }
}

/** Server side: parse an incoming client frame. */
export function parseClientMessage(raw: unknown): ParseResult<ClientMessage> {
  return parse(raw, clientMessageSchema)
}

/** Client side: parse an incoming server frame. */
export function parseServerMessage(raw: unknown): ParseResult<ServerMessage> {
  return parse(raw, serverMessageSchema)
}
