import type { DeviceInfo, GrantSummary, MeResponse } from '@gathernet/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmButton } from '../components/ConfirmButton.tsx'
import { AppIcon, SCOPE_CHIP_KEYS } from '../features/apps/ConsentCard.tsx'
import { PushSettings } from '../features/pwa/PushSettings.tsx'
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
  const grants = useQuery({
    queryKey: ['app-grants'],
    queryFn: () => api<{ grants: GrantSummary[] }>('GET', '/api/v1/apps/grants'),
  })
  const revokeGrant = useMutation({
    mutationFn: (appId: string) => api('DELETE', `/api/v1/apps/grants/${appId}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['app-grants'] }),
  })

  const [name, setName] = useState<string | null>(null)

  return (
    <div className="max-w-md space-y-6 px-4 py-6">
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

      <PushSettings />

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
                <ConfirmButton
                  label={t('settings.revoke')}
                  question={t('settings.revokeConfirm', { name: device.name })}
                  className="btn-danger text-xs px-2 py-1"
                  onConfirm={() => revokeDevice.mutate(device.deviceId)}
                />
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="card space-y-3">
        <h2 className="font-medium text-ink-soft">{t('apps.connectedApps')}</h2>
        {grants.data && grants.data.grants.length === 0 && (
          <p className="text-xs text-ink-faint">{t('apps.noGrants')}</p>
        )}
        <ul className="space-y-2">
          {grants.data?.grants.map((grant) => (
            <li
              key={grant.appId}
              className="flex items-center gap-3 bg-overlay rounded-md px-3 py-2"
            >
              <AppIcon name={grant.name} iconUrl={grant.iconUrl} />
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate">{grant.name}</p>
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {grant.scopes.map((scope) => (
                    <span
                      key={scope}
                      className="text-[10px] uppercase tracking-wide bg-raised border border-edge rounded px-1.5 py-0.5 text-ink-soft"
                    >
                      {t(SCOPE_CHIP_KEYS[scope])}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-ink-faint mt-0.5">
                  {t('apps.lastUsed', { when: new Date(grant.lastUsedAt).toLocaleDateString() })}
                </p>
              </div>
              <ConfirmButton
                label={t('apps.revoke')}
                question={t('apps.revokeConfirm', { name: grant.name })}
                className="btn-danger text-xs px-2 py-1"
                onConfirm={() => revokeGrant.mutate(grant.appId)}
              />
            </li>
          ))}
        </ul>
        <Link to="/apps/connect" className="block text-sm text-gold hover:underline">
          {t('apps.connectWithCode')}
        </Link>
      </section>

      <button type="button" className="btn-quiet w-full" onClick={lock}>
        {t('unlock.action')}
      </button>
    </div>
  )
}
