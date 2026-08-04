import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  disablePush,
  enablePush,
  getDisplayPrefs,
  getPushState,
  isPushSupported,
  setDisplayPrefs,
  updateServerPushPrefs,
} from '../../lib/push.ts'

/**
 * Notification settings. A push carries only a category code; nothing here (or on the
 * server) ever sees message content. "Whether to push" (enable, categories) is
 * server-side; "how to show it" (coarse vs generic) is local + read by the SW.
 */
export function PushSettings() {
  const { t } = useTranslation()
  const [subscribed, setSubscribed] = useState(false)
  const [permission, setPermission] = useState<NotificationPermission>('default')
  const [contentLevel, setContentLevel] = useState<'coarse' | 'generic'>('coarse')
  const [cats, setCats] = useState({ dm: true, channel: true, moderation: true })
  const [customTitle, setCustomTitle] = useState('')
  const [hasCustomIcon, setHasCustomIcon] = useState(false)
  const [busy, setBusy] = useState(false)
  const supported = isPushSupported()

  useEffect(() => {
    if (!supported) return
    void getPushState().then((s) => {
      setSubscribed(s.subscribed)
      setPermission(s.permission)
    })
    void getDisplayPrefs().then((p) => {
      setContentLevel(p.contentLevel)
      setCustomTitle(p.title ?? '')
      setHasCustomIcon(!!p.icon)
    })
  }, [supported])

  if (!supported) {
    return (
      <section className="card space-y-2">
        <h2 className="font-medium">{t('settings.push.title')}</h2>
        <p className="text-sm text-ink-faint">{t('settings.push.unsupported')}</p>
      </section>
    )
  }

  const toggle = async () => {
    setBusy(true)
    try {
      if (subscribed) {
        await disablePush()
        setSubscribed(false)
      } else {
        const ok = await enablePush()
        setSubscribed(ok)
        setPermission(Notification.permission)
      }
    } catch (err) {
      console.error('push toggle failed', err)
    } finally {
      setBusy(false)
    }
  }

  const changeContent = (level: 'coarse' | 'generic') => {
    setContentLevel(level)
    void setDisplayPrefs({ contentLevel: level })
  }

  const changeCat = (key: keyof typeof cats, on: boolean) => {
    const next = { ...cats, [key]: on }
    setCats(next)
    void updateServerPushPrefs({ categories: next })
  }

  const changeTitle = (value: string) => {
    setCustomTitle(value)
    void setDisplayPrefs({ title: value })
  }

  const pickIcon = (file: File | undefined) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      void setDisplayPrefs({ icon: String(reader.result) })
      setHasCustomIcon(true)
    }
    reader.readAsDataURL(file)
  }

  const clearIcon = () => {
    void setDisplayPrefs({ icon: undefined })
    setHasCustomIcon(false)
  }

  return (
    <section className="card space-y-3">
      <h2 className="font-medium">{t('settings.push.title')}</h2>
      <p className="text-xs text-ink-faint">{t('settings.push.explainer')}</p>

      <button
        type="button"
        className={subscribed ? 'btn-quiet text-sm' : 'btn-gold text-sm'}
        disabled={busy || permission === 'denied'}
        onClick={() => void toggle()}
      >
        {subscribed ? t('settings.push.disable') : t('settings.push.enable')}
      </button>
      {permission === 'denied' && (
        <p className="text-xs text-danger">{t('settings.push.blocked')}</p>
      )}

      {subscribed && (
        <>
          <label className="block space-y-1">
            <span className="text-xs text-ink-soft">{t('settings.push.content')}</span>
            <select
              className="w-full bg-overlay border border-edge rounded-md px-3 py-2 text-sm"
              value={contentLevel}
              onChange={(e) => changeContent(e.target.value as 'coarse' | 'generic')}
            >
              <option value="coarse">{t('settings.push.coarse')}</option>
              <option value="generic">{t('settings.push.generic')}</option>
            </select>
          </label>

          <div className="space-y-1">
            <span className="text-xs text-ink-soft">{t('settings.push.categories')}</span>
            {(['dm', 'channel', 'moderation'] as const).map((k) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={cats[k]}
                  onChange={(e) => changeCat(k, e.target.checked)}
                />
                {t(`settings.push.cat_${k}`)}
              </label>
            ))}
          </div>

          <div className="space-y-1 border-t border-edge pt-3">
            <span className="text-xs text-ink-soft">{t('settings.push.disguise')}</span>
            <p className="text-[11px] text-ink-faint">{t('settings.push.disguiseNote')}</p>
            <input
              value={customTitle}
              onChange={(e) => changeTitle(e.target.value)}
              placeholder={t('settings.push.titlePlaceholder')}
              className="text-sm"
            />
            <div className="flex items-center gap-2">
              <label className="btn-quiet text-xs px-3 cursor-pointer">
                {t('settings.push.pickIcon')}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    pickIcon(e.target.files?.[0])
                    e.target.value = ''
                  }}
                />
              </label>
              {hasCustomIcon && (
                <button
                  type="button"
                  className="text-xs text-ink-faint hover:text-danger"
                  onClick={clearIcon}
                >
                  {t('settings.push.clearIcon')}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  )
}
