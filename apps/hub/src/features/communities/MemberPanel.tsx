import type {
  AssignableRole,
  CommunityMember,
  CommunityMembersPageResponse,
  CommunityRole,
} from '@gathernet/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api.ts'

interface MemberPanelProps {
  communityId: string
  myRole: CommunityRole
  myAccountId: string | null
  /** first page of members (server-bounded); the rest load on demand */
  members: CommunityMember[]
  /** total active members — a mega-community may far exceed the first page */
  memberCount: number
}

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
}: MemberPanelProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const isOwner = myRole === 'owner'
  const isLeader = myRole === 'owner' || myRole === 'leader'

  // Extra pages loaded on demand beyond the detail's first page.
  const [extra, setExtra] = useState<CommunityMember[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  const roster = [...members, ...extra]
  const hasMore = roster.length < memberCount

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
        <span className="ml-1 text-xs text-ink-faint">({memberCount})</span>
      </h2>
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
              className="flex items-center gap-2 bg-overlay rounded-md px-3 py-2"
            >
              <span className="flex-1 text-sm truncate">
                {member.displayName}
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
          {t('communities.loadMoreMembers', { count: memberCount - roster.length })}
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
