import { describe, expect, it } from 'vitest'
import { openBlob, sealBlob } from '../src/storage-crypto.ts'

const key = () => crypto.getRandomValues(new Uint8Array(32))
const bytes = (s: string) => new TextEncoder().encode(s)

describe('storage blob sealing', () => {
  it('round-trips under the correct key/app/storage-key', async () => {
    const k = key()
    const sealed = await sealBlob(k, 'pub_app1', 'save', bytes('hello'))
    const opened = await openBlob(k, 'pub_app1', 'save', sealed)
    expect(new TextDecoder().decode(opened)).toBe('hello')
  })

  it('fails with the wrong key', async () => {
    const sealed = await sealBlob(key(), 'pub_app1', 'save', bytes('x'))
    await expect(openBlob(key(), 'pub_app1', 'save', sealed)).rejects.toThrow()
  })

  it('AAD binds the blob to its appId — cross-app open fails', async () => {
    const k = key()
    const sealed = await sealBlob(k, 'pub_app1', 'save', bytes('x'))
    await expect(openBlob(k, 'pub_app2', 'save', sealed)).rejects.toThrow()
  })

  it('AAD binds the blob to its storage key — swapped key open fails', async () => {
    const k = key()
    const sealed = await sealBlob(k, 'pub_app1', 'slotA', bytes('x'))
    await expect(openBlob(k, 'pub_app1', 'slotB', sealed)).rejects.toThrow()
  })

  it('rejects an unknown envelope version', async () => {
    const k = key()
    const sealed = await sealBlob(k, 'pub_app1', 'save', bytes('x'))
    sealed[0] = 0x99
    await expect(openBlob(k, 'pub_app1', 'save', sealed)).rejects.toThrow()
  })
})
