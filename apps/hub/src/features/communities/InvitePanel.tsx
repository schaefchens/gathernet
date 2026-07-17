import type { CommunityInvite } from '@gathernet/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api.ts'
import { buildInvitePayload, COMMUNITY_INVITE_SCHEME, getKMeta } from '../../lib/community-keys.ts'

function QrDisplay({ value }: { value: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (canvasRef.current) {
      void QRCode.toCanvas(canvasRef.current, value, {
        width: 180,
        margin: 2,
        color: { dark: '#0B0F1A', light: '#EDE6D6' },
      })
    }
  }, [value])
  return <canvas ref={canvasRef} className="mx-auto rounded-lg" />
}

/**
 * Community invite panel. The QR + copy value carries K_meta out-of-band in the
 * URL fragment (`gathernet:community:<code>#<k_meta>`) so a scanning device can
 * decrypt the community's metadata; the bare 10-char code is still shown for
 * manual entry (which yields no K_meta — an accepted degradation).
 */
export function InvitePanel({ communityId }: { communityId: string }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [copied, setCopied] = useState(false)
  const [shareValue, setShareValue] = useState<string | null>(null)

  const invites = useQuery({
    queryKey: ['community-invites', communityId],
    queryFn: () =>
      api<{ invites: CommunityInvite[] }>('GET', `/api/v1/communities/${communityId}/invites`),
  })
  const createInvite = useMutation({
    mutationFn: () =>
      api<CommunityInvite>('POST', `/api/v1/communities/${communityId}/invites`, {}),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ['community-invites', communityId] }),
  })

  const invite = invites.data?.invites.at(-1)

  useEffect(() => {
    if (invites.isSuccess && invites.data.invites.length === 0 && createInvite.isIdle) {
      createInvite.mutate()
    }
  }, [invites.isSuccess, invites.data, createInvite])

  // Fold K_meta into the shareable value once we have both a code and the key.
  useEffect(() => {
    if (!invite) {
      setShareValue(null)
      return
    }
    let cancelled = false
    void (async () => {
      const kMeta = await getKMeta(communityId)
      const value = kMeta
        ? buildInvitePayload(invite.code, kMeta)
        : `${COMMUNITY_INVITE_SCHEME}${invite.code}`
      if (!cancelled) setShareValue(value)
    })()
    return () => {
      cancelled = true
    }
  }, [communityId, invite])

  return (
    <section className="card space-y-3 text-center">
      <h2 className="font-medium text-ink-soft">{t('communities.invite')}</h2>
      <p className="text-sm text-ink-soft">{t('communities.inviteHint')}</p>
      {invite && shareValue ? (
        <>
          <QrDisplay value={shareValue} />
          <div className="text-2xl font-mono tracking-[0.3em] text-gold">{invite.code}</div>
          <div className="flex justify-center gap-2">
            <button
              type="button"
              className="btn-quiet text-sm"
              onClick={async () => {
                await navigator.clipboard.writeText(shareValue)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
            >
              {copied ? t('common.copied') : t('common.copy')}
            </button>
            <button
              type="button"
              className="btn-quiet text-sm"
              disabled={createInvite.isPending}
              onClick={() => createInvite.mutate()}
            >
              {t('communities.newInvite')}
            </button>
          </div>
        </>
      ) : (
        <p className="text-ink-soft">{t('common.loading')}</p>
      )}
    </section>
  )
}
