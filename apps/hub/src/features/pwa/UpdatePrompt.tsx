import { useRegisterSW } from 'virtual:pwa-register/react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * "A new version is available" toast — updates only on explicit consent.
 *
 * The hook still runs in dev, because that is what registers the service worker and
 * push needs one. The toast doesn't: in dev the worker is rebuilt on virtually every
 * reload, so the prompt would be permanent and meaningless.
 */
export function UpdatePrompt() {
  const { t } = useTranslation()
  // `registerType: 'prompt'` only governs who calls skipWaiting. It does NOT govern the
  // reload: the moment *any* new worker takes control, vite-plugin-pwa calls
  // window.location.reload() by itself unless `onNeedReload` is supplied. A worker can
  // take control without this tab asking — another tab pressing the button below, a
  // browser-forced activation — and then the page reloads out from under whoever was
  // mid-sentence, which is exactly what registerType:'prompt' was chosen to prevent.
  //
  // It also loops. Chrome's "Update on reload" (DevTools → Application → Service
  // Workers) force-activates a new worker on every load, so: load → activate →
  // library reloads → load → … The page reloads about twice a second and the console
  // fills with "Service Worker was updated because Update on reload was checked".
  //
  // So we own the reload. A ref, not state: the options object is read once, on the
  // hook's first render, so a captured state value would never update.
  const consented = useRef(false)
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onNeedReload() {
      if (consented.current) window.location.reload()
    },
  })

  if (!needRefresh || import.meta.env.DEV) return null

  return (
    <div className="fixed bottom-4 inset-x-0 flex justify-center z-50 px-4">
      <div className="card flex items-center gap-4 py-3 shadow-lg">
        <span className="text-sm">{t('pwa.updateAvailable')}</span>
        <button
          type="button"
          className="btn-gold text-sm"
          onClick={() => {
            consented.current = true
            void updateServiceWorker(true)
          }}
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
