import type {
  ChannelAccess,
  ChannelEncryptionMode,
  ChannelJoinPolicy,
  ChannelMemberListVisibility,
  ChannelPinPolicy,
  ChannelPostPolicy,
  ChannelVisibility,
  CommunityChannel,
  CreateChannelResponse,
  UpdateChannelRequest,
} from '@gathernet/shared'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api.ts'
import { type ChannelMeta, getKMeta, sealMeta } from '../../lib/community-keys.ts'
import { communityChatStore } from '../../stores/community-chat.ts'
import { AvatarUploader } from './CommunityAvatar.tsx'

/**
 * Disappearing-message TTL choices (mirrors shared CHANNEL_MESSAGE_TTL_DAYS).
 * Kept as literal i18n keys so the typed `t()` accepts them.
 */
const TTL_OPTIONS = [
  { days: 1, key: 'communities.ttl24h' },
  { days: 3, key: 'communities.ttl3d' },
  { days: 7, key: 'communities.ttl7d' },
  { days: 14, key: 'communities.ttl14d' },
  { days: 30, key: 'communities.ttl30d' },
] as const

const SELECT_CLASS = 'w-full bg-overlay border border-edge rounded-md px-3 py-2 text-sm'

/**
 * The channel KIND a leader picks — the product concept, which presets the crypto mode and
 * who may post. Chosen once at creation: there is no migration between kinds (a SECURITY
 * decision, not a technical one — moving a small MLS channel onto a shared group key would
 * silently weaken it, so we block at the cap and warn instead).
 */
export type ChannelKind = 'small' | 'large' | 'broadcast'

const CHANNEL_KINDS = [
  {
    kind: 'small',
    encryptionMode: 'mls',
    postPolicy: 'everyone',
    label: 'communities.channelKind.small',
    hint: 'communities.channelKind.smallHint',
  },
  {
    kind: 'large',
    encryptionMode: 'group_key',
    postPolicy: 'everyone',
    label: 'communities.channelKind.large',
    hint: 'communities.channelKind.largeHint',
  },
  {
    kind: 'broadcast',
    encryptionMode: 'group_key',
    postPolicy: 'moderators',
    label: 'communities.channelKind.broadcast',
    hint: 'communities.channelKind.broadcastHint',
  },
] as const satisfies ReadonlyArray<{
  kind: ChannelKind
  encryptionMode: ChannelEncryptionMode
  postPolicy: ChannelPostPolicy
  label: string
  hint: string
}>

interface ChannelSettingsFormProps {
  communityId: string
  mode: 'create' | 'edit'
  /** existing channel (edit mode) — provides current settings */
  channel?: CommunityChannel
  /** decrypted channel meta for prefill (edit mode) */
  initialMeta?: ChannelMeta | null
  /** called after a successful create/edit; create passes the new channelId */
  onDone: (channelId?: string) => void
  onCancel: () => void
  /** leaders only, edit mode — show the delete affordance */
  canDelete?: boolean
  onDelete?: () => void
}

/**
 * Create/edit form for a community channel. Seals the display metadata
 * (title/emoji/markdown description) under the community K_meta and sends the
 * plaintext settings (access/visibility/join policy/TTL). On create it also
 * publishes the epoch-0 GroupInfo so members can external-join.
 */
