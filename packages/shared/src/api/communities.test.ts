import { describe, expect, it } from 'vitest'
import { bucketMemberCount } from './communities.ts'

describe('bucketMemberCount', () => {
  it('bands counts so a large community never reports an exact figure', () => {
    expect(bucketMemberCount(1)).toBe('few')
    expect(bucketMemberCount(10)).toBe('few')
    expect(bucketMemberCount(11)).toBe('dozens')
    expect(bucketMemberCount(100)).toBe('dozens')
    expect(bucketMemberCount(101)).toBe('hundreds')
    expect(bucketMemberCount(1_000)).toBe('hundreds')
    expect(bucketMemberCount(1_001)).toBe('thousands')
    expect(bucketMemberCount(10_000)).toBe('thousands')
    expect(bucketMemberCount(10_001)).toBe('tensOfThousands')
    expect(bucketMemberCount(100_000)).toBe('tensOfThousands')
    expect(bucketMemberCount(100_001)).toBe('hundredsOfThousands')
  })
})
