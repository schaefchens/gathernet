import type { DeviceInfo, MeResponse } from '@gathernet/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { setLanguage } from '../i18n/index.ts'
import { api } from '../lib/api.ts'
import { chatStore } from '../stores/chat.ts'
import { useSession } from '../stores/session.ts'

export const Route = createFileRoute('/settings')({ component: SettingsScreen })

function SettingsScreen() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const lock = useSession((s) => s.lock)
  const currentDeviceId = useSession((s) => s.deviceId)

  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<MeResponse>('GET', '/api/v1/accounts/me'),
  })
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => api<{ devices: DeviceInfo[] }>('GET', '/api/v1/devices'),
  })
  const updateMe = useMutation({
    mutationFn: (patch: { displayName?: string; presencePref?: string }) =>
      api<MeResponse>('PATCH', '/api/v1/accounts/me', patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['me'] }),
  })
  const revokeDevice = useMutation({
    mutationFn: (deviceId: string) => api('POST', `/api/v1/devices/${deviceId}/revoke`),
    onSuccess: (_data, deviceId) => {
      void queryClient.invalidateQueries({ queryKey: ['devices'] })
      // Post-compromise security: evict the revoked leaf from all MLS groups.
      void chatStore.removeDeviceFromGroups(deviceId)
    },
  })

  const [name, setName] = useState<string | null>(null)

  return (
    <div className="space-y-6 max-w-md">
      <h1 className="font-display text-3xl">{t('settings.title')}</h1>

      <section className="card space-y-4">
        <h2 className="font-medium text-ink-soft">{t('settings.profile')}</h2>
        <label className="block text-sm text-ink-soft">
          {t('settings.displayName')}
          <div className="flex gap-2 mt-1">
            <input
              value={name ?? me.data?.displayName ?? ''}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
            />
            {name !== null && name !== me.data?.displayName && (
              <button
                type="button"
                className="btn-gold"
                onClick={() => {
                  updateMe.mutate({ displayName: name.trim() })
                  setName(null)
                }}
              >
                {t('common.save')}
              </button>
            )}
          </div>
        </label>
        <label className="block text-sm text-ink-soft">
          {t('settings.language')}
          <select
            className="mt-1 w-full bg-overlay border border-edge rounded-md px-3 py-2"
            value={i18n.language.startsWith('de') ? 'de' : 'en'}
            onChange={(e) => setLanguage(e.target.value as 'en' | 'de')}
          >
            <option value="en">English</option>
            <option value="de">Deutsch</option>
          </select>
        </label>
        <label className="block text-sm text-ink-soft">
          {t('settings.presenceDefault')}
          <select
            className="mt-1 w-full bg-overlay border border-edge rounded-md px-3 py-2"
            value={me.data?.presencePref ?? 'online'}
            onChange={(e) => updateMe.mutate({ presencePref: e.target.value })}
          >
            <option value="online">{t('friends.presence.online')}</option>
            <option value="away">{t('friends.presence.away')}</option>
            <option value="invisible">{t('friends.presence.invisible')}</option>
          </select>
        </label>
      </section>

      <section className="card space-y-3">
        <h2 className="font-medium text-ink-soft">{t('settings.devices')}</h2>
        <p className="text-xs text-ink-faint">{t('settings.addDevice')}</p>
        <ul className="space-y-2">
          {devices.data?.devices.map((device) => (
            <li
              key={device.deviceId}
              className="flex items-center gap-3 bg-overlay rounded-md px-3 py-2"
            >
              <div className="flex-1">
                <p className="text-sm">
                  {device.name}
                  {device.isCurrent && (
                    <span className="ml-2 text-xs text-gold">{t('settings.thisDevice')}</span>
                  )}
                </p>
                <p className="text-xs text-ink-faint">
                  {device.status === 'revoked'
                    ? t('settings.revoked')
                    : device.lastSeenAt
                      ? t('settings.lastSeen', {
                          when: new Date(device.lastSeenAt).toLocaleDateString(),
                        })
                      : new Date(device.createdAt).toLocaleDateString()}
                </p>
              </div>
              {!device.isCurrent && device.status === 'active' && currentDeviceId && (
                <button
                  type="button"
                  className="btn-danger text-xs px-2 py-1"
                  onClick={() => {
                    if (confirm(t('settings.revokeConfirm', { name: device.name }))) {
                      revokeDevice.mutate(device.deviceId)
                    }
                  }}
                >
                  {t('settings.revoke')}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <button type="button" className="btn-quiet w-full" onClick={lock}>
        🔒 {t('unlock.action')}
      </button>
    </div>
  )
}
