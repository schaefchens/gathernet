const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]))

/** base58btc encode — dependency-free, matches the Rust `bs58` crate. */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++

  const digits: number[] = []
  for (let i = zeros; i < bytes.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by loop
    let carry = bytes[i]!
    for (let j = 0; j < digits.length; j++) {
      // biome-ignore lint/style/noNonNullAssertion: in-range index
      carry += digits[j]! << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }

  let out = '1'.repeat(zeros)
  for (let i = digits.length - 1; i >= 0; i--) {
    // biome-ignore lint/style/noNonNullAssertion: in-range index
    out += ALPHABET[digits[i]!]
  }
  return out
}

/** base58btc decode; returns null on invalid characters. */
export function base58Decode(text: string): Uint8Array | null {
  let zeros = 0
  while (zeros < text.length && text[zeros] === '1') zeros++

  const bytes: number[] = []
  for (let i = zeros; i < text.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked by loop
    const value = INDEX.get(text[i]!)
    if (value === undefined) return null
    let carry = value
    for (let j = 0; j < bytes.length; j++) {
      // biome-ignore lint/style/noNonNullAssertion: in-range index
      carry += bytes[j]! * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }

  return new Uint8Array([...new Array(zeros).fill(0), ...bytes.reverse()])
}
