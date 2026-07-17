import { useEffect, useState } from 'react'
import {
  type ChannelMeta,
  type CommunityMeta,
  getKMeta,
  openMeta,
} from '../../lib/community-keys.ts'

/**
 * Decrypt a server-opaque `metaCiphertext` with the community's K_meta. Returns
 * `null` while loading AND when the metadata can't be decrypted — either no
 * K_meta is present on this device (joined by a bare, manually-typed code) or a
 * stale/wrong key. Callers render a graceful placeholder in that case. This is
 * an accepted limitation of the encrypted-metadata model.
 */
export function useDecryptedMeta<T extends CommunityMeta | ChannelMeta>(
  communityId: string,
  metaCiphertext: string | null,
): T | null {
  const [meta, setMeta] = useState<T | null>(null)
  useEffect(() => {
    let cancelled = false
    setMeta(null)
    void (async () => {
      const kMeta = await getKMeta(communityId)
      const opened = await openMeta<T>(kMeta, metaCiphertext)
      if (!cancelled) setMeta(opened)
    })()
    return () => {
      cancelled = true
    }
  }, [communityId, metaCiphertext])
  return meta
}

/** Short, id-based fallback title for a channel whose meta can't be decrypted. */
export function channelFallbackTitle(channelId: string): string {
  return `#${channelId.slice(0, 4)}`
}
