import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { backfillStorageRoot } from '../../lib/app-grant.ts'

interface BackfillPhraseProps {
  /** The storage root now exists — the caller can re-derive the per-app key. */
  onComplete(): void
  /** Proceed without a storage key (the app's storage calls will fail gracefully). */
  onSkip(): void
}

/**
 * Pre-M2 accounts have no storage root on this device. This step re-derives
 * it from the recovery phrase; the phrase never leaves the device.
 */
export function BackfillPhrase({ onComplete, onSkip }: BackfillPhraseProps) {
  const { t } = useTranslation()
  const [phrase, setPhrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [mismatch, setMismatch] = useState(false)

  return (
    <form
      className="card space-y-4"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setMismatch(false)
        try {
          const ok = await backfillStorageRoot(phrase)
          if (ok) {
            onComplete()
          } else {
            setMismatch(true)
          }
        } catch {
          setMismatch(true)
        } finally {
          setBusy(false)
        }
      }}
    >
      <h2 className="font-display text-2xl">{t('apps.backfillTitle')}</h2>
      <p className="text-sm text-ink-soft">{t('apps.backfillHint')}</p>
      <textarea
        value={phrase}
        onChange={(e) => {
          setPhrase(e.target.value)
          setMismatch(false)
        }}
        placeholder={t('apps.backfillPlaceholder')}
        rows={3}
        autoFocus
        autoCapitalize="none"
        autoComplete="off"
      />
      {mismatch && <p className="text-sm text-danger">{t('apps.backfillMismatch')}</p>}
      <button type="submit" className="btn-gold w-full" disabled={busy || !phrase.trim()}>
        {busy ? t('common.loading') : t('apps.backfillConfirm')}
      </button>
      <button
        type="button"
        className="text-xs text-ink-faint hover:text-ink w-full"
        disabled={busy}
        onClick={onSkip}
      >
        {t('apps.backfillSkip')}
      </button>
    </form>
  )
}
