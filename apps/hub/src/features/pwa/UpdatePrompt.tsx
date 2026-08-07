import { useRegisterSW } from 'virtual:pwa-register/react'
import { useTranslation } from 'react-i18next'

/**
 * "A new version is available" toast — updates only on explicit consent.
 *
 * The hook still runs in dev, because that is what registers the service worker and
 * push needs one. The toast doesn't: in dev the worker is rebuilt on virtually every
 * reload, so the prompt would be permanent and meaningless. It is worth knowing that
 * Chrome's "Update on reload" checkbox (DevTools → Application → Service Workers)
 * forces that update every single load, which is what makes the prompt immortal.
 */
export function UpdatePrompt() {
  const { t } = useTranslation()
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW()

  if (!needRefresh || import.meta.env.DEV) return null

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
