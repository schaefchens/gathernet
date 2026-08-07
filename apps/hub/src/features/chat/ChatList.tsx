import type { CommunityListItem, Friend } from '@gathernet/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useRouterState } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MoreIcon } from '../../components/icons.tsx'
import { api } from '../../lib/api.ts'
import type { CommunityMeta } from '../../lib/community-keys.ts'
import type { StoredMessage } from '../../lib/storage.ts'
import { selectChannel } from '../../stores/channel-selection.ts'
import { rememberCommunityName, useChannelTitles } from '../../stores/channel-titles.ts'
import { useChat } from '../../stores/chat.ts'
import { useCommunityChat } from '../../stores/community-chat.ts'
import { usePresence } from '../../stores/presence.ts'
import { channelKey, dmKey, useReadState } from '../../stores/read-state.ts'
import { setCommunityExpanded, useSidebarState } from '../../stores/sidebar-state.ts'
import { ChannelList } from '../communities/ChannelList.tsx'
import { CommunityAvatar } from '../communities/CommunityAvatar.tsx'
import { useDecryptedMeta } from '../communities/meta.ts'
import { PersonAvatar } from './PersonAvatar.tsx'

/** Block durations offered — time-limited by design (no permanent block). */
const BLOCK_DURATIONS = [
  { key: 'day', hours: 24 },
  { key: 'week', hours: 24 * 7 },
  { key: 'month', hours: 24 * 30 },
] as const

type Filter = 'all' | 'unread' | 'communities' | 'friends'

/**
 * One line of preview for a conversation row. Mirrors what the bubble would show.
 * Takes resolved strings rather than `t` — the typed i18n `t` can't be narrowed to
 * a plain `(key: string) => string`.
 */
function preview(
  m: StoredMessage,
  labels: { deleted: string; viewOnce: string; attachment: string; you: string },
): string {
  const body = m.deletedAt
    ? labels.deleted
    : m.once
      ? labels.viewOnce
      : m.text || (m.media ? labels.attachment : '')
  return m.outgoing ? `${labels.you} ${body}` : body
}

