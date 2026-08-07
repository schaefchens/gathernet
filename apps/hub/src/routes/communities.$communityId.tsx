import type {
  CommunityChannel,
  CommunityDetailResponse,
  UpdateCommunityRequest,
} from '@gathernet/shared'
import { COMMUNITY_DEVICE_LIMIT_MAX } from '@gathernet/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LockIcon } from '../components/icons.tsx'
import { MenuButton } from '../components/MenuButton.tsx'
import { PageHeader } from '../components/PageHeader.tsx'
import { ChannelChat } from '../features/communities/ChannelChat.tsx'
import { ChannelInfo } from '../features/communities/ChannelInfo.tsx'
import { ChannelJoinPanel } from '../features/communities/ChannelJoinPanel.tsx'
import { ChannelSettingsForm } from '../features/communities/ChannelSettingsForm.tsx'
import { AvatarUploader, CommunityAvatar } from '../features/communities/CommunityAvatar.tsx'
import { CommunityOverview } from '../features/communities/CommunityOverview.tsx'
import { InvitePanel } from '../features/communities/InvitePanel.tsx'
import { MemberPanel } from '../features/communities/MemberPanel.tsx'
import { ModerationPanel } from '../features/communities/ModerationPanel.tsx'
import { channelFallbackTitle, useDecryptedMeta } from '../features/communities/meta.ts'
import { api } from '../lib/api.ts'
import { type ChannelMeta, type CommunityMeta, getKMeta, sealMeta } from '../lib/community-keys.ts'
import { DESKTOP_QUERY, useMediaQuery } from '../lib/use-media-query.ts'
import { selectChannel, useChannelSelection } from '../stores/channel-selection.ts'
import { communityChatStore } from '../stores/community-chat.ts'
import { useSession } from '../stores/session.ts'
import { setCommunityExpanded } from '../stores/sidebar-state.ts'

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

  const [showCreate, setShowCreate] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showPeople, setShowPeople] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  // The channel list lives in the sidebar on desktop and in this page on mobile,
  // so the selection is shared state rather than local to either.
  const selected = useChannelSelection((s) => s.byCommunity[communityId] ?? null)

  const sorted = [...channels].sort((a, b) => a.position - b.position)

  // Opening a community expands it in the conversation list and keeps it that way.
  useEffect(() => {
    setCommunityExpanded(communityId, true)
  }, [communityId])

  // Drop a selection that no longer exists (WS-driven refetch, deleted channel), but
  // never auto-pick one: opening a community should show the community.
  useEffect(() => {
    if (selected && !sorted.some((c) => c.channelId === selected)) {
      selectChannel(communityId, null)
    }
  }, [sorted, selected, communityId])

  const selectedChannel = sorted.find((c) => c.channelId === selected) ?? null
  const channelMeta = useDecryptedMeta<ChannelMeta>(
    communityId,
    selectedChannel?.metaCiphertext ?? null,
  )
  const channelTitle = selectedChannel
    ? (channelMeta?.title ?? channelFallbackTitle(selectedChannel.channelId))
    : null
  const channelDisplay = `${channelMeta?.emoji ? `${channelMeta.emoji} ` : ''}${channelTitle ?? ''}`
  // Manager rights for the open channel — the actions they unlock now live in the
  // header menu rather than a row of tabs above the conversation.
  const channelIsManager =
    !!selectedChannel &&
    (isLeader || (selectedChannel.myStatus === 'active' && selectedChannel.myRole === 'moderator'))
  const [view, setView] = useState<WorkspaceView>('chat')
  // A different channel always opens on its conversation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the open channel
  useEffect(() => {
    setView('chat')
    setShowInfo(false)
  }, [selected])

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['community', communityId] })
    void queryClient.invalidateQueries({ queryKey: ['communities'] })
  }

  // K_meta sync + rotation. Fetch our grant if the key is stale/missing; seed
  // grants to other member devices; and, if a member left and we're a leader,
  // rotate K_meta (re-encrypt metadata under a new epoch). Re-decrypt on change.
  const keyEpoch = detail?.community.keyEpoch
  const rotationPending = detail?.community.rotationPending ?? false
  const myRole = detail?.myRole
  const root = detail?.community.root ?? null
  const groupKeyKey = channels
    .filter((c) => c.encryptionMode === 'group_key')
    .map((c) => c.channelId)
    .join(',')
  useEffect(() => {
    if (keyEpoch === undefined || myRole === undefined) return
    let cancelled = false
    void (async () => {
      const obtained = await communityChatStore.syncKeyGrants(communityId, keyEpoch)
      const rotated =
        rotationPending && isLeader ? await communityChatStore.rotateCommunity(communityId) : false
      // Bootstrap the capability root (existing communities / no out-of-band pin):
      // owner publishes+pins if missing; a member TOFU-pins the verified server root.
      await communityChatStore.bootstrapOwnership(communityId, root, myRole)
      // Owner/leader: top up identity-signed membership caps for the roster at
      // this epoch (the counterpart to the key-grant top-up; idempotent).
      await communityChatStore.issueCapabilities(communityId, keyEpoch, myRole)
      // + channel-moderator caps for group_key channels (the rotation-minter authority).
      await communityChatStore.issueChannelModCaps(
        communityId,
        groupKeyKey ? groupKeyKey.split(',') : [],
        keyEpoch,
        myRole,
      )
      if ((obtained || rotated) && !cancelled) {
        void queryClient.invalidateQueries({ queryKey: ['community', communityId] })
        void queryClient.invalidateQueries({ queryKey: ['communities'] })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [communityId, keyEpoch, rotationPending, isLeader, myRole, root, groupKeyKey, queryClient])
  // groupKeyKey (a stable joined string) keys the group_key channel set for the effect.

  const deleteChannel = useMutation({
    mutationFn: (channelId: string) =>
      api('DELETE', `/api/v1/communities/${communityId}/channels/${channelId}`),
    onSuccess: (_data, channelId) => {
      void communityChatStore.forgetChannel(channelId)
      invalidate()
    },
  })

  const onDeleteChannel = (channelId: string) => deleteChannel.mutate(channelId)

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
    // On md+ the page fills the viewport and the channel pane flexes to the remaining
    // space (no magic-number height that overruns when a description / tab row is present).
    // On mobile it's normal document flow; the pane uses a dvh-based fallback height.
    <div className="flex h-full min-h-0 flex-col gap-3">
      <PageHeader
        // On a phone the Chats list is the sidebar: it expands a community into its
        // channels, so that is where "back" should land you.
        backTo={isDesktop ? '/communities' : '/'}
        avatar={
          selectedChannel ? (
            <CommunityAvatar
              communityId={communityId}
              mediaId={detail.community.avatarMediaId}
              label={communityName}
              size="sm"
            />
          ) : undefined
        }
        title={selectedChannel && channelTitle ? channelDisplay : ''}
        subtitle={selectedChannel ? communityName : undefined}
        meta={
          selectedChannel ? (
            <span
              className="flex items-center gap-1.5 text-xs text-ink-faint"
              title={t('chat.encrypted')}
            >
              <LockIcon size={13} />
              {t('chat.encrypted')}
            </span>
          ) : undefined
        }
        onToggle={selectedChannel ? () => setShowInfo((v) => !v) : undefined}
        expanded={showInfo}
        actions={
          <>
            <span
              className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${ROLE_BADGE[detail.myRole]}`}
            >
              {t(`communities.roles.${detail.myRole}`)}
            </span>
            <MenuButton
              items={[
                ...(selectedChannel && view !== 'chat'
                  ? [{ label: t('communities.viewChat'), onSelect: () => setView('chat') }]
                  : []),
                ...(selectedChannel
                  ? [
                      {
                        label: t('communities.viewCommunity'),
                        onSelect: () => selectChannel(communityId, null),
                      },
                    ]
                  : []),
                ...(selectedChannel && channelIsManager
                  ? [
                      { label: t('communities.moderation'), onSelect: () => setView('moderation') },
                      {
                        label: t('communities.channelSettings'),
                        onSelect: () => setView('settings'),
                      },
                    ]
                  : []),
                ...(!isDesktop
                  ? [
                      { label: t('communities.members'), onSelect: () => setShowPeople(true) },
                      ...(isLeader
                        ? [
                            {
                              label: t('communities.addChannel'),
                              onSelect: () => setShowCreate(true),
                            },
                            {
                              label: t('communities.communitySettings'),
                              onSelect: () => setShowSettings((v) => !v),
                            },
                          ]
                        : []),
                    ]
                  : isLeader
                    ? [
                        { label: t('communities.addChannel'), onSelect: () => setShowCreate(true) },
                        {
                          label: t('communities.communitySettings'),
                          onSelect: () => setShowSettings((v) => !v),
                        },
                      ]
                    : []),
              ]}
            />
          </>
        }
      />

      {showInfo && selectedChannel && channelTitle && (
        <ChannelInfo
          channel={selectedChannel}
          title={channelTitle}
          description={channelMeta?.description}
          communityDescription={communityMeta?.description}
        />
      )}

      {showSettings && isLeader && (
        <CommunitySettingsForm
          key={communityMeta ? 'loaded' : 'empty'}
          communityId={communityId}
          initialMeta={communityMeta}
          avatarMediaId={detail.community.avatarMediaId}
          communityName={communityName}
          maxDevicesPerMember={detail.community.maxDevicesPerMember}
          onDone={() => {
            setShowSettings(false)
            invalidate()
          }}
          onCancel={() => setShowSettings(false)}
        />
      )}

      {showCreate && isLeader && (
        <ChannelSettingsForm
          communityId={communityId}
          mode="create"
          onDone={(channelId) => {
            setShowCreate(false)
            invalidate()
            if (channelId) selectChannel(communityId, channelId)
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {/* One pane at a time on mobile: the conversation, or the people behind it.
            Channels are reached from the Chats list, which expands a community into
            its channels — the phone's equivalent of the desktop sidebar. */}
        {!isDesktop && showPeople ? (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
            <button
              type="button"
              className="btn-quiet text-xs"
              onClick={() => setShowPeople(false)}
            >
              ← {t('communities.backToChat')}
            </button>
            <MemberPanel
              communityId={communityId}
              myRole={detail.myRole}
              myAccountId={myAccountId}
              members={detail.members}
              memberCount={detail.memberCount}
              memberBucket={detail.memberBucket}
              channelIds={sorted.map((c) => c.channelId)}
            />
            {isLeader && <InvitePanel communityId={communityId} />}
          </div>
        ) : selectedChannel ? (
          <ChannelWorkspace
            key={selectedChannel.channelId}
            communityId={communityId}
            channel={selectedChannel}
            isLeader={isLeader}
            myAccountId={myAccountId}
            members={detail.members}
            onChanged={invalidate}
            onDeleteChannel={onDeleteChannel}
            view={view}
            onCloseView={() => setView('chat')}
          />
        ) : (
          <CommunityOverview communityId={communityId} detail={detail} meta={communityMeta} />
        )}
      </div>
    </div>
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
  view,
  onCloseView,
}: {
  communityId: string
  channel: CommunityChannel
  isLeader: boolean
  myAccountId: string | null
  members: CommunityDetailResponse['members']
  onChanged: () => void
  onDeleteChannel: (channelId: string) => void
  /** which pane the header menu selected */
  view: WorkspaceView
  onCloseView: () => void
}) {
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
    <div className="flex h-full min-h-0 flex-col gap-3">
      {view === 'chat' && (
        <ChannelChat
          communityId={communityId}
          channelId={channel.channelId}
          pinPolicy={channel.pinPolicy}
          canPost={canPost}
          isManager={isManager}
          muted={channel.muted}
          messageTtlDays={channel.messageTtlDays}
        />
      )}

      {view === 'moderation' && isManager && (
        <ModerationPanel
          communityId={communityId}
          channelId={channel.channelId}
          pinPolicy={channel.pinPolicy}
          isLeader={isLeader}
          members={members}
          myAccountId={myAccountId}
          onChanged={onChanged}
        />
      )}

      {view === 'settings' && canEdit && (
        <div className="card min-h-0 flex-1 overflow-y-auto">
          <ChannelSettingsForm
            key={meta ? 'loaded' : 'empty'}
            communityId={communityId}
            mode="edit"
            channel={channel}
            initialMeta={meta}
            onDone={() => {
              onCloseView()
              onChanged()
            }}
            onCancel={onCloseView}
            canDelete={isLeader}
            onDelete={() => onDeleteChannel(channel.channelId)}
          />
        </div>
      )}
    </div>
  )
}

function CommunitySettingsForm({
  communityId,
  initialMeta,
  avatarMediaId,
  communityName,
  maxDevicesPerMember,
  onDone,
  onCancel,
}: {
  communityId: string
  initialMeta: CommunityMeta | null
  avatarMediaId: string | null
  communityName: string
  maxDevicesPerMember: number
  onDone: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(initialMeta?.name ?? '')
  const [description, setDescription] = useState(initialMeta?.description ?? '')
  const [media, setMedia] = useState<string | null>(avatarMediaId)
  const [deviceLimit, setDeviceLimit] = useState(maxDevicesPerMember)
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
      if (deviceLimit !== maxDevicesPerMember) body.maxDevicesPerMember = deviceLimit
      // PATCH requires at least one field — nothing to change if K_meta is
      // absent and the avatar is untouched.
      if (
        body.metaCiphertext === undefined &&
        body.avatarMediaId === undefined &&
        body.maxDevicesPerMember === undefined
      ) {
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
      <label className="block space-y-1">
        <span className="text-xs text-ink-soft">{t('communities.deviceLimit.communityLabel')}</span>
        <select
          className="w-full bg-overlay border border-edge rounded-md px-3 py-2 text-sm"
          value={deviceLimit}
          onChange={(e) => setDeviceLimit(Number(e.target.value))}
        >
          {Array.from({ length: COMMUNITY_DEVICE_LIMIT_MAX }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {t('communities.deviceLimit.perMember', { count: n })}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-ink-faint">{t('communities.deviceLimit.communityHint')}</p>
      </label>

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
