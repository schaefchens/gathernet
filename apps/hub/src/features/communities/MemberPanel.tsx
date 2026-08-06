import type {
  AssignableRole,
  CommunityMember,
  CommunityMembersPageResponse,
  CommunityRole,
  MemberCountBucket,
} from '@gathernet/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api.ts'
import { useCommunityChat } from '../../stores/community-chat.ts'

interface MemberPanelProps {
  communityId: string
  myRole: CommunityRole
  myAccountId: string | null
  /** first page of the roster — MANAGERS ONLY (empty for casual members, by design) */
  members: CommunityMember[]
  /** exact count for small communities; null when large (use `memberBucket`) */
  memberCount: number | null
  /** coarse size band, always present */
  memberBucket: MemberCountBucket
  /** this community's channelIds — used to derive the "active members" a casual member
   *  has actually seen in their own decrypted history */
  channelIds: string[]
}

/** Literal i18n keys for the size bands (the typed t() needs literals). */
const BUCKET_KEY = {
  few: 'communities.sizeFew',
  dozens: 'communities.sizeDozens',
  hundreds: 'communities.sizeHundreds',
  thousands: 'communities.sizeThousands',
  tensOfThousands: 'communities.sizeTensOfThousands',
  hundredsOfThousands: 'communities.sizeHundredsOfThousands',
} as const satisfies Record<MemberCountBucket, string>

const ROLE_BADGE: Record<CommunityRole, string> = {
  owner: 'text-gold border-gold',
  leader: 'text-indigo-soft border-indigo-soft',
  member: 'text-ink-soft border-edge',
}

