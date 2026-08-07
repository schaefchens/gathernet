import type {
  CommunityChannel,
  CommunityDetailResponse,
  UpdateCommunityRequest,
} from '@gathernet/shared'
import { COMMUNITY_DEVICE_LIMIT_MAX } from '@gathernet/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CommunityIcon, LockIcon } from '../components/icons.tsx'
import { ChannelChat } from '../features/communities/ChannelChat.tsx'
import { ChannelJoinPanel } from '../features/communities/ChannelJoinPanel.tsx'
import { ChannelList } from '../features/communities/ChannelList.tsx'
import { ChannelSettingsForm } from '../features/communities/ChannelSettingsForm.tsx'
import { ClampedMarkdown } from '../features/communities/ClampedMarkdown.tsx'
import { AvatarUploader, CommunityAvatar } from '../features/communities/CommunityAvatar.tsx'
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

export const Route = createFileRoute('/communities/$communityId')({
  component: CommunityDetailScreen,
})

const ROLE_BADGE = {
  owner: 'text-gold border-gold',
  leader: 'text-indigo-soft border-indigo-soft',
  member: 'text-ink-soft border-edge',
} as const

/** Coarse size bands, shown instead of a count when a community is too large for a
 *  roster. Mirrors MemberPanel — the typed t() needs literal keys. */
const BUCKET_KEY = {
  few: 'communities.sizeFew',
  dozens: 'communities.sizeDozens',
  hundreds: 'communities.sizeHundreds',
  thousands: 'communities.sizeThousands',
  tensOfThousands: 'communities.sizeTensOfThousands',
  hundredsOfThousands: 'communities.sizeHundredsOfThousands',
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
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  // The channel list lives in the sidebar on desktop and in this page on mobile,
  // so the selection is shared state rather than local to either.
  const selected = useChannelSelection((s) => s.byCommunity[communityId] ?? null)

  const sorted = [...channels].sort((a, b) => a.position - b.position)

  // Keep the selection valid as channels appear/disappear (WS-driven refetch).
  useEffect(() => {
    if (sorted.length === 0) {
      selectChannel(communityId, null)
      return
    }
    if (!selected || !sorted.some((c) => c.channelId === selected)) {
      selectChannel(communityId, sorted[0]?.channelId ?? null)
    }
  }, [sorted, selected, communityId])

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
    <div className="space-y-4 md:h-[calc(100dvh-7rem)] md:flex md:flex-col md:gap-4 md:space-y-0">
      <div className="card space-y-3 p-4">
        <div className="flex items-center gap-3">
          <Link
            to="/communities"
            className="text-ink-soft hover:text-gold-bright"
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
          <h1 className="flex-1 font-display text-2xl truncate text-gold-bright">
            {communityName}
          </h1>
          <span
            className={`shrink-0 text-[10px] uppercase tracking-wide border rounded px-1.5 py-0.5 ${ROLE_BADGE[detail.myRole]}`}
          >
            {t(`communities.roles.${detail.myRole}`)}
          </span>
        </div>

        {/* Trust chips. Only claims that are actually true: the transport really is
            end-to-end encrypted, and the size is the exact roster count for small
            communities or the coarse band for large ones — large communities expose
            no roster at all, so there is no number to show. */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="chip-row flex-1">
            <span className="chip">
              <LockIcon size={16} />
              {t('chat.encrypted')}
            </span>
            <span className="chip">
              <CommunityIcon size={16} />
              {detail.memberCount !== null
                ? t('communities.memberCount', { count: detail.memberCount })
                : t(BUCKET_KEY[detail.memberBucket])}
            </span>
          </div>
          {isLeader && (
            <>
              <button
                type="button"
                className="btn-quiet shrink-0 text-xs px-2 py-1"
                onClick={() => setShowCreate((s) => !s)}
              >
                {t('communities.addChannel')}
              </button>
              <button
                type="button"
                className="btn-quiet shrink-0 text-xs px-2 py-1"
                onClick={() => setShowSettings((s) => !s)}
              >
                {t('communities.communitySettings')}
              </button>
            </>
          )}
        </div>

        {communityMeta?.description && !showSettings && (
          <ClampedMarkdown
            text={communityMeta.description}
            className="text-sm text-ink-soft [&_p]:mb-2 [&_ul]:mb-2"
          />
        )}
      </div>

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

      {/* Below `md` there is no sidebar, so the channel switcher lives here —
          above the conversation, since that is what you came for. */}
      {!isDesktop && (
        <section className="card space-y-2 p-3">
          <h2 className="section-label">{t('communities.channels')}</h2>
          <ChannelList communityId={communityId} />
        </section>
      )}

      <div className="flex flex-col gap-4 md:flex-1 md:min-h-0 md:flex-row">
        <div className="min-w-0 flex-1 md:flex md:min-h-0 md:flex-col">
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
            <div className="card grid place-items-center h-[50vh] md:h-auto md:flex-1 text-ink-soft">
              {t('communities.selectChannel')}
            </div>
          )}
        </div>

        {/* Who is here and how to invite them — a companion panel, not a column
            the conversation has to share space with. */}
        <aside className="space-y-4 md:w-[320px] md:shrink-0 md:overflow-y-auto md:min-h-0">
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
        </aside>
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
    <div className="space-y-3 md:h-full md:flex md:flex-col md:gap-3 md:space-y-0 md:min-h-0">
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
          pinPolicy={channel.pinPolicy}
          canPost={canPost}
          isManager={isManager}
          muted={channel.muted}
          description={meta?.description}
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
        <div className="card overflow-y-auto h-[calc(100dvh-13rem)] md:h-auto md:flex-1 md:min-h-0">
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
