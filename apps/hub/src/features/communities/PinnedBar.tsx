import type { ChannelPinPolicy } from '@gathernet/shared'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '../../lib/api.ts'
import type { ArtifactBody, VerifiedArtifact } from '../../lib/artifacts.ts'
import { encryptAndUpload } from '../../lib/media.ts'
import { wsClient } from '../../lib/ws-client.ts'
import { channelArtifactsStore, useChannelArtifacts } from '../../stores/channel-artifacts.ts'
import { MediaAttachment } from '../chat/MediaAttachment.tsx'

const EMPTY: VerifiedArtifact[] = []

/** Emoji marker for each artifact kind. */
const KIND_ICON: Record<ArtifactBody['kind'], string> = {
  pin: '📌',
  link: '🔗',
  media: '📎',
  event: '📅',
  rollcall: '🙋',
}

/** A short locale-aware "in 2h / in 3d" for a pin's expiry, or null if none. */
function relativeExpiry(expiresAt: number | null, locale: string): string | null {
  if (expiresAt === null) return null
  const ms = expiresAt - Date.now()
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' })
  const mins = Math.round(ms / 60_000)
  if (Math.abs(mins) < 60) return rtf.format(mins, 'minute')
  const hours = Math.round(ms / 3_600_000)
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour')
  return rtf.format(Math.round(ms / 86_400_000), 'day')
}

/** A one-line summary of an artifact body for the compact pinned card. */
function summarize(body: ArtifactBody, attachmentLabel: string): string {
  switch (body.kind) {
    case 'pin':
      return body.note || body.text || (body.media ? attachmentLabel : '')
    case 'link':
      return body.title || body.url
    case 'media':
      return body.caption || body.media.name || attachmentLabel
    case 'event':
      return body.title
    case 'rollcall':
      return body.prompt || ''
  }
}

/**
 * The sticky pinned-artifacts bar at the top of a channel. Shows active pins
 * (newest first, collapsible) that every visitor sees; managers additionally see a
 * "suggested pins" queue with approve/dismiss. Members can create link/media pins
 * directly via the ＋ affordance. Tapping a message-pin scrolls to its source.
 */
