import { useRegisterSW } from 'virtual:pwa-register/react'
import { useTranslation } from 'react-i18next'

/** "A new version is available" toast — updates only on explicit consent. */
export function UpdatePrompt() {
  const { t } = useTranslation()
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW()

  if (!needRefresh) return null

  return (
    <div className="fixed bottom-4 inset-x-0 flex justify-center z-50 px-4">
      <div className="card flex items-center gap-4 py-3 shadow-lg">
        <span className="text-sm">{t('pwa.updateAvailable')}</span>
        <button
          type="button"
          className="btn-gold text-sm"
          onClick={() => updateServiceWorker(true)}
        >
          {t('pwa.reload')}
        </button>
        <button
          type="button"
          className="text-ink-faint text-sm hover:text-ink"
          onClick={() => setNeedRefresh(false)}
        >
          {t('common.close')}
        </button>
      </div>
    </div>
  )
}
