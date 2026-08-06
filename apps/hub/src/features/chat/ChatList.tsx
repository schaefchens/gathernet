import type { CommunityListItem, Friend } from '@gathernet/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useRouterState } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api.ts'
import type { CommunityMeta } from '../../lib/community-keys.ts'
import { usePresence } from '../../stores/presence.ts'
import { CommunityAvatar } from '../communities/CommunityAvatar.tsx'
import { useDecryptedMeta } from '../communities/meta.ts'
import { PersonAvatar } from './PersonAvatar.tsx'

/** Block durations offered — time-limited by design (no permanent block). */
const BLOCK_DURATIONS = [
  { key: 'day', hours: 24 },
  { key: 'week', hours: 24 * 7 },
  { key: 'month', hours: 24 * 30 },
] as const

/**
 * The one conversation list: the communities you're in and the friends you can
 * message, in a single column. A community row opens the community; a person row
 * opens the 1:1 chat. The desktop sidebar renders it `compact` for navigation and
 * the Chats screen renders it with `manage` for the per-person actions — one
 * component, so the two views can't drift apart.
 */
export function ChatList({ compact, manage }: { compact?: boolean; manage?: boolean }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const statuses = usePresence((s) => s.statuses)
  const [openMenu, setOpenMenu] = useState<string | null>(null)

  const friends = useQuery({
    queryKey: ['friends'],
    queryFn: () => api<{ friends: Friend[] }>('GET', '/api/v1/friends'),
  })
  const communities = useQuery({
    queryKey: ['communities'],
    queryFn: () => api<{ communities: CommunityListItem[] }>('GET', '/api/v1/communities'),
  })

  const invalidate = () => {
    setOpenMenu(null)
    void queryClient.invalidateQueries({ queryKey: ['friends'] })
    void queryClient.invalidateQueries({ queryKey: ['blocks'] })
  }
  const remove = useMutation({
    mutationFn: (accountId: string) => api('DELETE', `/api/v1/friends/${accountId}`),
    onSuccess: invalidate,
  })
  const block = useMutation({
    mutationFn: (v: { accountId: string; durationHours: number }) =>
      api('POST', `/api/v1/friends/${v.accountId}/block`, { durationHours: v.durationHours }),
    onSuccess: invalidate,
  })

  const list = communities.data?.communities ?? []
  const people = [...(friends.data?.friends ?? [])].sort((a, b) => {
    const rank = (f: Friend) =>
      statuses[f.accountId] && statuses[f.accountId] !== 'offline' ? 0 : 1
    return rank(a) - rank(b) || a.displayName.localeCompare(b.displayName)
  })

  if (friends.isLoading || communities.isLoading) {
    return <p className="px-3 py-4 text-sm text-ink-soft">{t('common.loading')}</p>
  }

  if (list.length === 0 && people.length === 0) {
    return (
      <p
        className={
          compact ? 'px-3 py-6 text-sm text-ink-soft' : 'card py-12 text-center text-ink-soft'
        }
      >
        {t('chats.empty')}
      </p>
    )
  }

  return (
    <ul className="space-y-1">
      {list.map((community) => (
        <li key={community.communityId}>
          <CommunityRow community={community} active={pathname.includes(community.communityId)} />
        </li>
      ))}

      {people.map((friend) => {
        const status = statuses[friend.accountId] ?? 'offline'
        const menuOpen = openMenu === friend.accountId
        return (
          <li key={friend.accountId} className={menuOpen ? 'rounded-lg bg-selected' : undefined}>
            <div className="flex items-center">
              <Link
                to="/chat/$friendId"
                params={{ friendId: friend.accountId }}
                className="list-row min-w-0 flex-1"
                data-active={pathname === `/chat/${friend.accountId}`}
              >
                <PersonAvatar
                  accountId={friend.accountId}
                  label={friend.displayName}
                  size="sm"
                  status={status}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{friend.displayName}</span>
                  <span className="block truncate text-xs text-ink-faint">
                    {t(`friends.presence.${status}`)}
                  </span>
                </span>
              </Link>
              {manage && (
                <button
                  type="button"
                  className="mr-1 rounded-md px-2 py-1 text-lg leading-none text-ink-faint hover:text-gold-bright"
                  aria-label={t('friends.actions')}
                  aria-expanded={menuOpen}
                  onClick={() => setOpenMenu(menuOpen ? null : friend.accountId)}
                >
                  ⋯
                </button>
              )}
            </div>

            {manage && menuOpen && (
              <div className="space-y-3 rounded-b-lg border-t border-edge px-3 py-3 text-sm">
                <div>
                  <button
                    type="button"
                    className="font-medium text-danger disabled:opacity-40"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(friend.accountId)}
                  >
                    {t('friends.remove')}
                  </button>
                  <p className="mt-0.5 text-xs text-ink-faint">
                    {t('friends.removeConfirm', { name: friend.displayName })}
                  </p>
                </div>
                <div>
                  <p className="font-medium">{t('friends.block')}</p>
                  <p className="mt-0.5 mb-1.5 text-xs text-ink-faint">
                    {t('friends.blockHint', { name: friend.displayName })}
                  </p>
                  <div className="flex gap-2">
                    {BLOCK_DURATIONS.map((d) => (
                      <button
                        key={d.key}
                        type="button"
                        className="btn-quiet text-xs disabled:opacity-40"
                        disabled={block.isPending}
                        onClick={() =>
                          block.mutate({ accountId: friend.accountId, durationHours: d.hours })
                        }
                      >
                        {t(`friends.blockDuration.${d.key}`)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function CommunityRow({ community, active }: { community: CommunityListItem; active: boolean }) {
  const { t } = useTranslation()
  const meta = useDecryptedMeta<CommunityMeta>(community.communityId, community.metaCiphertext)
  const name = meta?.name ?? t('communities.encryptedName')

  return (
    <Link
      to="/communities/$communityId"
      params={{ communityId: community.communityId }}
      className="list-row"
      data-active={active}
    >
      <CommunityAvatar
        communityId={community.communityId}
        mediaId={community.avatarMediaId}
        label={name}
        size="sm"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-display text-base font-medium">{name}</span>
        <span className="block truncate text-xs text-ink-faint">
          {t('communities.channelCount', { count: community.channelCount })}
        </span>
      </span>
    </Link>
  )
}
