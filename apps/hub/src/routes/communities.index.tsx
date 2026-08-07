import type {
  AcceptCommunityInviteResponse,
  CommunityListItem,
  CommunityRole,
  CreateCommunityResponse,
} from '@gathernet/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MenuButton } from '../components/MenuButton.tsx'
import { PageHeader } from '../components/PageHeader.tsx'
import { QrScanner } from '../components/QrScanner.tsx'
import { CommunityAvatar } from '../features/communities/CommunityAvatar.tsx'
import { useDecryptedMeta } from '../features/communities/meta.ts'
import { ApiError, api } from '../lib/api.ts'
import {
  COMMUNITY_INVITE_SCHEME,
  type CommunityMeta,
  generateKMeta,
  parseInvite,
  rememberKMeta,
  sealMeta,
} from '../lib/community-keys.ts'
import { DESKTOP_QUERY, useMediaQuery } from '../lib/use-media-query.ts'
import { selectChannel } from '../stores/channel-selection.ts'
import { communityChatStore } from '../stores/community-chat.ts'

export const Route = createFileRoute('/communities/')({
  component: CommunitiesScreen,
  /** `?join` arrives from the "Join a community" action, which should land on the
   *  code form rather than on a list and a button to press. */
  validateSearch: (search: Record<string, unknown>): { join?: boolean } =>
    search.join === true || search.join === 'true' ? { join: true } : {},
})

const ROLE_BADGE: Record<CommunityRole, string> = {
  owner: 'text-gold border-gold',
  leader: 'text-indigo-soft border-indigo-soft',
  member: 'text-ink-soft border-edge',
}

type Panel = 'none' | 'create' | 'join'

function CommunitiesScreen() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { join } = Route.useSearch()
  const [panel, setPanel] = useState<Panel>(join ? 'join' : 'none')
  const isDesktop = useMediaQuery(DESKTOP_QUERY)

  // Follows the intent in both directions: arriving with `?join` opens the form even
  // when the screen is already mounted, and navigating here plainly afterwards gives
  // a clean list rather than a form left open from last time.
  useEffect(() => {
    setPanel(join ? 'join' : 'none')
  }, [join])

  const communities = useQuery({
    queryKey: ['communities'],
    queryFn: () => api<{ communities: CommunityListItem[] }>('GET', '/api/v1/communities'),
  })
  const list = communities.data?.communities ?? []

  // On a device that joined via a bare code or was restored from the phrase,
  // pull any K_meta grants so the list decrypts names instead of placeholders.
  // Fetch-only (no granting) to keep the list cheap; granting happens on open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the loaded id set; queryClient is stable.
  useEffect(() => {
    if (list.length === 0) return
    let cancelled = false
    void (async () => {
      let any = false
      for (const c of list) {
        if (await communityChatStore.fetchKeyGrant(c.communityId, c.keyEpoch)) any = true
      }
      if (any && !cancelled) void queryClient.invalidateQueries({ queryKey: ['communities'] })
    })()
    return () => {
      cancelled = true
    }
  }, [list.map((c) => c.communityId).join(','), queryClient])

  return (
    <div className="space-y-4">
      <PageHeader
        backTo="/"
        title={t('communities.title')}
        actions={
          // Side by side these two wrap to four lines and run off an iPhone SE, so
          // below md they fold into the overflow menu instead.
          isDesktop ? (
            <>
              <button
                type="button"
                className="btn-quiet text-sm"
                onClick={() => setPanel(panel === 'join' ? 'none' : 'join')}
              >
                {t('communities.joinWithCode')}
              </button>
              <button
                type="button"
                className="btn-gold text-sm"
                onClick={() => setPanel(panel === 'create' ? 'none' : 'create')}
              >
                {t('communities.create')}
              </button>
            </>
          ) : (
            <MenuButton
              items={[
                {
                  label: t('communities.joinWithCode'),
                  onSelect: () => setPanel(panel === 'join' ? 'none' : 'join'),
                },
                {
                  label: t('communities.create'),
                  onSelect: () => setPanel(panel === 'create' ? 'none' : 'create'),
                },
              ]}
            />
          )
        }
      />

      {panel === 'create' && <CreatePanel onDone={() => setPanel('none')} />}
      {panel === 'join' && <JoinPanel onDone={() => setPanel('none')} />}

      {communities.isLoading && <p className="text-ink-soft">{t('common.loading')}</p>}
      {communities.data && list.length === 0 && panel === 'none' && (
        <div className="card text-center text-ink-soft py-12">{t('communities.empty')}</div>
      )}

      <ul className="space-y-2">
        {list.map((community) => (
          <li key={community.communityId}>
            <CommunityCard community={community} roleBadge={ROLE_BADGE[community.myRole]} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function CommunityCard({
  community,
  roleBadge,
}: {
  community: CommunityListItem
  roleBadge: string
}) {
  const { t } = useTranslation()
  const meta = useDecryptedMeta<CommunityMeta>(community.communityId, community.metaCiphertext)
  const name = meta?.name ?? t('communities.encryptedName')

  return (
    <Link
      to="/communities/$communityId"
      params={{ communityId: community.communityId }}
      className="card flex items-center gap-3 py-3 transition-colors hover:border-gold"
      // Opening a community means the community, not whichever channel you were last
      // reading in it — same rule as the row in the conversation list.
      onClick={() => selectChannel(community.communityId, null)}
    >
      <CommunityAvatar
        communityId={community.communityId}
        mediaId={community.avatarMediaId}
        label={name}
        size="md"
      />
      <span className="flex-1 min-w-0">
        <span className="font-medium block truncate">{name}</span>
        <span className="text-xs text-ink-faint">
          {t('communities.channelCount', { count: community.channelCount })}
        </span>
      </span>
      <span
        className={`text-[10px] uppercase tracking-wide border rounded px-1.5 py-0.5 ${roleBadge}`}
      >
        {t(`communities.roles.${community.myRole}`)}
      </span>
    </Link>
  )
}

function CreatePanel({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const create = useMutation({
    mutationFn: async () => {
      const kMeta = generateKMeta()
      const meta: CommunityMeta = {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      }
      const metaCiphertext = await sealMeta(kMeta, meta)
      const res = await api<CreateCommunityResponse>('POST', '/api/v1/communities', {
        metaCiphertext,
      })
      await rememberKMeta(res.communityId, kMeta, 0)
      // Owner signs + publishes the ownership root (capability-chain anchor) + pins self.
      await communityChatStore.publishCommunityRoot(res.communityId)
      return res
    },
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['communities'] })
      onDone()
      void navigate({ to: '/communities/$communityId', params: { communityId: res.communityId } })
    },
  })

  return (
    <form
      className="card space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) create.mutate()
      }}
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('communities.namePlaceholder')}
        maxLength={80}
        autoFocus
      />
      {/* A textarea, matching the settings form: a single-line input silently ate
          newlines, so a description written with paragraphs and bullets arrived as
          one run-on line and rendered that way forever after. */}
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
      <button type="submit" className="btn-gold w-full" disabled={!name.trim() || create.isPending}>
        {t('communities.create')}
      </button>
    </form>
  )
}

