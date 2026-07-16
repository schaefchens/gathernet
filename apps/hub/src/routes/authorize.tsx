import {
  APP_SCOPES,
  type AppScope,
  type AppSessionResponse,
  type GrantSummary,
  type PublicationCard,
} from '@gathernet/shared'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BackfillPhrase } from '../features/apps/BackfillPhrase.tsx'
import { ConsentCard } from '../features/apps/ConsentCard.tsx'
import { WelcomeFlow } from '../features/onboarding/WelcomeFlow.tsx'
import { UnlockScreen } from '../features/unlock/UnlockScreen.tsx'
import { api } from '../lib/api.ts'
import { getPerAppStorageKey } from '../lib/app-grant.ts'
import { useSession } from '../stores/session.ts'

/**
 * App-grant popup: opened by an SDK-driven app via window.open. The Hub shows
 * consent (after unlock if needed) and posts the minted app session back to
 * the opener — targetOrigin is the server-validated origin echo, never the
 * raw query parameter.
 */

interface AuthorizeSearch {
  appId: string
  scopes: string
  state: string
  origin: string
}

export const Route = createFileRoute('/authorize')({
  validateSearch: (search: Record<string, unknown>): AuthorizeSearch => ({
    appId: typeof search.appId === 'string' ? search.appId : '',
    scopes: typeof search.scopes === 'string' ? search.scopes : '',
    state: typeof search.state === 'string' ? search.state : '',
    origin: typeof search.origin === 'string' ? search.origin : '',
  }),
  component: AuthorizeScreen,
})

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))

function parseScopes(raw: string): AppScope[] | null {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  const known = parts.filter((p): p is AppScope => (APP_SCOPES as readonly string[]).includes(p))
  return known.length === parts.length ? known : null
}

function AuthorizeScreen() {
  const phase = useSession((s) => s.phase)
  const { t } = useTranslation()

  if (phase === 'loading') {
    return (
      <div className="min-h-screen grid place-items-center text-ink-soft">
        {t('common.loading')}
      </div>
    )
  }
  if (phase === 'welcome') return <WelcomeFlow />
  if (phase === 'locked') return <UnlockScreen />
  return <AuthorizeConsent />
}

function AuthorizeConsent() {
  const { appId, scopes: scopesRaw, state, origin } = Route.useSearch()
  const { t } = useTranslation()
  const [opener] = useState(() => window.opener as Window | null)
  const requested = useMemo(() => parseScopes(scopesRaw), [scopesRaw])
  const [step, setStep] = useState<'consent' | 'backfill' | 'approved' | 'denied'>('consent')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [autoApproving, setAutoApproving] = useState(false)
  const startedRef = useRef(false)

  const card = useQuery({
    queryKey: ['app-card', appId],
    queryFn: () => api<PublicationCard>('GET', `/api/v1/apps/card/${appId}`),
    enabled: Boolean(appId),
  })
  const grants = useQuery({
    queryKey: ['app-grants'],
    queryFn: () => api<{ grants: GrantSummary[] }>('GET', '/api/v1/apps/grants'),
  })

  const approve = async (options?: { withoutStorageKey?: boolean }) => {
    if (!requested) return
    setBusy(true)
    setError(null)
    try {
      let storageKey: string | undefined
      if (!options?.withoutStorageKey && requested.includes('storage')) {
        const key = await getPerAppStorageKey(appId)
        if (!key) {
          // Pre-M2 account on this device — offer the recovery-phrase backfill.
          setStep('backfill')
          setBusy(false)
          return
        }
        storageKey = b64(key)
      }
      const session = await api<AppSessionResponse>('POST', `/api/v1/apps/${appId}/authorize`, {
        scopes: requested,
        origin,
      })
      opener?.postMessage(
        {
          type: 'gathernet:grant',
          state,
          token: session.token,
          appUserId: session.appUserId,
          displayName: session.displayName,
          scopes: session.scopes,
          expiresAt: session.expiresAt,
          ...(storageKey ? { storageKey } : {}),
        },
        session.origin,
      )
      setStep('approved')
      window.close()
    } catch {
      setAutoApproving(false)
      setError(t('apps.authorizeFailed'))
      setBusy(false)
    }
  }

  const deny = () => {
    opener?.postMessage({ type: 'gathernet:grant-denied', state }, origin)
    setStep('denied')
    window.close()
  }

  // Remembered consent: an existing grant covering every requested scope
  // approves silently (the storage-key derivation still runs).
  // biome-ignore lint/correctness/useExhaustiveDependencies: approve is recreated per render; startedRef guards re-entry
  useEffect(() => {
    if (startedRef.current || !grants.data || !requested || !opener) return
    const existing = grants.data.grants.find((g) => g.appId === appId)
    if (existing && requested.every((scope) => existing.scopes.includes(scope))) {
      startedRef.current = true
      setAutoApproving(true)
      void approve()
    }
  }, [grants.data, requested, opener, appId])

  if (!opener) {
    return <Note text={t('apps.openerMissing')} />
  }
  if (!appId || !requested || !origin) {
    return <Note text={t('apps.invalidRequest')} />
  }
  if (step === 'approved') {
    return <Note text={t('apps.approved')} tone="olive" />
  }
  if (step === 'denied') {
    return <Note text={t('apps.denied')} />
  }
  if (step === 'backfill') {
    return (
      <Frame>
        <BackfillPhrase
          onComplete={() => {
            setStep('consent')
            void approve()
          }}
          onSkip={() => {
            setStep('consent')
            void approve({ withoutStorageKey: true })
          }}
        />
      </Frame>
    )
  }
  if (card.isError) {
    return <Note text={t('apps.invalidRequest')} />
  }
  if (!card.data || (!grants.data && !grants.isError) || autoApproving) {
    return (
      <div className="min-h-screen grid place-items-center text-ink-soft">
        {autoApproving ? t('apps.rememberedConsent') : t('common.loading')}
      </div>
    )
  }

  return (
    <Frame>
      <h1 className="font-display text-3xl text-gold text-center">
        {t('apps.consentTitle', { name: card.data.name })}
      </h1>
      <ConsentCard
        app={card.data}
        scopes={requested}
        busy={busy}
        error={error}
        onApprove={() => void approve()}
        onDeny={deny}
      />
    </Frame>
  )
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen grid place-items-center px-4 py-6">
      <div className="w-full max-w-md space-y-4">{children}</div>
    </div>
  )
}

function Note({ text, tone }: { text: string; tone?: 'olive' }) {
  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className={`card text-center ${tone === 'olive' ? 'text-olive' : 'text-ink-soft'}`}>
        {text}
      </div>
    </div>
  )
}
