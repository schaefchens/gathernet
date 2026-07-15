/**
 * Byte/string codecs used across the sync engine. btoa/atob exist both in
 * browsers and in Node >= 16, so we declare them instead of pulling in the
 * DOM lib for an otherwise platform-agnostic package.
 */
declare function btoa(data: string): string
declare function atob(data: string): string

export const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16))

export const bytesToHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

export const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))

export const fromB64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
