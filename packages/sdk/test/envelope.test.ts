import { describe, expect, it } from 'vitest'
import { decodeEnvelope, encodeChat, encodeIntent, intentPayload } from '../src/rooms/envelope.ts'

const roundTrip = (bytes: Uint8Array) => decodeEnvelope(bytes)

describe('room message envelope', () => {
  it('encodes and decodes a structured intent', () => {
    const env = roundTrip(encodeIntent({ op: 'inc', by: 2 }))
    expect(env).not.toBeNull()
    if (env?.c !== 'intent') throw new Error('expected intent')
    expect(intentPayload(env)).toEqual({ op: 'inc', by: 2 })
  })

  it('encodes and decodes a binary intent', () => {
    const bytes = new Uint8Array([1, 2, 3, 250])
    const env = roundTrip(encodeIntent(bytes))
    if (env?.c !== 'intent') throw new Error('expected intent')
    const payload = intentPayload(env)
    expect(payload).toBeInstanceOf(Uint8Array)
    expect([...(payload as Uint8Array)]).toEqual([1, 2, 3, 250])
  })

  it('encodes and decodes chat text distinctly from intents', () => {
    const env = roundTrip(encodeChat('Grace and peace'))
    expect(env).toEqual({ c: 'chat', d: 'Grace and peace' })
  })

  it('rejects malformed or foreign payloads as null', () => {
    expect(decodeEnvelope(new TextEncoder().encode('not json'))).toBeNull()
    expect(decodeEnvelope(new TextEncoder().encode('{"c":"other"}'))).toBeNull()
    expect(decodeEnvelope(new TextEncoder().encode('{"c":"chat"}'))).toBeNull()
    expect(decodeEnvelope(new TextEncoder().encode('42'))).toBeNull()
  })
})