export function MemberPanel({
  communityId,
  myRole,
  myAccountId,
  members,
  memberCount,
  memberBucket,
  channelIds,
}: MemberPanelProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const isOwner = myRole === 'owner'
  const isLeader = myRole === 'owner' || myRole === 'leader'
  // The server sends the roster to managers only; its presence is the signal.
  const hasRoster = members.length > 0

  // Extra pages loaded on demand beyond the detail's first page.
  const [extra, setExtra] = useState<CommunityMember[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  const roster = [...members, ...extra]
  // Only pageable when we know the exact total (small community) — a large one reports a
  // band, so we just offer "load more" while pages keep coming back full.
  const hasMore = hasRoster && (memberCount === null || roster.length < memberCount)

  // Casual members: the people they've actually SEEN — unique senders across this
  // community's decrypted channel history. Never a roster; purely local, no server call.
  const messagesByChannel = useCommunityChat((s) => s.messages)
  const seen = useMemo(() => {
    if (hasRoster) return []
    const byAccount = new Map<string, string>()
    for (const channelId of channelIds) {
      for (const m of messagesByChannel[channelId] ?? []) {
        if (m.senderAccountId === myAccountId) continue
        if (!byAccount.has(m.senderAccountId)) {
          byAccount.set(m.senderAccountId, m.senderName ?? m.senderAccountId.slice(0, 8))
        }
      }
    }
    return [...byAccount].map(([accountId, name]) => ({ accountId, name }))
  }, [hasRoster, channelIds, messagesByChannel, myAccountId])

  const loadMore = async () => {
    if (loadingMore || roster.length === 0) return
    setLoadingMore(true)
    try {
      const after = roster[roster.length - 1]?.accountId
      const page = await api<CommunityMembersPageResponse>(
        'GET',
        `/api/v1/communities/${communityId}/members?after=${after}`,
      )
      setExtra((prev) => [...prev, ...page.members])
    } catch {
      // transient — the button stays for a retry
    } finally {
      setLoadingMore(false)
    }
  }

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['community', communityId] })
    void queryClient.invalidateQueries({ queryKey: ['communities'] })
  }

  const setRole = useMutation({
    mutationFn: ({ accountId, role }: { accountId: string; role: AssignableRole }) =>
      api('POST', `/api/v1/communities/${communityId}/members/${accountId}/role`, { role }),
    onSuccess: invalidate,
  })
  const removeMember = useMutation({
    mutationFn: (accountId: string) =>
      api('POST', `/api/v1/communities/${communityId}/members/${accountId}/remove`),
    onSuccess: invalidate,
  })
  const leave = useMutation({
    mutationFn: () => api('POST', `/api/v1/communities/${communityId}/leave`),
    onSuccess: () => {
      invalidate()
      void navigate({ to: '/communities' })
    },
  })

  return (
    <section className="card space-y-3">
      <h2 className="font-medium text-ink-soft">
        {t('communities.members')}
        <span className="ml-1 text-xs text-ink-faint">
          {memberCount !== null ? `(${memberCount})` : `· ${t(BUCKET_KEY[memberBucket])}`}
        </span>
      </h2>

      {/* Casual members never see the roster — only the people they've encountered in
          their own visible history, plus the community's coarse size. */}
      {!hasRoster && (
        <div className="space-y-2">
          <p className="text-xs text-ink-faint">{t('communities.activeMembersHint')}</p>
          {seen.length === 0 ? (
            <p className="text-sm text-ink-faint">{t('communities.noActiveMembers')}</p>
          ) : (
            <ul className="space-y-1">
              {seen.map((s) => (
                <li
                  key={s.accountId}
                  className="flex items-center gap-2 bg-overlay rounded-md px-3 py-1.5 text-sm"
                >
                  <span className="flex-1 truncate">{s.name}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ul className="space-y-2">
        {roster.map((member) => {
          const isSelf = member.accountId === myAccountId
          const canRemove =
            !isSelf &&
            member.role !== 'owner' &&
            (isOwner || (isLeader && member.role === 'member'))
          const canPromote = isOwner && !isSelf && member.role === 'member'
          const canDemote = isOwner && !isSelf && member.role === 'leader'
          return (
            <li
              key={member.accountId}
              className="flex flex-wrap items-center gap-2 bg-overlay rounded-md px-3 py-2"
            >
              <span className="min-w-0 flex-1 text-sm truncate">
                {/* A member who joined by bare code can reach the roster before their
                    display name does — render the placeholder, not an empty row. */}
                {member.displayName || (
                  <span className="text-ink-faint italic">{t('connect.thisPerson')}</span>
                )}
                {isSelf && (
                  <span className="ml-1 text-xs text-ink-faint">({t('communities.you')})</span>
                )}
              </span>
              <span
                className={`text-[10px] uppercase tracking-wide border rounded px-1.5 py-0.5 ${ROLE_BADGE[member.role]}`}
              >
                {t(`communities.roles.${member.role}`)}
              </span>
              {canPromote && (
                <button
                  type="button"
                  className="btn-quiet text-xs px-2 py-1"
                  disabled={setRole.isPending}
                  onClick={() => setRole.mutate({ accountId: member.accountId, role: 'leader' })}
                >
                  {t('communities.promote')}
                </button>
              )}
              {canDemote && (
                <button
                  type="button"
                  className="btn-quiet text-xs px-2 py-1"
                  disabled={setRole.isPending}
                  onClick={() => setRole.mutate({ accountId: member.accountId, role: 'member' })}
                >
                  {t('communities.demote')}
                </button>
              )}
              {canRemove && (
                <button
                  type="button"
                  className="btn-danger text-xs px-2 py-1"
                  disabled={removeMember.isPending}
                  onClick={() => {
                    if (confirm(t('communities.removeConfirm', { name: member.displayName }))) {
                      removeMember.mutate(member.accountId)
                    }
                  }}
                >
                  {t('communities.remove')}
                </button>
              )}
            </li>
          )
        })}
      </ul>

      {hasMore && (
        <button
          type="button"
          className="btn-quiet w-full text-xs"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {memberCount !== null
            ? t('communities.loadMoreMembers', { count: memberCount - roster.length })
            : t('communities.loadMore')}
        </button>
      )}

      {myRole !== 'owner' && (
        <button
          type="button"
          className="btn-danger w-full text-sm"
          disabled={leave.isPending}
          onClick={() => {
            if (confirm(t('communities.leaveConfirm'))) leave.mutate()
          }}
        >
          {t('communities.leave')}
        </button>
      )}
    </section>
  )
}