/** Time for today's messages, date for anything older — the usual list convention. */
function whenLabel(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

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
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const channelTitles = useChannelTitles((s) => s.byId)
  const communityNames = useChannelTitles((s) => s.communities)
  const channelMessages = useCommunityChat((s) => s.messages)
  // Previews and unread marks come from what this device has already decrypted —
  // no extra requests, and nothing about read state leaves the device.
  const dmGroups = useChat((s) => s.groups)
  const dmMessages = useChat((s) => s.messages)
  const lastRead = useReadState((s) => s.lastRead)
  const expandedIds = useSidebarState((s) => s.expanded)
  const previewLabels = {
    deleted: t('chat.deleted'),
    viewOnce: t('chat.viewOnce'),
    attachment: t('chat.attachment'),
    you: t('chats.youPrefix'),
  }

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

  const q = query.trim().toLowerCase()
  const communityChannels = useReadState((s) => s.communityChannels)

  const unreadCommunity = (communityId: string) =>
    (communityChannels[communityId] ?? []).some((id) => {
      const last = channelMessages[id]?.at(-1)
      return !!last && !last.outgoing && last.sentAt > (lastRead[channelKey(id)] ?? 0)
    })
  const unreadPerson = (accountId: string) => {
    const group = dmGroups[accountId]
    const last = group ? dmMessages[group.groupId]?.at(-1) : undefined
    return !!last && !last.outgoing && last.sentAt > (lastRead[dmKey(accountId)] ?? 0)
  }

  const list = (communities.data?.communities ?? []).filter((c) => {
    if (filter === 'friends') return false
    if (filter === 'unread' && !unreadCommunity(c.communityId)) return false
    if (!q) return true
    // A community stays in view when one of its channels matches, so you can find a
    // channel by name without knowing which community it lives in.
    const name = (communityNames[c.communityId] ?? '').toLowerCase()
    if (name.includes(q)) return true
    return (communityChannels[c.communityId] ?? []).some((id) =>
      (channelTitles[id] ?? '').toLowerCase().includes(q),
    )
  })

  const people = [...(friends.data?.friends ?? [])]
    .filter((f) => {
      if (filter === 'communities') return false
      if (filter === 'unread' && !unreadPerson(f.accountId)) return false
      return !q || f.displayName.toLowerCase().includes(q)
    })
    .sort((a, b) => {
      const rank = (f: Friend) =>
        statuses[f.accountId] && statuses[f.accountId] !== 'offline' ? 0 : 1
      return rank(a) - rank(b) || a.displayName.localeCompare(b.displayName)
    })

  if (friends.isLoading || communities.isLoading) {
    return (
      <ul className="space-y-1" aria-busy="true" aria-label={t('common.loading')}>
        {[0, 1, 2].map((i) => (
          <li key={i} className="flex items-center gap-3 px-3 py-2.5">
            <span className="skeleton h-8 w-8 rounded-full" />
            <span className="min-w-0 flex-1 space-y-1.5">
              <span className="skeleton block h-3 w-1/2" />
              <span className="skeleton block h-2.5 w-3/4" />
            </span>
          </li>
        ))}
      </ul>
    )
  }

  const chips: { id: Filter; label: string }[] = [
    { id: 'all', label: t('chats.filterAll') },
    { id: 'unread', label: t('chats.filterUnread') },
    { id: 'communities', label: t('chats.filterCommunities') },
    { id: 'friends', label: t('chats.filterFriends') },
  ]

  const controls = (
    <div className="mb-2 space-y-2">
      <input
        type="search"
        className="input-compact"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('chats.searchPlaceholder')}
        aria-label={t('chats.searchPlaceholder')}
      />
      <div className="flex gap-1.5">
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
              filter === chip.id
                ? 'border-gold bg-selected text-gold-bright'
                : 'border-edge text-ink-soft hover:text-ink'
            }`}
            aria-pressed={filter === chip.id}
            onClick={() => setFilter(chip.id)}
          >
            {chip.label}
          </button>
        ))}
      </div>
    </div>
  )

  if (list.length === 0 && people.length === 0) {
    return (
      <div>
        {controls}
        <p
          className={
            compact ? 'px-3 py-6 text-sm text-ink-soft' : 'card py-10 text-center text-ink-soft'
          }
        >
          {q || filter !== 'all' ? t('chats.noMatches') : t('chats.empty')}
        </p>
      </div>
    )
  }

  return (
    <div>
      {controls}
      <ul className="space-y-1">
        {list.map((community) => {
          const viewing = pathname.includes(community.communityId)
          // Sticky: a community you opened stays open until you collapse it, so coming
          // back from a channel doesn't make you expand it again to switch.
          // Searching expands everything it searches through: a channel row has to
          // render before its title is known.
          const expanded = q ? true : (expandedIds[community.communityId] ?? viewing)
          return (
            <li key={community.communityId}>
              <CommunityRow
                community={community}
                active={viewing}
                expanded={expanded}
                onToggle={() => setCommunityExpanded(community.communityId, !expanded)}
              />
              {expanded && (
                <div className="mt-0.5 mb-1 ml-5 border-l border-edge pl-2">
                  <ChannelList communityId={community.communityId} query={q || undefined} />
                </div>
              )}
            </li>
          )
        })}

        {people.map((friend) => {
          const status = statuses[friend.accountId] ?? 'offline'
          const menuOpen = openMenu === friend.accountId
          const group = dmGroups[friend.accountId]
          const last = group ? dmMessages[group.groupId]?.at(-1) : undefined
          const unread =
            !!last && !last.outgoing && last.sentAt > (lastRead[dmKey(friend.accountId)] ?? 0)
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
                    <span className="flex items-baseline gap-2">
                      <span
                        className={`min-w-0 flex-1 truncate ${unread ? 'font-semibold text-ink' : 'font-medium'}`}
                      >
                        {friend.displayName}
                      </span>
                      {last && (
                        <span className="shrink-0 text-[10px] text-ink-faint">
                          {whenLabel(last.sentAt)}
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-2">
                      <span
                        className={`min-w-0 flex-1 truncate text-xs ${unread ? 'text-ink-soft' : 'text-ink-faint'}`}
                      >
                        {last ? preview(last, previewLabels) : t(`friends.presence.${status}`)}
                      </span>
                      {/* With a preview occupying the subtitle, presence would otherwise
                        be colour-only. */}
                      {last && <span className="sr-only">{t(`friends.presence.${status}`)}</span>}
                      {unread && (
                        <>
                          <span className="sr-only">{t('chats.unread')}</span>
                          <span
                            className="h-2 w-2 shrink-0 rounded-full bg-gold-bright"
                            aria-hidden
                          />
                        </>
                      )}
                    </span>
                  </span>
                </Link>
                {manage && (
                  <button
                    type="button"
                    className="mr-1 rounded-md px-1.5 py-1 text-ink-faint hover:text-gold-bright"
                    aria-label={t('friends.actions')}
                    aria-expanded={menuOpen}
                    onClick={() => setOpenMenu(menuOpen ? null : friend.accountId)}
                  >
                    <MoreIcon size={18} />
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
    </div>
  )
}

function CommunityRow({
  community,
  active,
  expanded,
  onToggle,
}: {
  community: CommunityListItem
  active: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
  const meta = useDecryptedMeta<CommunityMeta>(community.communityId, community.metaCiphertext)
  const name = meta?.name ?? t('communities.encryptedName')
  useEffect(() => {
    rememberCommunityName(community.communityId, name)
  }, [community.communityId, name])
  // Unread across the community's channels, for the channels this device knows about
  // (learned on first open). A community you've never opened simply shows no mark.
  const channelIds = useReadState((s) => s.communityChannels[community.communityId])
  const lastRead = useReadState((s) => s.lastRead)
  const channelMessages = useCommunityChat((s) => s.messages)
  const unread = (channelIds ?? []).some((id) => {
    const last = channelMessages[id]?.at(-1)
    return !!last && !last.outgoing && last.sentAt > (lastRead[channelKey(id)] ?? 0)
  })

  return (
    // The row itself is the `.list-row`, not the link inside it, so the avatar is the
    // first thing in it and lands in the same column as every friend's avatar. A
    // chevron in front of it used to push the whole community off that column.
    <div className="list-row" data-active={active}>
      {/* The mark is the disclosure: it collapses the community's channels without
          leaving where you are. The rest of the row still opens the community. */}
      <button
        type="button"
        className="shrink-0 rounded-full"
        aria-expanded={expanded}
        aria-label={expanded ? t('chats.collapse') : t('chats.expand')}
        onClick={onToggle}
      >
        <CommunityAvatar
          communityId={community.communityId}
          mediaId={community.avatarMediaId}
          label={name}
          size="sm"
        />
      </button>
      <Link
        to="/communities/$communityId"
        params={{ communityId: community.communityId }}
        className="flex min-w-0 flex-1 items-center gap-3"
        // The community and its channels are different destinations: this row means
        // "show me the community", so it clears whichever channel was last open.
        onClick={() => selectChannel(community.communityId, null)}
      >
        <span className="min-w-0 flex-1">
          <span className={`block truncate ${unread ? 'font-semibold text-ink' : 'font-medium'}`}>
            {name}
          </span>
          <span className="block truncate text-xs text-ink-faint">
            {t('communities.channelCount', { count: community.channelCount })}
          </span>
        </span>
        {unread && (
          <>
            <span className="sr-only">{t('chats.unread')}</span>
            <span className="h-2 w-2 shrink-0 rounded-full bg-gold-bright" aria-hidden />
          </>
        )}
      </Link>
    </div>
  )
}
