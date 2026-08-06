/**
 * Pinned channel artifacts — UI store. Fetches the server-relayed opaque records
 * for a channel, decrypts each body under K_meta, verifies authority + status
 * against the capability chain (see lib/artifacts.ts), drops the invalid/expired,
 * and exposes the survivors to the pinned-bar UI. Create/approve/unpin actions
 * seal+sign locally and POST; the server relays a `community.channel_artifact_updated`
 * event that prompts a reload.
 */

import type {
  ChannelPinPolicy,
  ListArtifactsResponse,
  RollcallSweepResponse,
} from '@gathernet/shared'
import { create } from 'zustand'
import { api } from '../lib/api.ts'
import {
  type ArtifactBody,
  buildApproval,
  buildArtifact,
  buildParticipation,
  isExpired,
  newRsvpTicket,
  openArtifactRaw,
  parseArtifactBody,
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
import { rsvpTicketStore, secureStore } from '../lib/storage.ts'
import { communityChatStore } from './community-chat.ts'

interface ChannelArtifactsState {
  /** channelId → verified, non-expired artifacts (active + suggested), newest first */
  byChannel: Record<string, VerifiedArtifact[]>
  /** channelId → its communityId (the reminder clock needs it to address triggers) */
  community: Record<string, string>
}

export const useChannelArtifacts = create<ChannelArtifactsState>(() => ({
  byChannel: {},
  community: {},
}))

const base = (communityId: string, channelId: string) =>
  `/api/v1/communities/${communityId}/channels/${channelId}/artifacts`
const rollcallBase = (communityId: string, channelId: string) =>
  `/api/v1/communities/${communityId}/channels/${channelId}/rollcalls`

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
      // A roll-call's expiresAt is its DEADLINE, not an expiry: keep it so a manager can
      // still sweep after it closes.
      if (a.kind !== 'rollcall' && isExpired(a, now)) continue
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
      // Count comes from the server (anonymous tickets carry no identities to verify);
      // "mine" is whether THIS device holds the ticket — RSVP state is device-local.
      const tally = {
        count: a.ticketCount,
        mine: !!(await rsvpTicketStore.get(a.artifactId)),
      }
      out.push({ artifact: a, body, status, issuerAccountId, tally })
    }
    out.sort((x, y) => y.artifact.createdAt - x.artifact.createdAt)
    useChannelArtifacts.setState((s) => ({
      byChannel: { ...s.byChannel, [channelId]: out },
      community: { ...s.community, [channelId]: communityId },
    }))
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

  /**
   * Toggle this device's anonymous RSVP. Going: mint a random ticket, keep it locally, send
   * only its hash. Withdrawing: present the ticket preimage. The server never learns who is
   * coming — so RSVP state lives on THIS device only.
   */
  async participate(
    communityId: string,
    channelId: string,
    artifactId: string,
    join: boolean,
  ): Promise<void> {
    const url = `${base(communityId, channelId)}/${artifactId}/ticket`
    if (!join) {
      const ticket = await rsvpTicketStore.get(artifactId)
      // No local ticket → nothing this device can withdraw (it RSVP'd elsewhere).
      if (!ticket) return
      await api('DELETE', url, { ticket })
      await rsvpTicketStore.delete(artifactId)
      return
    }
    const { ticket, ticketHash } = await newRsvpTicket()
    await api('POST', url, { ticketHash })
    await rsvpTicketStore.put(artifactId, ticket)
  },

  /** Manager opens a roll-call: seal the prompt, sign it, POST with the chosen window. */
  async startRollcall(
    communityId: string,
    channelId: string,
    windowMinutes: number,
    prompt?: string,
  ): Promise<void> {
    const record = await secureStore.getDevice()
    const kMeta = await getKMeta(communityId)
    if (!record || !kMeta) throw new Error('locked')
    const epoch = await getKMetaEpoch(communityId)
    const body: ArtifactBody = { v: 1, kind: 'rollcall', ...(prompt ? { prompt } : {}) }
    // buildArtifact mints the id + seals/signs; the server sets expiresAt from the window.
    const built = await buildArtifact(channelId, body, kMeta, epoch, record, null)
    await api('POST', `${rollcallBase(communityId, channelId)}`, {
      artifactId: built.artifactId,
      windowMinutes,
      sealEpoch: built.sealEpoch,
      sealedBody: built.sealedBody,
      issuerDeviceId: built.issuerDeviceId,
      issuerSig: built.issuerSig,
    })
  },

  /** "I'm still here" — identified + device-signed, so it can't be forged by the relay. */
  async respondRollcall(communityId: string, channelId: string, artifactId: string): Promise<void> {
    const record = await secureStore.getDevice()
    if (!record) throw new Error('locked')
    await api(
      'POST',
      `${rollcallBase(communityId, channelId)}/${artifactId}/respond`,
      await buildParticipation(channelId, artifactId, record),
    )
  },

  /**
   * Manager sweeps a closed roll-call: the server marks non-responders removed and returns
   * them, then this client does the key work in ONE operation (commit or rotation).
   */
  async sweepRollcall(communityId: string, channelId: string, artifactId: string): Promise<number> {
    const res = await api<RollcallSweepResponse>(
      'POST',
      `${rollcallBase(communityId, channelId)}/${artifactId}/sweep`,
    )
    await communityChatStore.applyRollcallSweep(communityId, channelId, res.removedDeviceIds)
    return res.removedAccountIds.length
  },

  /** Drop a channel's cached artifacts (e.g. on leave). */
  clear(channelId: string): void {
    useChannelArtifacts.setState((s) => {
      const { [channelId]: _drop, ...rest } = s.byChannel
      const { [channelId]: _dropC, ...restC } = s.community
      return { byChannel: rest, community: restC }
    })
  },
}
