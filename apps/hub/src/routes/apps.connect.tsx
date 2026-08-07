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
  | { kind: 'preview'; preview: GrantCodePreview; scannedPk: string | null }
  | { kind: 'backfill'; preview: GrantCodePreview; scannedPk: string | null }
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

  /**
   * `scannedPk` is the app's ECIES ephemeral public key delivered OUT OF BAND
   * in the scanned QR (`gathernet:grant:<userCode>:<pk>`). It is null for
   * manual code entry, where no key travels alongside the code.
   */
  const lookUp = async (userCode: string, scannedPk: string | null) => {
    setBusy(true)
    setError(null)
    try {
      const preview = await api<GrantCodePreview>(
        'GET',
        `/api/v1/apps/grant-codes/${normalizeCode(userCode)}`,
      )
      setStep({ kind: 'preview', preview, scannedPk })
    } catch {
      setError(t('apps.codeInvalid'))
    } finally {
      setBusy(false)
    }
  }

  const approve = async (
    preview: GrantCodePreview,
    scannedPk: string | null,
    options?: { withoutStorageKey?: boolean },
  ) => {
    setBusy(true)
    setError(null)
    try {
      const body: { scopes: string[]; sealedStorageKey?: string; hubEphemeralPk?: string } = {
        scopes: preview.requestedScopes,
      }
      // Seal the per-app storage key ONLY to the pk delivered out-of-band via
      // the scanned QR — never to preview.appEphemeralPk, which the untrusted
      // server relays and could substitute. Manual code entry (no scanned pk)
      // degrades safely to no storage key: the app still gets identity/rooms,
      // and the popup flow remains the way to hand off a storage key.
      if (!options?.withoutStorageKey && preview.requestedScopes.includes('storage') && scannedPk) {
        const key = await getPerAppStorageKey(preview.app.pubId)
        if (!key) {
          setStep({ kind: 'backfill', preview, scannedPk })
          setBusy(false)
          return
        }
        const sealed = await eciesSeal(scannedPk, key)
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
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <h1 className="font-display text-3xl">{t('apps.connectTitle')}</h1>

      {step.kind === 'entry' && <EntryTabs busy={busy} error={error} onLookUp={lookUp} />}

      {step.kind === 'preview' && (
        <ConsentCard
          app={step.preview.app}
          scopes={step.preview.requestedScopes}
          busy={busy}
          error={error}
          onApprove={() => void approve(step.preview, step.scannedPk)}
          onDeny={() => void deny(step.preview)}
        />
      )}

      {step.kind === 'backfill' && (
        <BackfillPhrase
          onComplete={() => void approve(step.preview, step.scannedPk)}
          onSkip={() => void approve(step.preview, step.scannedPk, { withoutStorageKey: true })}
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
  onLookUp(userCode: string, scannedPk: string | null): Promise<void>
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
            // Manual entry carries no out-of-band key → no storage-key handoff.
            void props.onLookUp(code, null)
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
            onCode={(payload) => {
              // Scanned payload is `<userCode>:<ephemeralPkB64>` — the app's
              // ECIES key arrives out-of-band here, so the server can't swap it.
              const sep = payload.indexOf(':')
              const userCode = sep === -1 ? payload : payload.slice(0, sep)
              const scannedPk = sep === -1 ? null : payload.slice(sep + 1)
              void props.onLookUp(userCode, scannedPk)
            }}
          />
          {props.error && <p className="text-sm text-danger">{props.error}</p>}
        </div>
      )}
    </>
  )
}
