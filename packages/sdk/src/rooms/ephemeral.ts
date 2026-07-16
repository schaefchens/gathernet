import type { MlsDevice, MlsModule } from './mls.ts'

/**
 * Ephemeral room payloads (cursor/typing/game-tick …) are relayed live and
 * never persisted, but must still be end-to-end encrypted. We derive a
 * per-epoch symmetric key from the MLS exporter secret — every member at the
 * same epoch derives the identical key — and seal with XChaCha20-Poly1305.
 * A payload sealed at epoch N can only be opened by members who have advanced
 * to epoch N, so forward/backward secrecy tracks the group's ratchet.
 */

const EXPORTER_LABEL = 'gathernet-ephemeral'
const KEY_LEN = 32
const encoder = new TextEncoder()

/** 8-byte big-endian epoch, the exporter context both sides agree on. */
function epochContext(epoch: number): Uint8Array {
  const ctx = new Uint8Array(8)
  new DataView(ctx.buffer).setBigUint64(0, BigInt(epoch), false)
  return ctx
}

function epochKey(device: MlsDevice, groupId: Uint8Array, epoch: number): Uint8Array {
  return device.exportSecret(groupId, EXPORTER_LABEL, epochContext(epoch), KEY_LEN)
}

/** AAD binds the ciphertext to (label, groupId) so it can't cross rooms. */
function aad(groupIdHex: string): Uint8Array {
  return encoder.encode(`${EXPORTER_LABEL}/${groupIdHex}`)
}

export function sealEphemeral(
  mls: MlsModule,
  device: MlsDevice,
  groupId: Uint8Array,
  groupIdHex: string,
  epoch: number,
  plaintext: Uint8Array,
): Uint8Array {
  return mls.seal(epochKey(device, groupId, epoch), plaintext, aad(groupIdHex))
}

export function openEphemeral(
  mls: MlsModule,
  device: MlsDevice,
  groupId: Uint8Array,
  groupIdHex: string,
  epoch: number,
  sealed: Uint8Array,
): Uint8Array {
  return mls.openSealed(epochKey(device, groupId, epoch), sealed, aad(groupIdHex))
}
