import type { ChannelPinPolicy } from '@gathernet/shared'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ArtifactBody, VerifiedArtifact } from '../../lib/artifacts.ts'
import { wsClient } from '../../lib/ws-client.ts'
import { channelArtifactsStore, useChannelArtifacts } from '../../stores/channel-artifacts.ts'

const EMPTY: VerifiedArtifact[] = []

/** A one-line summary of an artifact body for the compact pinned card. */
function summarize(body: ArtifactBody, attachmentLabel: string): string {
  switch (body.kind) {
    case 'pin':
      return body.note || body.text || (body.media ? attachmentLabel : '')
    case 'link':
      return body.title || body.url
    case 'media':
      return body.caption || attachmentLabel
    case 'event':
      return body.title
  }
}

/**
 * The sticky pinned-artifacts bar at the top of a channel. Shows active pins
 * (newest first, collapsible) that every visitor sees; managers additionally see a
 * "suggested pins" queue (members' pins awaiting approval under pinPolicy=moderators)
 * with approve/dismiss. Tapping a pin scrolls to its source message if it still exists.
 */
export function PinnedBar({
  communityId,
  channelId,
  pinPolicy,
  isManager,
  myAccountId,
  onJump,
}: {
  communityId: string
  channelId: string
  pinPolicy: ChannelPinPolicy
  isManager: boolean
  myAccountId: string | null
  onJump: (messageId: string) => void
}) {
  const { t } = useTranslation()
  const artifacts = useChannelArtifacts((s) => s.byChannel[channelId] ?? EMPTY)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    void channelArtifactsStore.load(communityId, channelId, pinPolicy)
    const off = wsClient.on('community.channel_artifact_updated', (m) => {
      if (m.payload.channelId === channelId) {
        void channelArtifactsStore.load(communityId, channelId, pinPolicy)
      }
    })
    return off
  }, [communityId, channelId, pinPolicy])

  const active = artifacts.filter((a) => a.status === 'active')
  // Managers see all suggestions (to approve); a member sees their own (as pending).
  const suggested = artifacts.filter(
    (a) => a.status === 'suggested' && (isManager || a.artifact.createdBy === myAccountId),
  )
  if (active.length === 0 && suggested.length === 0) return null

  const canRemove = (a: VerifiedArtifact) => isManager || a.artifact.createdBy === myAccountId
  const attachmentLabel = t('chat.attachment')

  const approve = (artifactId: string) =>
    void channelArtifactsStore
      .approve(communityId, channelId, artifactId)
      .then(() => channelArtifactsStore.load(communityId, channelId, pinPolicy))
  const unpin = (artifactId: string) =>
    void channelArtifactsStore
      .unpin(communityId, channelId, artifactId)
      .then(() => channelArtifactsStore.load(communityId, channelId, pinPolicy))

  return (
    <div className="mt-3 rounded-md border border-edge bg-overlay/40 text-sm">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink-soft"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span aria-hidden>📌</span>
        <span className="flex-1">{t('pins.title', { count: active.length })}</span>
        <span aria-hidden>{collapsed ? '▸' : '▾'}</span>
      </button>

      {!collapsed && (
        <div className="space-y-1 px-3 pb-2">
          {active.map((a) => {
            const text = summarize(a.body, attachmentLabel)
            const jumpable = a.body.kind === 'pin' && a.body.originalMessageId
            return (
              <div key={a.artifact.artifactId} className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!jumpable}
                  className="flex-1 truncate text-left text-ink hover:text-indigo-soft disabled:hover:text-ink"
                  onClick={() =>
                    a.body.kind === 'pin' &&
                    a.body.originalMessageId &&
                    onJump(a.body.originalMessageId)
                  }
                  title={jumpable ? t('pins.jump') : undefined}
                >
                  {text || t('pins.untitled')}
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

          {suggested.length > 0 && (
            <div className="mt-2 border-t border-edge pt-2">
              <p className="mb-1 text-[11px] uppercase tracking-wide text-ink-faint">
                {t('pins.suggested', { count: suggested.length })}
              </p>
              {suggested.map((a) => (
                <div key={a.artifact.artifactId} className="flex items-center gap-2">
                  <span className="flex-1 truncate text-ink-soft">
                    {summarize(a.body, attachmentLabel) || t('pins.untitled')}
                    {!isManager && (
                      <span className="ml-1 text-[11px] text-ink-faint">· {t('pins.pending')}</span>
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
