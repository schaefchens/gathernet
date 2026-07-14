import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSession } from '../../stores/session.ts'

export function UnlockScreen() {
  const { t } = useTranslation()
  const unlock = useSession((s) => s.unlock)
  const forgetDevice = useSession((s) => s.forgetDevice)
  const displayName = useSession((s) => s.displayName)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [wrong, setWrong] = useState(false)

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <form
        className="card w-full max-w-sm space-y-4 text-center"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setWrong(false)
          try {
            const ok = await unlock(password)
            if (!ok) setWrong(true)
          } catch {
            setWrong(true)
          } finally {
            setBusy(false)
          }
        }}
      >
        <h1 className="font-display text-3xl text-gold">{t('unlock.title')}</h1>
        {displayName && <p className="text-ink-soft">{displayName}</p>}
        <input
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value)
            setWrong(false)
          }}
          placeholder={t('unlock.placeholder')}
          autoFocus
        />
        {wrong && <p className="text-sm text-danger">{t('unlock.wrong')}</p>}
        <button type="submit" className="btn-gold w-full" disabled={busy || !password}>
          {busy ? t('common.loading') : t('unlock.action')}
        </button>
        <button
          type="button"
          className="text-xs text-ink-faint hover:text-danger"
          onClick={() => {
            if (confirm(t('unlock.forgetConfirm'))) void forgetDevice()
          }}
        >
          {t('unlock.forget')}
        </button>
      </form>
    </div>
  )
}
