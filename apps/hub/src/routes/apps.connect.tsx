import { eciesSeal, GRANT_QR_PREFIX, type GrantCodePreview } from '@gathernet/shared'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { QrScanner } from '../components/QrScanner.tsx'
import { BackfillPhrase } from '../features/apps/BackfillPhrase.tsx'
import { ConsentCard } from '../features/apps/ConsentCard.tsx'
import { api } from '../lib/api.ts'
import { getPerAppStorageKey } from '../lib/app-grant.ts'

export const Route = createFileRoute('/apps/connect')({ component: ConnectScreen })

type Step =
  | { kind: 'entry' }
  | { kind: 'preview'; preview: GrantCodePreview }
  | { kind: 'backfill'; preview: GrantCodePreview }
  | { kind: 'success' }
  | { kind: 'denied' }

/** Normalize user input: uppercase, dashes/spaces stripped. */
function normalizeCode(raw: string): string {
  return raw.toUpperCase().replaceAll('-', '').replaceAll(' ', '')
}

function ConnectScreen() {
  const { t } = useTranslation()
  const [step, setStep] = useState<Step>({ kind: 'entry' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const lookUp = async (rawCode: string) => {
    setBusy(true)
    setError(null)
    try {
      const preview = await api<GrantCodePreview>(
        'GET',
        `/api/v1/apps/grant-codes/${normalizeCode(rawCode)}`,
      )
      setStep({ kind: 'preview', preview })
    } catch {
      setError(t('apps.codeInvalid'))
    } finally {
      setBusy(false)
    }
  }

  const approve = async (preview: GrantCodePreview, options?: { withoutStorageKey?: boolean }) => {
    setBusy(true)
    setError(null)
    try {
      const body: { scopes: string[]; sealedStorageKey?: string; hubEphemeralPk?: string } = {
        scopes: preview.requestedScopes,
      }
      if (
        !options?.withoutStorageKey &&
        preview.requestedScopes.includes('storage') &&
        preview.appEphemeralPk
      ) {
        const key = await getPerAppStorageKey(preview.app.pubId)
        if (!key) {
          setStep({ kind: 'backfill', preview })
          setBusy(false)
          return
        }
        const sealed = await eciesSeal(preview.appEphemeralPk, key)
        body.sealedStorageKey = sealed.sealedB64
        body.hubEphemeralPk = sealed.senderPkB64
      }
      await api('POST', `/api/v1/apps/grant-codes/${preview.userCode}/approve`, body)
      setStep({ kind: 'success' })
    } catch {
      setError(t('apps.codeInvalid'))
      setStep({ kind: 'entry' })
    } finally {
      setBusy(false)
    }
  }

  const deny = async (preview: GrantCodePreview) => {
    setBusy(true)
    setError(null)
    try {
      await api('POST', `/api/v1/apps/grant-codes/${preview.userCode}/deny`)
      setStep({ kind: 'denied' })
    } catch {
      setError(t('apps.codeInvalid'))
      setStep({ kind: 'entry' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 max-w-md mx-auto">
      <h1 className="font-display text-3xl">{t('apps.connectTitle')}</h1>

      {step.kind === 'entry' && <EntryTabs busy={busy} error={error} onCode={lookUp} />}

      {step.kind === 'preview' && (
        <ConsentCard
          app={step.preview.app}
          scopes={step.preview.requestedScopes}
          busy={busy}
          error={error}
          onApprove={() => void approve(step.preview)}
          onDeny={() => void deny(step.preview)}
        />
      )}

      {step.kind === 'backfill' && (
        <BackfillPhrase
          onComplete={() => void approve(step.preview)}
          onSkip={() => void approve(step.preview, { withoutStorageKey: true })}
        />
      )}

      {step.kind === 'success' && (
        <div className="card text-center space-y-3">
          <p className="text-olive">{t('apps.connectSuccess')}</p>
          <Link to="/" className="text-sm text-ink-soft hover:text-ink">
            {t('common.close')}
          </Link>
        </div>
      )}

      {step.kind === 'denied' && (
        <div className="card text-center space-y-3">
          <p className="text-ink-soft">{t('apps.connectDenied')}</p>
          <Link to="/" className="text-sm text-ink-soft hover:text-ink">
            {t('common.close')}
          </Link>
        </div>
      )}
    </div>
  )
}

function EntryTabs(props: {
  busy: boolean
  error: string | null
  onCode(code: string): Promise<void>
}) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'code' | 'scan'>('code')
  const [code, setCode] = useState('')
  const normalized = normalizeCode(code)

  return (
    <>
      <p className="text-sm text-ink-soft">{t('apps.connectHint')}</p>
      <div className="flex gap-1 bg-raised border border-edge rounded-md p-1">
        {(['code', 'scan'] as const).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            className={`flex-1 rounded px-3 py-1.5 text-sm transition-colors ${
              tab === name ? 'bg-overlay text-gold' : 'text-ink-soft hover:text-ink'
            }`}
          >
            {t(name === 'code' ? 'apps.enterCode' : 'apps.scan')}
          </button>
        ))}
      </div>

      {tab === 'code' && (
        <form
          className="card space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void props.onCode(code)
          }}
        >
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder={t('apps.codePlaceholder')}
            maxLength={9}
            className="text-center font-mono text-xl tracking-[0.3em]"
            autoFocus
            autoComplete="off"
          />
          {props.error && <p className="text-sm text-danger text-center">{props.error}</p>}
          <button
            type="submit"
            className="btn-gold w-full"
            disabled={props.busy || normalized.length !== 8}
          >
            {props.busy ? t('apps.checkingCode') : t('apps.lookUp')}
          </button>
        </form>
      )}

      {tab === 'scan' && (
        <div className="card space-y-3 text-center">
          <p className="text-sm text-ink-soft">{t('apps.scanHint')}</p>
          <QrScanner
            prefixes={[GRANT_QR_PREFIX]}
            onCode={(payload) => void props.onCode(payload)}
          />
          {props.error && <p className="text-sm text-danger">{props.error}</p>}
        </div>
      )}
    </>
  )
}