function JoinPanel({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [code, setCode] = useState('')
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const accept = async (raw: string) => {
    setError(null)
    const { code: parsedCode, kMeta, epoch, ownerAccountId } = parseInvite(raw)
    try {
      const res = await api<AcceptCommunityInviteResponse>(
        'POST',
        '/api/v1/communities/invites/accept',
        { code: parsedCode },
      )
      if (kMeta) await rememberKMeta(res.communityId, kMeta, epoch)
      // Pin the owner from the out-of-band invite (capability-chain trust anchor).
      if (ownerAccountId)
        await communityChatStore.pinCommunityOwner(res.communityId, ownerAccountId)
      void queryClient.invalidateQueries({ queryKey: ['communities'] })
      onDone()
      void navigate({
        to: '/communities/$communityId',
        params: { communityId: res.communityId },
      })
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'already_member'
          ? t('communities.alreadyMember')
          : t('communities.invalidCode'),
      )
    }
  }

  return (
    <div className="card space-y-3">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void accept(code)
        }}
      >
        <input
          value={code}
          onChange={(e) => {
            // Auto-uppercase a bare code, but leave a full invite payload
            // untouched — its K_meta fragment is case-sensitive base64url.
            const v = e.target.value
            setCode(v.includes('#') || v.includes(':') ? v : v.toUpperCase())
          }}
          placeholder={t('communities.codePlaceholder')}
          className="text-center font-mono text-xl tracking-[0.2em]"
          autoFocus
          autoComplete="off"
        />
        {error && <p className="text-sm text-danger text-center">{error}</p>}
        <button type="submit" className="btn-gold w-full" disabled={code.trim().length < 10}>
          {t('communities.join')}
        </button>
      </form>
      <button
        type="button"
        className="btn-quiet w-full text-sm"
        onClick={() => setScanning((s) => !s)}
      >
        {scanning ? t('common.cancel') : t('communities.scan')}
      </button>
      {scanning && (
        <QrScanner
          prefixes={[COMMUNITY_INVITE_SCHEME]}
          onCode={(payload) => void accept(payload)}
        />
      )}
    </div>
  )
}
