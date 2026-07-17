import type {
  ChannelAccess,
  CommunityChannel,
  CommunityDetailResponse,
  CreateChannelResponse,
} from '@gathernet/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChannelChat } from '../features/communities/ChannelChat.tsx'
import { InvitePanel } from '../features/communities/InvitePanel.tsx'
import { MemberPanel } from '../features/communities/MemberPanel.tsx'
import { api } from '../lib/api.ts'
import { communityChatStore } from '../stores/community-chat.ts'
import { useSession } from '../stores/session.ts'

export const Route = createFileRoute('/communities/$communityId')({
  component: CommunityDetailScreen,
})

const ROLE_BADGE = {
  owner: 'text-gold border-gold',
  leader: 'text-indigo-soft border-indigo-soft',
  member: 'text-ink-soft border-edge',
} as const

function CommunityDetailScreen() {
  const { communityId } = Route.useParams()
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const myAccountId = useSession((s) => s.accountId)

  const detailQuery = useQuery({
    queryKey: ['community', communityId],
    queryFn: () => api<CommunityDetailResponse>('GET', `/api/v1/communities/${communityId}`),
  })
  const detail = detailQuery.data
  const channels = detail?.channels ?? []
  const isLeader = detail?.myRole === 'owner' || detail?.myRole === 'leader'

  const [selected, setSelected] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  // Keep the selection valid as channels appear/disappear (WS-driven refetch).
  useEffect(() => {
    if (channels.length === 0) {
      setSelected(null)
      return
    }
    if (!selected || !channels.some((c) => c.channelId === selected)) {
      setSelected(channels[0]?.channelId ?? null)
    }
  }, [channels, selected])

  const selectedChannel = channels.find((c) => c.channelId === selected) ?? null

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['community', communityId] })
    void queryClient.invalidateQueries({ queryKey: ['communities'] })
  }

  const createChannel = useMutation({
    mutationFn: (input: { name: string; access: ChannelAccess }) =>
      api<CreateChannelResponse>('POST', `/api/v1/communities/${communityId}/channels`, input),
    onSuccess: async (res) => {
      // The creator's first act: publish epoch-0 GroupInfo so members can join.
      await communityChatStore.bootstrapChannel(res.channelId).catch((err) => {
        console.error('channel bootstrap failed', err)
      })
      invalidate()
      setShowCreate(false)
      setSelected(res.channelId)
    },
  })

  const deleteChannel = useMutation({
    mutationFn: (channelId: string) =>
      api('DELETE', `/api/v1/communities/${communityId}/channels/${channelId}`),
    onSuccess: (_data, channelId) => {
      void communityChatStore.forgetChannel(channelId)
      invalidate()
    },
  })

  if (detailQuery.isLoading) {
    return <p className="text-ink-soft">{t('common.loading')}</p>
  }
  if (detailQuery.isError || !detail) {
    return (
      <div className="space-y-4">
        <Link to="/communities" className="text-ink-soft hover:text-ink">
          ← {t('communities.title')}
        </Link>
        <div className="card text-center text-ink-soft py-12">{t('communities.notFound')}</div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link
          to="/communities"
          className="text-ink-soft hover:text-ink"
          aria-label={t('common.back')}
        >
          ←
        </Link>
        <h1 className="flex-1 font-display text-2xl truncate">{detail.community.name}</h1>
        <span
          className={`text-[10px] uppercase tracking-wide border rounded px-1.5 py-0.5 ${ROLE_BADGE[detail.myRole]}`}
        >
          {t(`communities.roles.${detail.myRole}`)}
        </span>
      </div>
      {detail.community.description && (
        <p className="text-sm text-ink-soft">{detail.community.description}</p>
      )}

      <div className="grid md:grid-cols-3 gap-4">
        <div className="md:col-span-1 space-y-4">
          <section className="card space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-medium text-ink-soft">{t('communities.channels')}</h2>
              {isLeader && (
                <button
                  type="button"
                  className="btn-quiet text-xs px-2 py-1"
                  onClick={() => setShowCreate((s) => !s)}
                >
                  {t('communities.addChannel')}
                </button>
              )}
            </div>

            {showCreate && isLeader && (
              <CreateChannelForm
                pending={createChannel.isPending}
                onCreate={(name, access) => createChannel.mutate({ name, access })}
              />
            )}

            {channels.length === 0 && (
              <p className="text-xs text-ink-faint">{t('communities.noChannels')}</p>
            )}
            <ul className="space-y-1">
              {channels.map((channel) => (
                <ChannelRow
                  key={channel.channelId}
                  channel={channel}
                  active={channel.channelId === selected}
                  canDelete={isLeader}
                  onSelect={() => setSelected(channel.channelId)}
                  onDelete={() => {
                    if (confirm(t('communities.deleteChannelConfirm', { name: channel.name }))) {
                      deleteChannel.mutate(channel.channelId)
                    }
                  }}
                />
              ))}
            </ul>
          </section>

          <MemberPanel
            communityId={communityId}
            myRole={detail.myRole}
            myAccountId={myAccountId}
            members={detail.members}
          />

          {isLeader && <InvitePanel communityId={communityId} />}
        </div>

        <div className="md:col-span-2">
          {selectedChannel ? (
            <ChannelChat
              channelId={selectedChannel.channelId}
              channelName={selectedChannel.name}
              access={selectedChannel.access}
            />
          ) : (
            <div className="card grid place-items-center h-[calc(100vh-11rem)] text-ink-soft">
              {t('communities.selectChannel')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ChannelRow({
  channel,
  active,
  canDelete,
  onSelect,
  onDelete,
}: {
  channel: CommunityChannel
  active: boolean
  canDelete: boolean
  onSelect: () => void
  onDelete: () => void
}) {
  return (
    <li className="flex items-center gap-1">
      <button
        type="button"
        onClick={onSelect}
        className={`flex-1 flex items-center gap-2 text-left rounded-md px-3 py-2 text-sm transition-colors ${
          active ? 'bg-overlay text-gold' : 'text-ink-soft hover:text-ink hover:bg-overlay/50'
        }`}
      >
        <span className="text-ink-faint">{channel.access === 'leaders' ? '🔒' : '#'}</span>
        <span className="truncate">{channel.name}</span>
      </button>
      {canDelete && (
        <button
          type="button"
          onClick={onDelete}
          className="text-ink-faint hover:text-danger px-1"
          aria-label="delete channel"
        >
          ×
        </button>
      )}
    </li>
  )
}

function CreateChannelForm({
  pending,
  onCreate,
}: {
  pending: boolean
  onCreate: (name: string, access: ChannelAccess) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [access, setAccess] = useState<ChannelAccess>('members')

  return (
    <form
      className="space-y-2 border border-edge rounded-md p-3 bg-overlay/40"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) onCreate(name.trim(), access)
      }}
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('communities.channelNamePlaceholder')}
        maxLength={80}
        autoFocus
      />
      <select
        className="w-full bg-overlay border border-edge rounded-md px-3 py-2 text-sm"
        value={access}
        onChange={(e) => setAccess(e.target.value as ChannelAccess)}
      >
        <option value="members">{t('communities.access.members')}</option>
        <option value="leaders">{t('communities.access.leaders')}</option>
      </select>
      <button type="submit" className="btn-gold w-full text-sm" disabled={!name.trim() || pending}>
        {t('communities.createChannel')}
      </button>
    </form>
  )
}