export function PinnedBar({
  communityId,
  channelId,
  pinPolicy,
  isManager,
  canCreate,
  myAccountId,
  onJump,
}: {
  communityId: string
  channelId: string
  pinPolicy: ChannelPinPolicy
  isManager: boolean
  /** the current user may create/suggest pins here */
  canCreate: boolean
  myAccountId: string | null
  onJump: (messageId: string) => void
}) {
  const { t, i18n } = useTranslation()
  const artifacts = useChannelArtifacts((s) => s.byChannel[channelId] ?? EMPTY)
  const [collapsed, setCollapsed] = useState(false)
  const [composeMode, setComposeMode] = useState<'none' | 'link' | 'event'>('none')
  const [linkUrl, setLinkUrl] = useState('')
  const [linkTitle, setLinkTitle] = useState('')
  const [ev, setEv] = useState({
    title: '',
    starts: '',
    ends: '',
    location: '',
    url: '',
    remindOffsetMin: 60,
  })
  const [busy, setBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [tick, setTick] = useState(() => Date.now())
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composing = composeMode !== 'none'

  const reload = () => channelArtifactsStore.load(communityId, channelId, pinPolicy)

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is derived from stable ids
  useEffect(() => {
    void reload()
    const off = wsClient.on('community.channel_artifact_updated', (m) => {
      if (m.payload.channelId === channelId) void reload()
    })
    return off
  }, [communityId, channelId, pinPolicy])

  // Advance `now` every 15s so deadlines take effect without a manual reload.
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])

  // `now` must advance on its own: a roll-call deadline (or an event archiving) passes with
  // no store change, so without a tick the banner would stay "open" forever and the manager
  // would never see the sweep button until something else forced a re-render.
  const now = tick
  const active = artifacts.filter((a) => a.status === 'active')
  // Pins/links/media (newest-first) vs one-shot events (upcoming/ongoing only, soonest
  // first). A past event auto-archives ~2h after it ends (or starts, if no end).
  const pins = active.filter((a) => a.body.kind !== 'event' && a.body.kind !== 'rollcall')
  // Roll-calls: newest first. An OPEN one asks members to confirm; a CLOSED one waits for a
  // manager to sweep (so it stays visible past its deadline).
  const rollcalls = active
    .filter((a) => a.body.kind === 'rollcall')
    .sort((x, y) => y.artifact.createdAt - x.artifact.createdAt)
  const events = active
    .filter((a): a is VerifiedArtifact & { body: Extract<ArtifactBody, { kind: 'event' }> } => {
      if (a.body.kind !== 'event') return false
      const end = (a.body.endsAt ?? a.body.startsAt) + 2 * 3_600_000
      return end >= now
    })
    .sort((x, y) => x.body.startsAt - y.body.startsAt)
  // Managers see all suggestions (to approve); a member sees their own (as pending).
  const suggested = artifacts.filter(
    (a) => a.status === 'suggested' && (isManager || a.artifact.createdBy === myAccountId),
  )
  if (
    pins.length === 0 &&
    events.length === 0 &&
    rollcalls.length === 0 &&
    suggested.length === 0 &&
    !canCreate
  ) {
    return null
  }

  const canRemove = (a: VerifiedArtifact) => isManager || a.artifact.createdBy === myAccountId
  const attachmentLabel = t('chat.attachment')

  const create = (body: ArtifactBody) =>
    channelArtifactsStore.pin(communityId, channelId, body).then(reload)
  const approve = (artifactId: string) =>
    void channelArtifactsStore.approve(communityId, channelId, artifactId).then(reload)
  const unpin = (artifactId: string) =>
    void channelArtifactsStore.unpin(communityId, channelId, artifactId).then(reload)
  const toggleGoing = (a: VerifiedArtifact) =>
    void channelArtifactsStore
      .participate(communityId, channelId, a.artifact.artifactId, !a.tally.mine)
      .then(reload)
      .catch((err) => console.error('rsvp failed', err))

  const respondRollcall = (artifactId: string) =>
    void channelArtifactsStore
      .respondRollcall(communityId, channelId, artifactId)
      .then(reload)
      .catch((err) => fail('rollcall respond failed', err))

  const fail = (label: string, err: unknown) => {
    console.error(label, err)
    setCreateError(err instanceof ApiError ? err.message : String(err))
  }

  const pinLink = async () => {
    const url = linkUrl.trim()
    if (!url || busy) return
    setBusy(true)
    setCreateError(null)
    try {
      await create({
        v: 1,
        kind: 'link',
        url,
        ...(linkTitle.trim() ? { title: linkTitle.trim() } : {}),
      })
      setLinkUrl('')
      setLinkTitle('')
      setComposeMode('none')
    } catch (err) {
      fail('pin link failed', err)
    } finally {
      setBusy(false)
    }
  }

  const pinFile = async (file: File | undefined) => {
    if (!file || busy) return
    setBusy(true)
    setCreateError(null)
    try {
      const media = await encryptAndUpload(file, { name: file.name })
      await create({ v: 1, kind: 'media', media })
      setComposeMode('none')
    } catch (err) {
      fail('pin file failed', err)
    } finally {
      setBusy(false)
    }
  }

  const pinEvent = async () => {
    const title = ev.title.trim()
    const startsAt = ev.starts ? new Date(ev.starts).getTime() : 0
    if (!title || !Number.isFinite(startsAt) || startsAt === 0 || busy) return
    const endsAt = ev.ends ? new Date(ev.ends).getTime() : undefined
    setBusy(true)
    setCreateError(null)
    try {
      await create({
        v: 1,
        kind: 'event',
        title,
        startsAt,
        ...(endsAt && Number.isFinite(endsAt) ? { endsAt } : {}),
        ...(ev.location.trim() ? { location: ev.location.trim() } : {}),
        ...(ev.url.trim() ? { url: ev.url.trim() } : {}),
        remindOffsetMin: ev.remindOffsetMin,
      })
      setEv({ title: '', starts: '', ends: '', location: '', url: '', remindOffsetMin: 60 })
      setComposeMode('none')
    } catch (err) {
      fail('pin event failed', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 rounded-md border border-edge bg-overlay/40 text-sm">
      <div className="flex w-full items-center gap-2 px-3 py-2 text-xs text-ink-soft">
        <button
          type="button"
          className="flex flex-1 items-center gap-2 text-left"
          onClick={() => setCollapsed((c) => !c)}
        >
          <span aria-hidden>📌</span>
          <span className="flex-1">{t('pins.title', { count: pins.length + events.length })}</span>
        </button>
        {canCreate && (
          <button
            type="button"
            className="text-ink-faint hover:text-ink"
            title={t('pins.add')}
            aria-label={t('pins.add')}
            onClick={() => {
              setComposeMode((m) => (m === 'none' ? 'link' : 'none'))
              setCollapsed(false)
            }}
          >
            ＋
          </button>
        )}
        <button
          type="button"
          aria-label={t('pins.title', { count: pins.length + events.length })}
          onClick={() => setCollapsed((c) => !c)}
        >
          <span aria-hidden>{collapsed ? '▸' : '▾'}</span>
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          void pinFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      {composing && canCreate && (
        <div className="space-y-2 border-t border-edge px-3 py-2">
          <div className="flex gap-2 text-xs">
            {(['link', 'event'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`rounded-full border px-2 py-0.5 ${
                  composeMode === m ? 'border-indigo-soft bg-indigo/20' : 'border-edge'
                }`}
                onClick={() => setComposeMode(m)}
              >
                {t(m === 'link' ? 'pins.composeLink' : 'pins.composeEvent')}
              </button>
            ))}
            <button
              type="button"
              className="rounded-full border border-edge px-2 py-0.5"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
            >
              {t('pins.composeFile')}
            </button>
          </div>

          {createError && (
            <p className="rounded-md border border-danger/50 bg-danger/10 px-2 py-1 text-[11px] text-danger">
              {t('pins.pinFailed')}: {createError}
            </p>
          )}

          {composeMode === 'link' && (
            <>
              <input
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                placeholder={t('pins.linkUrlPlaceholder')}
                className="text-sm"
                inputMode="url"
              />
              <input
                value={linkTitle}
                onChange={(e) => setLinkTitle(e.target.value)}
                placeholder={t('pins.linkTitlePlaceholder')}
                className="text-sm"
              />
              <button
                type="button"
                className="btn-gold text-xs px-3"
                disabled={!linkUrl.trim() || busy}
                onClick={() => void pinLink()}
              >
                {t('pins.pinLink')}
              </button>
            </>
          )}

          {composeMode === 'event' && (
            <>
              <input
                value={ev.title}
                onChange={(e) => setEv({ ...ev, title: e.target.value })}
                placeholder={t('pins.eventTitlePlaceholder')}
                className="text-sm"
              />
              <label className="block text-[11px] text-ink-faint">
                {t('pins.eventStart')}
                <input
                  type="datetime-local"
                  value={ev.starts}
                  onChange={(e) => setEv({ ...ev, starts: e.target.value })}
                  className="text-sm w-full"
                />
              </label>
              <label className="block text-[11px] text-ink-faint">
                {t('pins.eventEnd')}
                <input
                  type="datetime-local"
                  value={ev.ends}
                  onChange={(e) => setEv({ ...ev, ends: e.target.value })}
                  className="text-sm w-full"
                />
              </label>
              <input
                value={ev.location}
                onChange={(e) => setEv({ ...ev, location: e.target.value })}
                placeholder={t('pins.eventLocationPlaceholder')}
                className="text-sm"
              />
              <input
                value={ev.url}
                onChange={(e) => setEv({ ...ev, url: e.target.value })}
                placeholder={t('pins.eventUrlPlaceholder')}
                className="text-sm"
                inputMode="url"
              />
              <label className="block text-[11px] text-ink-faint">
                {t('pins.eventRemind')}
                <select
                  value={ev.remindOffsetMin}
                  onChange={(e) => setEv({ ...ev, remindOffsetMin: Number(e.target.value) })}
                  className="text-sm w-full bg-overlay border border-edge rounded-md px-2 py-1"
                >
                  {(
                    [
                      [0, t('pins.remind_atstart')],
                      [15, t('pins.remind_15m')],
                      [30, t('pins.remind_30m')],
                      [60, t('pins.remind_1h')],
                      [120, t('pins.remind_2h')],
                      [1440, t('pins.remind_1d')],
                    ] as const
                  ).map(([mins, label]) => (
                    <option key={mins} value={mins}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-[11px] text-ink-faint">{t('pins.remindNote')}</p>
              <button
                type="button"
                className="btn-gold text-xs px-3"
                disabled={!ev.title.trim() || !ev.starts || busy}
                onClick={() => void pinEvent()}
              >
                {t('pins.pinEvent')}
              </button>
            </>
          )}
        </div>
      )}

      {!collapsed &&
        (pins.length > 0 || events.length > 0 || rollcalls.length > 0 || suggested.length > 0) && (
          <div className="space-y-1 border-t border-edge px-3 py-2">
            {/* Roll-calls: confirm you're still here / manager sweeps the silent. */}
            {rollcalls.map((a) => {
              const closed = !!a.artifact.expiresAt && a.artifact.expiresAt <= now
              const deadline = a.artifact.expiresAt
                ? new Date(a.artifact.expiresAt).toLocaleString(i18n.language, {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })
                : ''
              return (
                <div
                  key={a.artifact.artifactId}
                  className="mb-1 space-y-1 rounded-md border border-gold/40 bg-gold/10 px-2 py-1.5"
                >
                  <p className="text-xs text-ink">
                    <span aria-hidden>🙋 </span>
                    {closed
                      ? t('rollcall.closed')
                      : isManager
                        ? t('rollcall.openManager', { deadline })
                        : t('rollcall.open', { deadline })}
                  </p>
                  <div className="flex items-center gap-2">
                    {/* Managers + the owner are exempt from the sweep, so never ask THEM to
                        confirm — it would be a prompt with no consequence. */}
                    {!closed && !isManager && !a.artifact.respondedByMe && (
                      <button
                        type="button"
                        className="btn-gold text-xs px-2 py-0.5"
                        onClick={() => respondRollcall(a.artifact.artifactId)}
                      >
                        {t('rollcall.confirm')}
                      </button>
                    )}
                    {!closed && !isManager && a.artifact.respondedByMe && (
                      <span className="text-[11px] text-olive">{t('rollcall.confirmed')}</span>
                    )}
                    {!closed && isManager && (
                      <span className="text-[11px] text-ink-faint">{t('rollcall.exempt')}</span>
                    )}
                    <span className="text-[11px] text-ink-faint">
                      {t('rollcall.responses', { count: a.artifact.responseCount })}
                    </span>
                    {isManager && closed && (
                      <span className="ml-auto text-[11px] text-ink-faint">
                        {t('rollcall.sweepInModeration')}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
            {events.length > 0 && (
              <div className="mb-1 space-y-1">
                {events.map((a) => {
                  const startRel = relativeExpiry(a.body.startsAt, i18n.language)
                  const when = new Date(a.body.startsAt).toLocaleString(i18n.language, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })
                  return (
                    <div key={a.artifact.artifactId} className="flex items-center gap-2">
                      <span aria-hidden>{KIND_ICON.event}</span>
                      <span className="flex-1 truncate">
                        {a.body.url ? (
                          <a
                            href={a.body.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-indigo-soft hover:underline"
                          >
                            {a.body.title}
                          </a>
                        ) : (
                          <span className="text-ink">{a.body.title}</span>
                        )}
                        <span className="ml-1 text-[11px] text-ink-faint">
                          · {when}
                          {startRel ? ` · ${startRel}` : ''}
                          {a.body.location ? ` · 📍 ${a.body.location}` : ''}
                        </span>
                      </span>
                      <button
                        type="button"
                        aria-pressed={a.tally.mine}
                        className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${
                          a.tally.mine
                            ? 'border-indigo-soft bg-indigo/20 text-ink'
                            : 'border-edge text-ink-faint hover:text-ink'
                        }`}
                        onClick={() => toggleGoing(a)}
                        title={t('pins.goingHint')}
                      >
                        {t('pins.going', { count: a.tally.count })}
                      </button>
                      {canRemove(a) && (
                        <button
                          type="button"
                          className="text-xs text-ink-faint hover:text-danger"
                          onClick={() => unpin(a.artifact.artifactId)}
                          aria-label={t('pins.unpin')}
                          title={t('pins.unpin')}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            {pins.map((a) => {
              const expiry = relativeExpiry(a.artifact.expiresAt, i18n.language)
              const media =
                a.body.kind === 'media' ? a.body.media : a.body.kind === 'pin' ? a.body.media : null
              const expanded = expandedId === a.artifact.artifactId
              return (
                <div key={a.artifact.artifactId}>
                  <div className="flex items-center gap-2">
                    <span aria-hidden>{KIND_ICON[a.body.kind]}</span>
                    {a.body.kind === 'link' ? (
                      <a
                        href={a.body.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 truncate text-indigo-soft hover:underline"
                      >
                        {summarize(a.body, attachmentLabel)}
                      </a>
                    ) : (
                      <button
                        type="button"
                        className="flex-1 truncate text-left text-ink hover:text-indigo-soft"
                        onClick={() => {
                          if (media) {
                            setExpandedId(expanded ? null : a.artifact.artifactId)
                          } else if (a.body.kind === 'pin' && a.body.originalMessageId) {
                            onJump(a.body.originalMessageId)
                          }
                        }}
                      >
                        {summarize(a.body, attachmentLabel) || t('pins.untitled')}
                      </button>
                    )}
                    {expiry && (
                      <span
                        className="shrink-0 text-[10px] text-ink-faint"
                        title={t('pins.expires', { when: expiry })}
                      >
                        ⏳ {expiry}
                      </span>
                    )}
                    {canRemove(a) && (
                      <button
                        type="button"
                        className="text-xs text-ink-faint hover:text-danger"
                        onClick={() => unpin(a.artifact.artifactId)}
                        aria-label={t('pins.unpin')}
                        title={t('pins.unpin')}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  {media && expanded && (
                    <div className="mt-1 mb-2 pl-6">
                      <MediaAttachment media={media} />
                    </div>
                  )}
                </div>
              )
            })}

            {suggested.length > 0 && (
              <div className="mt-2 border-t border-edge pt-2">
                <p className="mb-1 text-[11px] uppercase tracking-wide text-ink-faint">
                  {t('pins.suggested', { count: suggested.length })}
                </p>
                {suggested.map((a) => (
                  <div key={a.artifact.artifactId} className="flex items-center gap-2">
                    <span aria-hidden>{KIND_ICON[a.body.kind]}</span>
                    <span className="flex-1 truncate text-ink-soft">
                      {summarize(a.body, attachmentLabel) || t('pins.untitled')}
                      {!isManager && (
                        <span className="ml-1 text-[11px] text-ink-faint">
                          · {t('pins.pending')}
                        </span>
                      )}
                    </span>
                    {isManager && (
                      <button
                        type="button"
                        className="text-xs text-olive hover:underline"
                        onClick={() => approve(a.artifact.artifactId)}
                      >
                        {t('pins.approve')}
                      </button>
                    )}
                    {canRemove(a) && (
                      <button
                        type="button"
                        className="text-xs text-ink-faint hover:text-danger"
                        onClick={() => unpin(a.artifact.artifactId)}
                      >
                        {t('pins.dismiss')}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
    </div>
  )
}
