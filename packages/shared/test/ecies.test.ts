import { describe, expect, it } from 'vitest'
import { eciesOpen, eciesSeal, generateEciesKeypair } from '../src/ecies.ts'

describe('ecies sealed box (grant key handoff)', () => {
  it('round-trips a 32-byte key', async () => {
    const recipient = await generateEciesKeypair()
    const key = crypto.getRandomValues(new Uint8Array(32))

    const { sealedB64, senderPkB64 } = await eciesSeal(recipient.publicKeyB64, key)
    const opened = await eciesOpen(
      recipient.privateKey,
      senderPkB64,
      sealedB64,
      recipient.publicKeyB64,
    )
    expect(Buffer.from(opened)).toEqual(Buffer.from(key))
  })

  it('fails to open with the wrong recipient key', async () => {
    const recipient = await generateEciesKeypair()
    const wrong = await generateEciesKeypair()
    const key = crypto.getRandomValues(new Uint8Array(32))
    const { sealedB64, senderPkB64 } = await eciesSeal(recipient.publicKeyB64, key)
    await expect(
      eciesOpen(wrong.privateKey, senderPkB64, sealedB64, wrong.publicKeyB64),
    ).rejects.toThrow()
  })

  it('rejects an AAD (recipient-key) mismatch — thwarts a relayed key swap', async () => {
    const recipient = await generateEciesKeypair()
    const other = await generateEciesKeypair()
    const key = crypto.getRandomValues(new Uint8Array(32))
    const { sealedB64, senderPkB64 } = await eciesSeal(recipient.publicKeyB64, key)
    // Correct private key + sender pk, but claiming a different recipient pk in
    // the AAD → must fail (the AAD binds the box to the real recipient key).
    await expect(
      eciesOpen(recipient.privateKey, senderPkB64, sealedB64, other.publicKeyB64),
    ).rejects.toThrow()
  })

  it('rejects tampered ciphertext', async () => {
    const recipient = await generateEciesKeypair()
    const key = crypto.getRandomValues(new Uint8Array(32))
    const { sealedB64, senderPkB64 } = await eciesSeal(recipient.publicKeyB64, key)
    const bytes = Uint8Array.from(atob(sealedB64), (c) => c.charCodeAt(0))
    const at = bytes.length - 1
    bytes[at] = (bytes[at] ?? 0) ^ 0xff
    const tampered = btoa(String.fromCharCode(...bytes))
    await expect(
      eciesOpen(recipient.privateKey, senderPkB64, tampered, recipient.publicKeyB64),
    ).rejects.toThrow()
  })
})
