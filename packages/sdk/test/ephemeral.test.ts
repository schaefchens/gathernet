import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import * as mls from '@gathernet/mls-client'
import { beforeAll, describe, expect, it } from 'vitest'
import { openEphemeral, sealEphemeral } from '../src/rooms/ephemeral.ts'
import type { MlsDevice } from '../src/rooms/mls.ts'

/**
 * Ephemeral E2EE uses the MLS exporter secret as a per-epoch key, then
 * XChaCha20-Poly1305 seal/open. We stub the device's exportSecret with a
 * deterministic key per (epoch) so the framing — seal/open, epoch binding,
 * groupId AAD binding — is validated without standing up a full MLS group.
 */

function stubDevice(keyByte: number): MlsDevice {
  return {
    // Distinct key material per epoch (last context byte drives the value).
    exportSecret: (_g: Uint8Array, _l: string, context: Uint8Array, len: number) => {
      const k = new Uint8Array(len)
      k.fill((keyByte + (context.at(-1) ?? 0)) & 0xff)
      return k
    },
  } as unknown as MlsDevice
}

const wasmPath = fileURLToPath(new URL('../../mls-client/wasm/mls_wasm_bg.wasm', import.meta.url))
const groupId = new Uint8Array(16).fill(7)
const groupHex = 'aa'.repeat(16)

beforeAll(async () => {
  await mls.initMls({ wasmBytes: await readFile(wasmPath) })
})

describe('ephemeral seal/open', () => {
  it('round-trips between members sharing the epoch key', () => {
    const alice = stubDevice(1)
    const bob = stubDevice(1) // same exporter secret ⇒ same key at epoch N
    const payload = new TextEncoder().encode('cursor:42,17')
    const sealed = sealEphemeral(mls, alice, groupId, groupHex, 3, payload)
    const opened = openEphemeral(mls, bob, groupId, groupHex, 3, sealed)
    expect(new TextDecoder().decode(opened)).toBe('cursor:42,17')
  })

  it('fails to open at a different epoch (key rotates with the ratchet)', () => {
    const dev = stubDevice(1)
    const sealed = sealEphemeral(mls, dev, groupId, groupHex, 3, new Uint8Array([9]))
    expect(() => openEphemeral(mls, dev, groupId, groupHex, 4, sealed)).toThrow()
  })

  it('AAD binds the ciphertext to its group — cross-room open fails', () => {
    const dev = stubDevice(1)
    const sealed = sealEphemeral(mls, dev, groupId, groupHex, 3, new Uint8Array([9]))
    expect(() => openEphemeral(mls, dev, groupId, 'bb'.repeat(16), 3, sealed)).toThrow()
  })

  it('a non-member (different exporter secret) cannot open', () => {
    const member = stubDevice(1)
    const outsider = stubDevice(200)
    const sealed = sealEphemeral(mls, member, groupId, groupHex, 3, new Uint8Array([9]))
    expect(() => openEphemeral(mls, outsider, groupId, groupHex, 3, sealed)).toThrow()
  })
})
