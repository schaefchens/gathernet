/**
 * Every room MLS application message carries a tiny JSON envelope so a single
 * ordered stream can multiplex app "intents" and human "chat":
 *
 *   { c: 'intent', d: <json value> }   // structured intent payload
 *   { c: 'intent', b: <base64> }       // binary intent payload
 *   { c: 'chat',   d: <string> }       // chat text
 *
 * `send()` uses the 'intent' channel; `chat.send()` uses the 'chat' channel.
 */

import { b64, fromB64 } from '../internal.ts'

export type IntentEnvelope = { c: 'intent'; d?: unknown; b?: string }
export type ChatEnvelope = { c: 'chat'; d: string }
export type Envelope = IntentEnvelope | ChatEnvelope

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeIntent(payload: unknown): Uint8Array {
  const env: IntentEnvelope =
    payload instanceof Uint8Array ? { c: 'intent', b: b64(payload) } : { c: 'intent', d: payload }
  return encoder.encode(JSON.stringify(env))
}

export function encodeChat(text: string): Uint8Array {
  const env: ChatEnvelope = { c: 'chat', d: text }
  return encoder.encode(JSON.stringify(env))
}

/** Parse a decrypted plaintext into an envelope; null when malformed. */
export function decodeEnvelope(plaintext: Uint8Array): Envelope | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(decoder.decode(plaintext))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (obj.c === 'chat' && typeof obj.d === 'string') return { c: 'chat', d: obj.d }
  if (obj.c === 'intent') {
    if (typeof obj.b === 'string') return { c: 'intent', b: obj.b }
    return { c: 'intent', d: obj.d }
  }
  return null
}

/** Resolve an intent envelope's payload back to the value the sender passed. */
export function intentPayload(env: IntentEnvelope): unknown {
  return env.b !== undefined ? fromB64(env.b) : env.d
}
