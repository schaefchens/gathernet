import { describe, expect, it } from 'vitest'
import { inviteCodeSchema, parseClientMessage, parseServerMessage, ulid } from '../src/index.ts'

describe('parseClientMessage', () => {
  it('accepts a valid hello', () => {
    const raw = JSON.stringify({
      type: 'hello',
      id: ulid(),
      payload: { token: 'tok_abc', protocolVersion: 1 },
    })
    const result = parseClientMessage(raw)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.message.type).toBe('hello')
    }
  })

  it('rejects unknown message types', () => {
    const raw = JSON.stringify({ type: 'nope', id: 'x', payload: {} })
    const result = parseClientMessage(raw)
    expect(result).toMatchObject({ ok: false, error: 'invalid_message' })
  })

  it('rejects invalid JSON and non-strings', () => {
    expect(parseClientMessage('{oops')).toMatchObject({ ok: false, error: 'invalid_json' })
    expect(parseClientMessage(Buffer.from([1, 2]))).toMatchObject({
      ok: false,
      error: 'invalid_json',
    })
  })

  it('rejects hello without a token', () => {
    const raw = JSON.stringify({ type: 'hello', id: 'x', payload: { protocolVersion: 1 } })
    expect(parseClientMessage(raw).ok).toBe(false)
  })

  it('validates chat.send groupId shape', () => {
    const good = JSON.stringify({
      type: 'chat.send',
      id: ulid(),
      payload: { groupId: 'a'.repeat(32), epoch: 0, ciphertext: 'AAAA' },
    })
    expect(parseClientMessage(good).ok).toBe(true)
    const bad = JSON.stringify({
      type: 'chat.send',
      id: ulid(),
      payload: { groupId: 'not-hex!', epoch: 0, ciphertext: 'AAAA' },
    })
    expect(parseClientMessage(bad).ok).toBe(false)
  })
})

describe('parseServerMessage', () => {
  it('accepts ack and error', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'ack', replyTo: 'x', payload: {} })).ok).toBe(
      true,
    )
    expect(
      parseServerMessage(JSON.stringify({ type: 'error', payload: { code: 'unknown_type' } })).ok,
    ).toBe(true)
  })
})

describe('ulid', () => {
  it('is 26 chars, sortable by time', () => {
    const a = ulid(1000)
    const b = ulid(2000)
    expect(a).toHaveLength(26)
    expect(b > a).toBe(true)
  })
})

describe('inviteCodeSchema', () => {
  it('normalizes ambiguous characters', () => {
    const parsed = inviteCodeSchema.parse('abcdefgh1o')
    expect(parsed).toBe('ABCDEFGH10')
  })
})
