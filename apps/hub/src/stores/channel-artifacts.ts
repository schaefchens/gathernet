/**
 * Pinned channel artifacts — UI store. Fetches the server-relayed opaque records
 * for a channel, decrypts each body under K_meta, verifies authority + status
 * against the capability chain (see lib/artifacts.ts), drops the invalid/expired,
 * and exposes the survivors to the pinned-bar UI. Create/approve/unpin actions
 * seal+sign locally and POST; the server relays a `community.channel_artifact_updated`
 * event that prompts a reload.
 */

import type { ChannelPinPolicy, ListArtifactsResponse } from '@gathernet/shared'
import { create } from 'zustand'
import { api } from '../lib/api.ts'
import {
  type ArtifactBody,
  buildApproval,
  buildArtifact,
  buildParticipation,
  isExpired,
  openArtifactRaw,
  parseArtifactBody,
  tallyParticipants,
  type VerifiedArtifact,
  verifyArtifact,
} from '../lib/artifacts.ts'
import {
  getKMeta,
  getKMetaEpoch,
  getPinnedOwner,
  makeCapFetcher,
  makeDeviceResolver,
} from '../lib/community-keys.ts'
import { secureStore } from '../lib/storage.ts'

interface ChannelArtifactsState {
  /** channelId → verified, non-expired artifacts (active + suggested), newest first */
  byChannel: Record<string, VerifiedArtifact[]>
}

export const useChannelArtifacts = create<ChannelArtifactsState>(() => ({ byChannel: {} }))

const base = (communityId: string, channelId: string) =>
  `/api/v1/communities/${communityId}/channels/${channelId}/artifacts`

export const channelArtifactsStore = {
  /** Fetch + decrypt + verify a channel's artifacts into the store. */
  async load(communityId: string, channelId: string, pinPolicy: ChannelPinPolicy): Promise<void> {
    let res: ListArtifactsResponse
    try {
      res = await api<ListArtifactsResponse>('GET', base(communityId, channelId))
    } catch {
      return
    }
    const kMeta = await getKMeta(communityId)
    const ownerAccountId = await getPinnedOwner(communityId)
    const epoch = await getKMetaEpoch(communityId)
    const me = (await secureStore.getDevice())?.accountId ?? null
    const resolve = makeDeviceResolver([], { communityId })
    const getCap = makeCapFetcher(communityId)
    const now = Date.now()
    const out: VerifiedArtifact[] = []
    for (const a of res.artifacts) {
      if (isExpired(a, now)) continue
      const raw = await openArtifactRaw(kMeta, a.sealedBody)
      const body = parseArtifactBody(raw)
      if (!raw || !body) continue // no K_meta or corrupt → can't render
      const { status, issuerAccountId } = await verifyArtifact(
        a,
        raw,
        pinPolicy,
        ownerAccountId,
        resolve,
        getCap,
        epoch,
      )
      if (status === 'invalid') continue
      const tally =
        a.participants.length > 0
          ? await tallyParticipants(a, me, resolve)
          : { count: 0, mine: false }
      out.push({ artifact: a, body, status, issuerAccountId, tally })
    }
    out.sort((x, y) => y.artifact.createdAt - x.artifact.createdAt)
    useChannelArtifacts.setState((s) => ({ byChannel: { ...s.byChannel, [channelId]: out } }))
  },

  /** Seal + sign a new pinned artifact and post it (a suggestion under moderators policy). */
  async pin(
    communityId: string,
    channelId: string,
    body: ArtifactBody,
    expiresAt: number | null = null,
  ): Promise<void> {
    const record = await secureStore.getDevice()
    const kMeta = await getKMeta(communityId)
    if (!record || !kMeta) throw new Error('locked')
    const epoch = await getKMetaEpoch(communityId)
    const built = await buildArtifact(channelId, body, kMeta, epoch, record, expiresAt)
    await api('POST', base(communityId, channelId), built)
  },

  /** A manager signs an approval promoting a suggestion to an active pin. */
  async approve(communityId: string, channelId: string, artifactId: string): Promise<void> {
    const record = await secureStore.getDevice()
    if (!record) throw new Error('locked')
    const approval = await buildApproval(channelId, artifactId, record)
    await api('POST', `${base(communityId, channelId)}/${artifactId}/approve`, approval)
  },

  /** Unpin (author or manager). */
  async unpin(communityId: string, channelId: string, artifactId: string): Promise<void> {
    await api('DELETE', `${base(communityId, channelId)}/${artifactId}`)
  },

  /** Toggle the current user's participation (RSVP) in an event artifact. */
  async participate(
    communityId: string,
    channelId: string,
    artifactId: string,
    join: boolean,
  ): Promise<void> {
    const url = `${base(communityId, channelId)}/${artifactId}/participate`
    if (!join) {
      await api('DELETE', url)
      return
    }
    const record = await secureStore.getDevice()
    if (!record) throw new Error('locked')
    await api('POST', url, await buildParticipation(channelId, artifactId, record))
  },

  /** Drop a channel's cached artifacts (e.g. on leave). */
  clear(channelId: string): void {
    useChannelArtifacts.setState((s) => {
      const { [channelId]: _drop, ...rest } = s.byChannel
      return { byChannel: rest }
    })
  },
}
