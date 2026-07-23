import type {
  CommunityChannel,
  CommunityDetailResponse,
  UpdateCommunityRequest,
} from '@gathernet/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChannelChat } from '../features/communities/ChannelChat.tsx'
import { ChannelJoinPanel } from '../features/communities/ChannelJoinPanel.tsx'
import { ChannelSettingsForm } from '../features/communities/ChannelSettingsForm.tsx'
import { ClampedMarkdown } from '../features/communities/ClampedMarkdown.tsx'
import { AvatarUploader, CommunityAvatar } from '../features/communities/CommunityAvatar.tsx'
import { InvitePanel } from '../features/communities/InvitePanel.tsx'
import { MemberPanel } from '../features/communities/MemberPanel.tsx'
import { ModerationPanel } from '../features/communities/ModerationPanel.tsx'
import { channelFallbackTitle, useDecryptedMeta } from '../features/communities/meta.ts'
import { api } from '../lib/api.ts'
import { type ChannelMeta, type CommunityMeta, getKMeta, sealMeta } from '../lib/community-keys.ts'
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

  const communityMeta = useDecryptedMeta<CommunityMeta>(
    communityId,
    detail?.community.metaCiphertext ?? null,
  )
  const communityName = communityMeta?.name ?? t('communities.encryptedName')

  const [selected, setSelected] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  const sorted = [...channels].sort((a, b) => a.position - b.position)

  // Keep the selection valid as channels appear/disappear (WS-driven refetch).
  useEffect(() => {
    if (sorted.length === 0) {
      setSelected(null)
      return
    }
    if (!selected || !sorted.some((c) => c.channelId === selected)) {
      setSelected(sorted[0]?.channelId ?? null)
    }
  }, [sorted, selected])

  const selectedChannel = sorted.find((c) => c.channelId === selected) ?? null

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['community', communityId] })
    void queryClient.invalidateQueries({ queryKey: ['communities'] })
  }

  // K_meta sync + rotation. Fetch our grant if the key is stale/missing; seed
  // grants to other member devices; and, if a member left and we're a leader,
  // rotate K_meta (re-encrypt metadata under a new epoch). Re-decrypt on change.
  const keyEpoch = detail?.community.keyEpoch
  const rotationPending = detail?.community.rotationPending ?? false
  useEffect(() => {
    if (keyEpoch === undefined) return
    let cancelled = false
    void (async () => {
      const obtained = await communityChatStore.syncKeyGrants(communityId, keyEpoch)
      const rotated =
        rotationPending && isLeader ? await communityChatStore.rotateCommunity(communityId) : false
      if ((obtained || rotated) && !cancelled) {
        void queryClient.invalidateQueries({ queryKey: ['community', communityId] })
        void queryClient.invalidateQueries({ queryKey: ['communities'] })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [communityId, keyEpoch, rotationPending, isLeader, queryClient])

  const deleteChannel = useMutation({
    mutationFn: (channelId: string) =>
      api('DELETE', `/api/v1/communities/${communityId}/channels/${channelId}`),
    onSuccess: (_data, channelId) => {
      void communityChatStore.forgetChannel(channelId)
      invalidate()
    },
  })

  const onDeleteChannel = (channelId: string) => {
    if (confirm(t('communities.deleteChannelConfirm'))) deleteChannel.mutate(channelId)
  }

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
        <CommunityAvatar
          communityId={communityId}
          mediaId={detail.community.avatarMediaId}
          label={communityName}
          size="md"
        />
        <h1 className="flex-1 font-display text-2xl truncate">{communityName}</h1>
        {isLeader && (
          <button
            type="button"
            className="btn-quiet text-xs px-2 py-1"
            onClick={() => setShowSettings((s) => !s)}
          >
            {t('communities.communitySettings')}
          </button>
        )}
        <span
          className={`text-[10px] uppercase tracking-wide border rounded px-1.5 py-0.5 ${ROLE_BADGE[detail.myRole]}`}
        >
          {t(`communities.roles.${detail.myRole}`)}
        </span>
      </div>
      {communityMeta?.description && !showSettings && (
        <ClampedMarkdown
          text={communityMeta.description}
          className="text-sm text-ink-soft [&_p]:mb-2 [&_ul]:mb-2"
        />
      )}

      {showSettings && isLeader && (
        <CommunitySettingsForm
          key={communityMeta ? 'loaded' : 'empty'}
          communityId={communityId}
          initialMeta={communityMeta}
          avatarMediaId={detail.community.avatarMediaId}
          communityName={communityName}
          onDone={() => {
            setShowSettings(false)
            invalidate()
          }}
          onCancel={() => setShowSettings(false)}
        />
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
              <ChannelSettingsForm
                communityId={communityId}
                mode="create"
                onDone={(channelId) => {
                  setShowCreate(false)
                  invalidate()
                  if (channelId) setSelected(channelId)
                }}
                onCancel={() => setShowCreate(false)}
              />
            )}

            {sorted.length === 0 && (
              <p className="text-xs text-ink-faint">{t('communities.noChannels')}</p>
            )}
            <ul className="space-y-1">
              {sorted.map((channel) => (
                <ChannelRow
                  key={channel.channelId}
                  communityId={communityId}
                  channel={channel}
                  active={channel.channelId === selected}
                  onSelect={() => setSelected(channel.channelId)}
                />
              ))}
            </ul>
          </section>

          <MemberPanel
            communityId={communityId}
            myRole={detail.myRole}
            myAccountId={myAccountId}
            members={detail.members}
            memberCount={detail.memberCount}
          />

          {isLeader && <InvitePanel communityId={communityId} />}
        </div>

        <div className="md:col-span-2">
          {selectedChannel ? (
            <ChannelWorkspace
              key={selectedChannel.channelId}
              communityId={communityId}
              channel={selectedChannel}
              isLeader={isLeader}
              myAccountId={myAccountId}
              members={detail.members}
              onChanged={invalidate}
              onDeleteChannel={onDeleteChannel}
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
  communityId,
  channel,
  active,
  onSelect,
}: {
  communityId: string
  channel: CommunityChannel
  active: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation()
  const meta = useDecryptedMeta<ChannelMeta>(communityId, channel.metaCiphertext)
  const title = meta?.title ?? channelFallbackTitle(channel.channelId)

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`w-full flex items-center gap-2 text-left rounded-md px-2 py-1.5 text-sm transition-colors ${
          active ? 'bg-overlay text-gold' : 'text-ink-soft hover:text-ink hover:bg-overlay/50'
        }`}
      >
        {channel.avatarMediaId ? (
          <CommunityAvatar
            communityId={communityId}
            mediaId={channel.avatarMediaId}
            label={meta?.emoji ?? title}
            size="sm"
          />
        ) : (
          <span className="h-8 w-8 shrink-0 grid place-items-center rounded-md bg-overlay text-ink-faint">
            {meta?.emoji ?? '#'}
          </span>
        )}
        <span className="truncate flex-1">{title}</span>
        {channel.access === 'leaders' && (
          <span title={t('communities.access.leaders')} aria-hidden>
            🔒
          </span>
        )}
        {channel.visibility === 'unlisted' && (
          <span className="text-[10px] text-ink-faint uppercase tracking-wide">
            {t('communities.visibility.unlisted')}
          </span>
        )}
        {channel.myStatus === 'pending' && (
          <span className="text-[10px] uppercase tracking-wide text-amber">
            {t('communities.requested')}
          </span>
        )}
        {channel.myStatus === 'invited' && (
          <span className="text-[10px] uppercase tracking-wide text-gold">
            {t('communities.invited')}
          </span>
        )}
      </button>
    </li>
  )
}

type WorkspaceView = 'chat' | 'settings' | 'moderation'

function ChannelWorkspace({
  communityId,
  channel,
  isLeader,
  myAccountId,
  members,
  onChanged,
  onDeleteChannel,
}: {
  communityId: string
  channel: CommunityChannel
  isLeader: boolean
  myAccountId: string | null
  members: CommunityDetailResponse['members']
  onChanged: () => void
  onDeleteChannel: (channelId: string) => void
}) {
  const { t } = useTranslation()
  const meta = useDecryptedMeta<ChannelMeta>(communityId, channel.metaCiphertext)
  const title = meta?.title ?? channelFallbackTitle(channel.channelId)
  const emoji = meta?.emoji
  const isActive = channel.myStatus === 'active'
  const isModerator = isActive && channel.myRole === 'moderator'
  const isManager = isLeader || isModerator
  const canEdit = isLeader || isModerator
  // Announcement channels are read-only for everyone but managers; a muted
  // member is read-only regardless.
  const canPost = (channel.postPolicy === 'everyone' || isManager) && !channel.muted
  const [view, setView] = useState<WorkspaceView>('chat')

  if (!isActive) {
    return (
      <ChannelJoinPanel
        communityId={communityId}
        channel={channel}
        title={title}
        emoji={emoji}
        onChanged={onChanged}
      />
    )
  }

  return (
    <div className="space-y-3">
      {(isManager || canEdit) && (
        <div className="flex gap-2">
          <TabButton active={view === 'chat'} onClick={() => setView('chat')}>
            {t('communities.viewChat')}
          </TabButton>
          {isManager && (
            <TabButton active={view === 'moderation'} onClick={() => setView('moderation')}>
              {t('communities.moderation')}
            </TabButton>
          )}
          {canEdit && (
            <TabButton active={view === 'settings'} onClick={() => setView('settings')}>
              {t('communities.channelSettings')}
            </TabButton>
          )}
        </div>
      )}

      {view === 'chat' && (
        <ChannelChat
          communityId={communityId}
          channelId={channel.channelId}
          title={title}
          emoji={emoji}
          avatarMediaId={channel.avatarMediaId}
          access={channel.access}
          postPolicy={channel.postPolicy}
          canPost={canPost}
          muted={channel.muted}
          description={meta?.description}
          messageTtlDays={channel.messageTtlDays}
        />
      )}

      {view === 'moderation' && isManager && (
        <ModerationPanel
          communityId={communityId}
          channelId={channel.channelId}
          isLeader={isLeader}
          members={members}
          myAccountId={myAccountId}
          onChanged={onChanged}
        />
      )}

      {view === 'settings' && canEdit && (
        <div className="card h-[calc(100vh-12.5rem)] overflow-y-auto">
          <ChannelSettingsForm
            key={meta ? 'loaded' : 'empty'}
            communityId={communityId}
            mode="edit"
            channel={channel}
            initialMeta={meta}
            onDone={() => {
              setView('chat')
              onChanged()
            }}
            onCancel={() => setView('chat')}
            canDelete={isLeader}
            onDelete={() => onDeleteChannel(channel.channelId)}
          />
        </div>
      )}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
        active ? 'border-gold text-gold' : 'border-edge text-ink-soft hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}

function CommunitySettingsForm({
  communityId,
  initialMeta,
  avatarMediaId,
  communityName,
  onDone,
  onCancel,
}: {
  communityId: string
  initialMeta: CommunityMeta | null
  avatarMediaId: string | null
  communityName: string
  onDone: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(initialMeta?.name ?? '')
  const [description, setDescription] = useState(initialMeta?.description ?? '')
  const [media, setMedia] = useState<string | null>(avatarMediaId)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      const kMeta = await getKMeta(communityId)
      const body: UpdateCommunityRequest = {}
      if (kMeta) {
        body.metaCiphertext = await sealMeta(kMeta, {
          name: trimmed,
          ...(description.trim() ? { description: description.trim() } : {}),
        })
      }
      if (media !== avatarMediaId) {
        body.avatarMediaId = media as UpdateCommunityRequest['avatarMediaId']
      }
      // PATCH requires at least one field — nothing to change if K_meta is
      // absent and the avatar is untouched.
      if (body.metaCiphertext === undefined && body.avatarMediaId === undefined) {
        onCancel()
        return
      }
      await api('PATCH', `/api/v1/communities/${communityId}`, body)
      onDone()
    } catch (err) {
      console.error('community settings save failed', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="card space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <h2 className="font-medium text-ink-soft">{t('communities.communitySettings')}</h2>
      <AvatarUploader
        communityId={communityId}
        currentMediaId={media}
        label={communityName}
        onUploaded={setMedia}
      />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('communities.namePlaceholder')}
        maxLength={80}
      />
      <div className="space-y-1">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('communities.descriptionPlaceholder')}
          maxLength={2000}
          rows={3}
        />
        <p className="text-[11px] text-ink-faint">{t('communities.markdownHint')}</p>
      </div>
      <div className="flex gap-2">
        <button type="submit" className="btn-gold flex-1" disabled={!name.trim() || busy}>
          {t('common.save')}
        </button>
        <button type="button" className="btn-quiet" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  )
}
