import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  type ChannelMeta,
  type CommunityMeta,
  getKMeta,
  onKMetaChange,
  openMeta,
} from '../../lib/community-keys.ts'

let kMetaVersion = 0
onKMetaChange(() => {
  kMetaVersion += 1
})

/** Re-renders when any K_meta becomes available (e.g. a cross-device grant). */
export function useKMetaVersion(): number {
  return useSyncExternalStore(onKMetaChange, () => kMetaVersion)
}

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
  const kMetaVersion = useKMetaVersion()
  // biome-ignore lint/correctness/useExhaustiveDependencies: kMetaVersion re-runs decryption once a cross-device grant supplies K_meta.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const kMeta = await getKMeta(communityId)
      const opened = await openMeta<T>(kMeta, metaCiphertext)
      if (!cancelled) setMeta(opened)
    })()
    return () => {
      cancelled = true
    }
    // kMetaVersion re-runs decryption once a cross-device grant supplies the key.
  }, [communityId, metaCiphertext, kMetaVersion])
  return meta
}

/** Short, id-based fallback title for a channel whose meta can't be decrypted. */
export function channelFallbackTitle(channelId: string): string {
  return `#${channelId.slice(0, 4)}`
}
