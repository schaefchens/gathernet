import type {
  ChannelInviteResponse,
  ChannelMemberEntry,
  ChannelMembersResponse,
  CommunityMember,
  ListReportsResponse,
  ReportEntry,
} from '@gathernet/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api.ts'
import { makeDeviceResolver } from '../../lib/community-keys.ts'
import { openReport, type ReportBody } from '../../lib/reports.ts'
import { secureStore } from '../../lib/storage.ts'
import { wsClient } from '../../lib/ws-client.ts'
import { communityChatStore } from '../../stores/community-chat.ts'

interface ModerationPanelProps {
  communityId: string
  channelId: string
  /** community leader/owner — may toggle channel moderators */
  isLeader: boolean
  /** community roster, for the "invite member" picker */
  members: CommunityMember[]
  myAccountId: string | null
  /** invalidate the community detail query after roster-changing actions */
  onChanged: () => void
}

/**
 * Manager surface for a channel (community leader/owner OR a channel
 * moderator): resolve join requests, manage the active roster (kick, promote
 * moderators — leaders only), and issue targeted or code invites.
 */
export function ModerationPanel({
  communityId,
  channelId,
  isLeader,
  members,
  myAccountId,
  onChanged,
}: ModerationPanelProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [inviteChoice, setInviteChoice] = useState('')
  const [inviteCode, setInviteCode] = useState<string | null>(null)

  const rosterKey = ['channel-members', communityId, channelId]
  const roster = useQuery({
    queryKey: rosterKey,
    queryFn: () =>
      api<ChannelMembersResponse>(
        'GET',
        `/api/v1/communities/${communityId}/channels/${channelId}/members`,
      ),
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: rosterKey })
    onChanged()
  }

  const base = `/api/v1/communities/${communityId}/channels/${channelId}`

  const reportsKey = ['channel-reports', communityId, channelId]
  const reports = useQuery({
    queryKey: reportsKey,
    queryFn: () => api<ListReportsResponse>('GET', `${base}/reports`),
  })
  const refreshReports = () =>
    queryClient.invalidateQueries({ queryKey: ['channel-reports', communityId, channelId] })

  // A new report arrives over the WS → refetch the queue.
  useEffect(() => {
    return wsClient.on('community.channel_report_created', (m) => {
      if (m.payload.channelId === channelId) {
        void queryClient.invalidateQueries({
          queryKey: ['channel-reports', communityId, channelId],
        })
      }
    })
  }, [channelId, communityId, queryClient])

  const resolveRequest = useMutation({
    mutationFn: (input: { accountId: string; action: 'accept' | 'decline' }) =>
      api('POST', `${base}/requests/${input.accountId}`, { action: input.action }),
    onSuccess: refresh,
  })
  const kick = useMutation({
    mutationFn: (accountId: string) => api('POST', `${base}/kick/${accountId}`, {}),
    onSuccess: refresh,
  })
  const setModerator = useMutation({
    mutationFn: (input: { accountId: string; action: 'set' | 'unset' }) =>
      api('POST', `${base}/moderators/${input.accountId}`, { action: input.action }),
    onSuccess: (_data, input) => {
      // On promotion, issue the new moderator's channel cap now so they can mint a
      // trusted group_key rotation immediately (demotion revocation rides a rotation).
      if (input.action === 'set') {
        void communityChatStore.issueChannelModCapNow(communityId, channelId)
      }
      refresh()
    },
  })
  const setMuted = useMutation({
    mutationFn: (input: { accountId: string; muted: boolean }) =>
      api('POST', `${base}/mute/${input.accountId}`, { muted: input.muted }),
    onSuccess: refresh,
  })
  const invite = useMutation({
    mutationFn: (inviteeAccountId: string) =>
      api<ChannelInviteResponse>('POST', `${base}/invites`, {
        kind: 'targeted',
        inviteeAccountId,
      }),
    onSuccess: () => {
      setInviteChoice('')
      refresh()
    },
  })
  const createCode = useMutation({
    mutationFn: () => api<ChannelInviteResponse>('POST', `${base}/invites`, { kind: 'code' }),
    onSuccess: (res) => setInviteCode(res.code),
  })

  const entries = roster.data?.members ?? []
  const pending = entries.filter((m) => m.status === 'pending')
  const active = entries.filter((m) => m.status === 'active')
  // Community leaders/owner can't be kicked (server enforces; hide the button).
  const communityLeaderIds = new Set(
    members.filter((m) => m.role === 'owner' || m.role === 'leader').map((m) => m.accountId),
  )
  // Members eligible for a targeted invite: not already in the channel roster.
  const rosterIds = new Set(entries.map((m) => m.accountId))
  const invitable = members.filter((m) => !rosterIds.has(m.accountId))

  return (
    <div className="card space-y-5 h-[calc(100vh-11rem)] overflow-y-auto">
      <h2 className="font-medium text-ink-soft">{t('communities.moderation')}</h2>

      {roster.isLoading && <p className="text-sm text-ink-soft">{t('common.loading')}</p>}

      {/* reported messages */}
      <section className="space-y-2">
        <h3 className="text-xs uppercase tracking-wide text-ink-faint">
          {t('communities.reports')}
        </h3>
        {(reports.data?.reports.length ?? 0) === 0 ? (
          <p className="text-sm text-ink-faint">{t('communities.noReports')}</p>
        ) : (
          <ul className="space-y-2">
            {reports.data?.reports.map((entry) => (
              <ReportRow
                key={entry.reportId}
                entry={entry}
                communityId={communityId}
                channelId={channelId}
                base={base}
                members={members}
                leaderIds={communityLeaderIds}
                onResolved={() => void refreshReports()}
              />
            ))}
          </ul>
        )}
      </section>

      {/* pending join requests */}
      <section className="space-y-2">
        <h3 className="text-xs uppercase tracking-wide text-ink-faint">
          {t('communities.pendingRequests')}
        </h3>
        {pending.length === 0 ? (
          <p className="text-sm text-ink-faint">{t('communities.noPendingRequests')}</p>
        ) : (
          <ul className="space-y-2">
            {pending.map((member) => (
              <li
                key={member.accountId}
                className="flex items-center gap-2 bg-overlay rounded-md px-3 py-2"
              >
                <span className="flex-1 text-sm truncate">{member.displayName}</span>
                <button
                  type="button"
                  className="btn-gold text-xs px-2 py-1"
                  disabled={resolveRequest.isPending}
                  onClick={() =>
                    resolveRequest.mutate({ accountId: member.accountId, action: 'accept' })
                  }
                >
                  {t('communities.accept')}
                </button>
                <button
                  type="button"
                  className="btn-quiet text-xs px-2 py-1"
                  disabled={resolveRequest.isPending}
                  onClick={() =>
                    resolveRequest.mutate({ accountId: member.accountId, action: 'decline' })
                  }
                >
                  {t('communities.decline')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* active roster */}
      <section className="space-y-2">
        <h3 className="text-xs uppercase tracking-wide text-ink-faint">
          {t('communities.activeMembers')}
        </h3>
        <ul className="space-y-2">
          {active.map((member) => (
            <MemberRow
              key={member.accountId}
              member={member}
              isSelf={member.accountId === myAccountId}
              isCommunityLeader={communityLeaderIds.has(member.accountId)}
              isLeader={isLeader}
              busy={kick.isPending || setModerator.isPending || setMuted.isPending}
              onKick={() => {
                if (confirm(t('communities.kickConfirm', { name: member.displayName }))) {
                  kick.mutate(member.accountId)
                }
              }}
              onToggleModerator={() =>
                setModerator.mutate({
                  accountId: member.accountId,
                  action: member.role === 'moderator' ? 'unset' : 'set',
                })
              }
              onToggleMuted={() =>
                setMuted.mutate({ accountId: member.accountId, muted: !member.muted })
              }
            />
          ))}
        </ul>
      </section>

      {/* invites */}
      <section className="space-y-2">
        <h3 className="text-xs uppercase tracking-wide text-ink-faint">
          {t('communities.inviteMember')}
        </h3>
        {invitable.length === 0 ? (
          <p className="text-sm text-ink-faint">{t('communities.noMembersToInvite')}</p>
        ) : (
          <div className="flex gap-2">
            <select
              className="flex-1 bg-overlay border border-edge rounded-md px-3 py-2 text-sm"
              value={inviteChoice}
              onChange={(e) => setInviteChoice(e.target.value)}
            >
              <option value="">{t('communities.chooseMember')}</option>
              {invitable.map((m) => (
                <option key={m.accountId} value={m.accountId}>
                  {m.displayName}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-quiet text-sm"
              disabled={!inviteChoice || invite.isPending}
              onClick={() => invite.mutate(inviteChoice)}
            >
              {t('communities.invite')}
            </button>
          </div>
        )}

        <button
          type="button"
          className="btn-quiet w-full text-sm"
          disabled={createCode.isPending}
          onClick={() => createCode.mutate()}
        >
          {t('communities.createInviteCode')}
        </button>
        {inviteCode && (
          <div className="text-center space-y-1">
            <div className="text-xl font-mono tracking-[0.3em] text-gold">{inviteCode}</div>
            <p className="text-[11px] text-ink-faint">{t('communities.channelCodeHint')}</p>
          </div>
        )}
      </section>
    </div>
  )
}

function MemberRow({
  member,
  isSelf,
  isCommunityLeader,
  isLeader,
  busy,
  onKick,
  onToggleModerator,
  onToggleMuted,
}: {
  member: ChannelMemberEntry
  isSelf: boolean
  isCommunityLeader: boolean
  isLeader: boolean
  busy: boolean
  onKick: () => void
  onToggleModerator: () => void
  onToggleMuted: () => void
}) {
  const { t } = useTranslation()
  // Managers may mute/kick anyone except themselves and community leaders.
  const canModerate = !isSelf && !isCommunityLeader
  return (
    <li className="flex items-center gap-2 bg-overlay rounded-md px-3 py-2">
      <span className="flex-1 text-sm truncate">
        {member.displayName}
        {isSelf && <span className="ml-1 text-xs text-ink-faint">({t('communities.you')})</span>}
      </span>
      {member.muted && (
        <span className="text-[10px] uppercase tracking-wide border border-edge text-ink-faint rounded px-1.5 py-0.5">
          {t('communities.mutedBadge')}
        </span>
      )}
      {member.role === 'moderator' && (
        <span className="text-[10px] uppercase tracking-wide border border-indigo-soft text-indigo-soft rounded px-1.5 py-0.5">
          {t('communities.moderatorBadge')}
        </span>
      )}
      {canModerate && (
        <button
          type="button"
          className="btn-quiet text-xs px-2 py-1"
          disabled={busy}
          onClick={onToggleMuted}
        >
          {member.muted ? t('communities.unmute') : t('communities.mute')}
        </button>
      )}
      {isLeader && !isSelf && (
        <button
          type="button"
          className="btn-quiet text-xs px-2 py-1"
          disabled={busy}
          onClick={onToggleModerator}
        >
          {member.role === 'moderator'
            ? t('communities.removeModerator')
            : t('communities.makeModerator')}
        </button>
      )}
      {canModerate && (
        <button
          type="button"
          className="btn-danger text-xs px-2 py-1"
          disabled={busy}
          onClick={onKick}
        >
          {t('communities.kickFromChannel')}
        </button>
      )}
    </li>
  )
}

type DecodedReport = { body: ReportBody; reporterAccountId: string | null; verified: boolean }

const REASON_KEY = {
  spam: 'chat.reportReasonSpam',
  abuse: 'chat.reportReasonAbuse',
  inappropriate: 'chat.reportReasonInappropriate',
  safety: 'chat.reportReasonSafety',
  other: 'chat.reportReasonOther',
} as const

/**
 * One report in the moderation queue. The sealed envelope is decrypted + verified
 * client-side (the server never sees the content); a moderator can then remove the
 * reported message, kick its author, or dismiss the report.
 */
function ReportRow({
  entry,
  communityId,
  channelId,
  base,
  members,
  leaderIds,
  onResolved,
}: {
  entry: ReportEntry
  communityId: string
  channelId: string
  base: string
  members: CommunityMember[]
  leaderIds: Set<string>
  onResolved: () => void
}) {
  const { t } = useTranslation()
  const [dec, setDec] = useState<DecodedReport | null | 'pending'>('pending')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      const record = await secureStore.getDevice()
      if (!record) {
        if (alive) setDec(null)
        return
      }
      const resolve = makeDeviceResolver([], { communityId })
      const r = await openReport(entry, record, resolve)
      if (alive) setDec(r)
    })()
    return () => {
      alive = false
    }
  }, [entry, communityId])

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
      onResolved()
    } catch (err) {
      console.error('report action failed', err)
    } finally {
      setBusy(false)
    }
  }

  const resolve = async (action: 'resolve' | 'dismiss'): Promise<void> => {
    await api('PATCH', `${base}/reports/${entry.reportId}`, { action })
  }

  if (dec === 'pending') {
    return (
      <li className="bg-overlay rounded-md px-3 py-2 text-xs text-ink-faint">
        {t('common.loading')}
      </li>
    )
  }
  if (dec === null) {
    return (
      <li className="bg-overlay rounded-md px-3 py-2 text-xs text-ink-faint">
        {t('communities.reportUndecryptable')}
      </li>
    )
  }

  const { body, verified } = dec
  const authorName =
    body.authorName ??
    members.find((m) => m.accountId === body.authorAccountId)?.displayName ??
    body.authorAccountId
  const authorIsLeader = leaderIds.has(body.authorAccountId)

  return (
    <li className="space-y-2 bg-overlay rounded-md px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="rounded-full border border-edge px-1.5 py-0.5 text-ink-soft">
          {t(REASON_KEY[body.reason])}
        </span>
        {!verified && (
          <span className="rounded-full border border-danger/50 px-1.5 py-0.5 text-danger">
            {t('communities.reportUnverified')}
          </span>
        )}
        <span className="ml-auto text-ink-faint">
          {t('communities.reportedAuthor')}: {authorName}
        </span>
      </div>
      <p className="text-sm break-words">
        {body.content.text ? (
          body.content.text
        ) : body.content.mediaName ? (
          <span className="text-ink-soft">📎 {body.content.mediaName}</span>
        ) : (
          <span className="italic text-ink-faint">—</span>
        )}
      </p>
      {body.note && <p className="text-xs text-ink-faint italic">“{body.note}”</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-danger text-xs px-2 py-1"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await communityChatStore.removeMessageAsModerator(communityId, channelId, body.seq)
              await resolve('resolve')
            })
          }
        >
          {t('communities.reportRemoveMessage')}
        </button>
        {!authorIsLeader && (
          <button
            type="button"
            className="btn-danger text-xs px-2 py-1"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await api('POST', `${base}/kick/${body.authorAccountId}`, {})
                await resolve('resolve')
              })
            }
          >
            {t('communities.reportKickAuthor')}
          </button>
        )}
        <button
          type="button"
          className="btn-quiet text-xs px-2 py-1"
          disabled={busy}
          onClick={() => void act(() => resolve('dismiss'))}
        >
          {t('communities.reportDismiss')}
        </button>
      </div>
    </li>
  )
}