export function ChannelSettingsForm({
  communityId,
  mode,
  channel,
  initialMeta,
  onDone,
  onCancel,
  canDelete,
  onDelete,
}: ChannelSettingsFormProps) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(initialMeta?.title ?? '')
  const [emoji, setEmoji] = useState(initialMeta?.emoji ?? '')
  const [description, setDescription] = useState(initialMeta?.description ?? '')
  const [access, setAccess] = useState<ChannelAccess>(channel?.access ?? 'members')
  const [visibility, setVisibility] = useState<ChannelVisibility>(channel?.visibility ?? 'listed')
  const [joinPolicy, setJoinPolicy] = useState<ChannelJoinPolicy>(channel?.joinPolicy ?? 'open')
  const [postPolicy, setPostPolicy] = useState<ChannelPostPolicy>(channel?.postPolicy ?? 'everyone')
  const [pinPolicy, setPinPolicy] = useState<ChannelPinPolicy>(channel?.pinPolicy ?? 'everyone')
  const [memberListVisibility, setMemberListVisibility] = useState<ChannelMemberListVisibility>(
    channel?.memberListVisibility ?? 'managers',
  )
  // In create mode, let the pin policy track the encryption-mode default (mls →
  // everyone, group_key → moderators) until the user explicitly overrides it.
  const [pinPolicyTouched, setPinPolicyTouched] = useState(false)
  // Encryption mode is fixed at creation (no migration between modes).
  const [encryptionMode, setEncryptionMode] = useState<ChannelEncryptionMode>(
    channel?.encryptionMode ?? 'mls',
  )
  // The channel KIND is the concept a leader actually picks; it presets the crypto mode +
  // who may post. Derived for an existing channel so the edit form reads correctly.
  const [channelKind, setChannelKind] = useState<ChannelKind>(
    channel
      ? channel.encryptionMode === 'mls'
        ? 'small'
        : channel.postPolicy === 'moderators'
          ? 'broadcast'
          : 'large'
      : 'small',
  )

  /** Picking a kind sets the underlying crypto mode + post policy together. */
  const applyKind = (kind: ChannelKind) => {
    setChannelKind(kind)
    const preset = CHANNEL_KINDS.find((k) => k.kind === kind)
    if (!preset) return
    setEncryptionMode(preset.encryptionMode)
    setPostPolicy(preset.postPolicy)
    // A big channel can't expose a roster to members — keep the setting honest.
    if (preset.encryptionMode === 'group_key') setMemberListVisibility('managers')
  }
  const effectivePinPolicy: ChannelPinPolicy =
    mode === 'create' && !pinPolicyTouched
      ? encryptionMode === 'group_key'
        ? 'moderators'
        : 'everyone'
      : pinPolicy
  const [ttl, setTtl] = useState<number>(channel?.messageTtlDays ?? 30)
  const [avatarMediaId, setAvatarMediaId] = useState<string | null>(channel?.avatarMediaId ?? null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const trimmed = title.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      const kMeta = await getKMeta(communityId)
      const meta: ChannelMeta = {
        title: trimmed,
        ...(emoji.trim() ? { emoji: emoji.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      }
      const metaCiphertext = kMeta ? await sealMeta(kMeta, meta) : undefined

      if (mode === 'create') {
        const res = await api<CreateChannelResponse>(
          'POST',
          `/api/v1/communities/${communityId}/channels`,
          {
            ...(metaCiphertext ? { metaCiphertext } : {}),
            ...(avatarMediaId ? { avatarMediaId } : {}),
            access,
            visibility,
            joinPolicy,
            postPolicy,
            pinPolicy: effectivePinPolicy,
            memberListVisibility,
            messageTtlDays: ttl,
            encryptionMode,
          },
        )
        // The creator's first act: establish the channel's key material. mls →
        // publish epoch-0 GroupInfo; group_key → mint + grant K_channel.
        const bootstrap =
          encryptionMode === 'group_key'
            ? communityChatStore.bootstrapGroupKey(communityId, res.channelId)
            : communityChatStore.bootstrapChannel(res.channelId)
        await bootstrap.catch((err) => {
          console.error('channel bootstrap failed', err)
        })
        onDone(res.channelId)
      } else if (channel) {
        const body: UpdateChannelRequest = {
          ...(metaCiphertext ? { metaCiphertext } : {}),
          access,
          visibility,
          joinPolicy,
          postPolicy,
          pinPolicy: effectivePinPolicy,
          memberListVisibility,
          messageTtlDays: ttl,
        }
        if (avatarMediaId !== channel.avatarMediaId) {
          body.avatarMediaId = avatarMediaId as UpdateChannelRequest['avatarMediaId']
        }
        await api('PATCH', `/api/v1/communities/${communityId}/channels/${channel.channelId}`, body)
        onDone()
      }
    } catch (err) {
      console.error('channel save failed', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="space-y-3 border border-edge rounded-md p-3 bg-overlay/40"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="flex gap-2">
        <input
          value={emoji}
          onChange={(e) => setEmoji(e.target.value)}
          placeholder={t('communities.channelEmojiPlaceholder')}
          maxLength={8}
          className="w-16 text-center"
          aria-label={t('communities.channelEmojiPlaceholder')}
        />
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('communities.channelTitlePlaceholder')}
          maxLength={80}
          autoFocus
        />
      </div>

      <div className="space-y-1">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('communities.channelDescriptionPlaceholder')}
          maxLength={2000}
          rows={3}
        />
        <p className="text-[11px] text-ink-faint">{t('communities.markdownHint')}</p>
      </div>

      {mode === 'create' && (
        <label className="block space-y-1">
          <span className="text-xs text-ink-soft">{t('communities.channelKind.label')}</span>
          <select
            className={SELECT_CLASS}
            value={channelKind}
            onChange={(e) => applyKind(e.target.value as ChannelKind)}
          >
            {CHANNEL_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {t(k.label)}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-ink-faint">
            {t(
              CHANNEL_KINDS.find((k) => k.kind === channelKind)?.hint ??
                'communities.channelKind.smallHint',
            )}
          </p>
        </label>
      )}
      {/* Existing channel: the kind is fixed (no migration between modes — a security
          decision, not a technical one), so just state what this channel is. */}
      {mode === 'edit' && channel && (
        <p className="text-[11px] text-ink-faint">
          {t(
            channel.encryptionMode === 'mls'
              ? 'communities.channelKind.isSmall'
              : channel.postPolicy === 'moderators'
                ? 'communities.channelKind.isBroadcast'
                : 'communities.channelKind.isLarge',
          )}
        </p>
      )}

      <label className="block space-y-1">
        <span className="text-xs text-ink-soft">{t('communities.access.label')}</span>
        <select
          className={SELECT_CLASS}
          value={access}
          onChange={(e) => setAccess(e.target.value as ChannelAccess)}
        >
          <option value="members">{t('communities.access.members')}</option>
          <option value="leaders">{t('communities.access.leaders')}</option>
        </select>
      </label>

      <label className="block space-y-1">
        <span className="text-xs text-ink-soft">{t('communities.visibility.label')}</span>
        <select
          className={SELECT_CLASS}
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as ChannelVisibility)}
        >
          <option value="listed">{t('communities.visibility.listed')}</option>
          <option value="unlisted">{t('communities.visibility.unlisted')}</option>
        </select>
      </label>

      <label className="block space-y-1">
        <span className="text-xs text-ink-soft">{t('communities.joinPolicy.label')}</span>
        <select
          className={SELECT_CLASS}
          value={joinPolicy}
          onChange={(e) => setJoinPolicy(e.target.value as ChannelJoinPolicy)}
        >
          <option value="open">{t('communities.joinPolicy.open')}</option>
          <option value="request">{t('communities.joinPolicy.request')}</option>
        </select>
      </label>

      <label className="block space-y-1">
        <span className="text-xs text-ink-soft">{t('communities.postPolicy.label')}</span>
        <select
          className={SELECT_CLASS}
          value={postPolicy}
          onChange={(e) => setPostPolicy(e.target.value as ChannelPostPolicy)}
        >
          <option value="everyone">{t('communities.postPolicy.everyone')}</option>
          <option value="moderators">{t('communities.postPolicy.moderators')}</option>
        </select>
      </label>

      <label className="block space-y-1">
        <span className="text-xs text-ink-soft">{t('communities.pinPolicy.label')}</span>
        <select
          className={SELECT_CLASS}
          value={effectivePinPolicy}
          onChange={(e) => {
            setPinPolicy(e.target.value as ChannelPinPolicy)
            setPinPolicyTouched(true)
          }}
        >
          <option value="everyone">{t('communities.pinPolicy.everyone')}</option>
          <option value="moderators">{t('communities.pinPolicy.moderators')}</option>
        </select>
        <p className="text-[11px] text-ink-faint">
          {effectivePinPolicy === 'everyone'
            ? t('communities.pinPolicy.everyoneHint')
            : t('communities.pinPolicy.moderatorsHint')}
        </p>
      </label>

      {/* Only a small (mls) channel can show its roster to members; a big/broadcast channel
          never does, so the setting is hidden rather than misleading. */}
      {encryptionMode === 'mls' && (
        <label className="block space-y-1">
          <span className="text-xs text-ink-soft">{t('communities.memberList.label')}</span>
          <select
            className={SELECT_CLASS}
            value={memberListVisibility}
            onChange={(e) => setMemberListVisibility(e.target.value as ChannelMemberListVisibility)}
          >
            <option value="managers">{t('communities.memberList.managers')}</option>
            <option value="members">{t('communities.memberList.members')}</option>
          </select>
          <p className="text-[11px] text-ink-faint">
            {memberListVisibility === 'managers'
              ? t('communities.memberList.managersHint')
              : t('communities.memberList.membersHint')}
          </p>
        </label>
      )}

      <label className="block space-y-1">
        <span className="text-xs text-ink-soft">{t('communities.disappearingMessages')}</span>
        <select
          className={SELECT_CLASS}
          value={ttl}
          onChange={(e) => setTtl(Number(e.target.value))}
        >
          {TTL_OPTIONS.map(({ days, key }) => (
            <option key={days} value={days}>
              {t(key)}
            </option>
          ))}
        </select>
      </label>

      <div className="space-y-1">
        <span className="text-xs text-ink-soft">{t('communities.channelAvatar')}</span>
        <AvatarUploader
          communityId={communityId}
          currentMediaId={avatarMediaId}
          label={title || '#'}
          onUploaded={setAvatarMediaId}
        />
      </div>

      <div className="flex gap-2">
        <button type="submit" className="btn-gold flex-1 text-sm" disabled={!title.trim() || busy}>
          {mode === 'create' ? t('communities.createChannel') : t('common.save')}
        </button>
        <button type="button" className="btn-quiet text-sm" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>

      {mode === 'edit' && canDelete && onDelete && (
        <button type="button" className="btn-danger w-full text-sm" onClick={onDelete}>
          {t('communities.deleteChannel')}
        </button>
      )}
    </form>
  )
}
