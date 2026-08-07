import type { Invite } from '@gathernet/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import QRCode from 'qrcode'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '../components/PageHeader.tsx'
import { QrScanner } from '../components/QrScanner.tsx'
import { ApiError, api } from '../lib/api.ts'

export const Route = createFileRoute('/friends/add')({ component: AddFriendScreen })

type Tab = 'invite' | 'code' | 'scan'

function AddFriendScreen() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('invite')

  return (
    <>
      <PageHeader backTo="/" title={t('addFriend.title')} />
      <div className="mx-auto max-w-md space-y-4 px-4 py-6">
        <div className="flex gap-1 bg-raised border border-edge rounded-md p-1">
          {(['invite', 'code', 'scan'] as const).map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setTab(name)}
              className={`flex-1 rounded px-3 py-1.5 text-sm transition-colors ${
                tab === name ? 'bg-overlay text-gold' : 'text-ink-soft hover:text-ink'
              }`}
            >
              {t(
                name === 'invite'
                  ? 'addFriend.myInvite'
                  : name === 'code'
                    ? 'addFriend.enterCode'
                    : 'addFriend.scan',
              )}
            </button>
          ))}
        </div>
        {tab === 'invite' && <MyInviteTab />}
        {tab === 'code' && <EnterCodeTab />}
        {tab === 'scan' && <ScanTab />}
      </div>
    </>
  )
}

function MyInviteTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [copied, setCopied] = useState(false)

  const invites = useQuery({
    queryKey: ['invites'],
    queryFn: () => api<{ invites: Invite[] }>('GET', '/api/v1/friends/invites'),
  })
  const createInvite = useMutation({
    mutationFn: () => api<Invite>('POST', '/api/v1/friends/invites', {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['invites'] }),
  })

  const invite = invites.data?.invites.at(-1)

  useEffect(() => {
    if (invites.isSuccess && invites.data.invites.length === 0 && createInvite.isIdle) {
      createInvite.mutate()
    }
  }, [invites.isSuccess, invites.data, createInvite])

  return (
    <div className="card space-y-4 text-center">
      <p className="text-sm text-ink-soft">{t('addFriend.inviteHint')}</p>
      {invite ? (
        <>
          <QrDisplay value={invite.code} />
          <div className="text-2xl font-mono tracking-[0.3em] text-gold">{invite.code}</div>
          <div className="flex justify-center gap-2">
            <button
              type="button"
              className="btn-quiet"
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
              className="btn-quiet"
              disabled={createInvite.isPending}
              onClick={() => createInvite.mutate()}
            >
              {t('addFriend.newInvite')}
            </button>
          </div>
        </>
      ) : (
        <p className="text-ink-soft">{t('common.loading')}</p>
      )}
    </div>
  )
}

function QrDisplay({ value }: { value: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (canvasRef.current) {
      void QRCode.toCanvas(canvasRef.current, `gathernet:invite:${value}`, {
        width: 200,
        margin: 2,
        color: { dark: '#0B0F1A', light: '#EDE6D6' },
      })
    }
  }, [value])
  return <canvas ref={canvasRef} className="mx-auto rounded-lg" />
}

function useAcceptCode() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [accepted, setAccepted] = useState<string | null>(null)

  const accept = async (rawCode: string) => {
    setError(null)
    try {
      const result = await api<{ friend: { displayName: string } }>(
        'POST',
        '/api/v1/friends/invites/accept',
        { code: rawCode.trim() },
      )
      setAccepted(result.friend.displayName)
      void queryClient.invalidateQueries({ queryKey: ['friends'] })
      setTimeout(() => void navigate({ to: '/' }), 1200)
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          err.code === 'self_invite'
            ? t('addFriend.selfInvite')
            : err.code === 'already_friends'
              ? t('addFriend.alreadyFriends')
              : t('addFriend.invalidCode'),
        )
      } else {
        setError(t('common.error'))
      }
    }
  }

  return { accept, error, accepted }
}

function EnterCodeTab() {
  const { t } = useTranslation()
  const [code, setCode] = useState('')
  const { accept, error, accepted } = useAcceptCode()

  if (accepted) {
    return (
      <div className="card text-center text-olive">
        {t('addFriend.accepted', { name: accepted })}
      </div>
    )
  }

  return (
    <form
      className="card space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        void accept(code)
      }}
    >
      <input
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        placeholder={t('addFriend.codePlaceholder')}
        maxLength={10}
        className="text-center font-mono text-xl tracking-[0.3em]"
        autoFocus
        autoComplete="off"
      />
      {error && <p className="text-sm text-danger text-center">{error}</p>}
      <button type="submit" className="btn-gold w-full" disabled={code.trim().length < 10}>
        {t('addFriend.accept')}
      </button>
    </form>
  )
}

function ScanTab() {
  const { t } = useTranslation()
  const { accept, error, accepted } = useAcceptCode()

  if (accepted) {
    return (
      <div className="card text-center text-olive">
        {t('addFriend.accepted', { name: accepted })}
      </div>
    )
  }

  return (
    <div className="card space-y-3 text-center">
      <p className="text-sm text-ink-soft">{t('addFriend.scanHint')}</p>
      <QrScanner prefixes={['gathernet:invite:']} onCode={(payload) => void accept(payload)} />
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  )
}
