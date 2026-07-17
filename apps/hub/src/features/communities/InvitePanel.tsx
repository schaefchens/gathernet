import type { CommunityInvite } from '@gathernet/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api.ts'

/** QR prefix for community invites — parsed by the join scanner on /communities. */
export const COMMUNITY_QR_PREFIX = 'gathernet:community:'

function QrDisplay({ value }: { value: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (canvasRef.current) {
      void QRCode.toCanvas(canvasRef.current, `${COMMUNITY_QR_PREFIX}${value}`, {
        width: 180,
        margin: 2,
        color: { dark: '#0B0F1A', light: '#EDE6D6' },
      })
    }
  }, [value])
  return <canvas ref={canvasRef} className="mx-auto rounded-lg" />
}

export function InvitePanel({ communityId }: { communityId: string }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [copied, setCopied] = useState(false)

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

  return (
    <section className="card space-y-3 text-center">
      <h2 className="font-medium text-ink-soft">{t('communities.invite')}</h2>
      <p className="text-sm text-ink-soft">{t('communities.inviteHint')}</p>
      {invite ? (
        <>
          <QrDisplay value={invite.code} />
          <div className="text-2xl font-mono tracking-[0.3em] text-gold">{invite.code}</div>
          <div className="flex justify-center gap-2">
            <button
              type="button"
              className="btn-quiet text-sm"
              onClick={async () => {
                await navigator.clipboard.writeText(invite.code)
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
