import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { downloadAndDecrypt } from '../../lib/media.ts'
import type { MediaRef } from '../../lib/message-body.ts'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Downloads an attachment's ciphertext and decrypts it locally (the key comes from
 * the E2EE message body), then renders an inline image or a file-download link. The
 * object URL is created after decryption and revoked on unmount — plaintext never
 * touches the network or the server.
 */
export function MediaAttachment({ media }: { media: MediaRef }) {
  const { t } = useTranslation()
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const isImage = media.mime.startsWith('image/')

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    void (async () => {
      try {
        const blob = await downloadAndDecrypt(media)
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [media])

  if (failed) return <p className="text-xs text-danger">{t('chat.mediaFailed')}</p>
  if (!url) return <p className="text-xs text-ink-faint">{t('common.loading')}</p>
  if (isImage) {
    return (
      // biome-ignore lint/a11y/useAltText: user media has no alt; name is decorative
      <img
        src={url}
        alt={media.name ?? ''}
        className="rounded max-w-full max-h-64 object-contain"
      />
    )
  }
  return (
    <a
      href={url}
      download={media.name ?? 'file'}
      className="text-sm text-indigo-soft underline break-all"
    >
      📎 {media.name ?? t('chat.download')} · {formatSize(media.size)}
    </a>
  )
}
