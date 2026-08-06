import type { UploadMediaResponse } from '@gathernet/shared'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, apiBytes } from '../../lib/api.ts'
import { getKMeta, openMedia, sealMedia } from '../../lib/community-keys.ts'
import { useKMetaVersion } from './meta.ts'

/** Server rejects ciphertext over 350KB (base64) with 413 — guard client-side. */
const MAX_CIPHERTEXT_B64 = 350 * 1024
/** Longest edge of the stored avatar. Keeps ciphertext comfortably tiny. */
const MAX_EDGE = 256

const SIZE_CLASS = {
  sm: 'h-8 w-8 text-[10px]',
  md: 'h-12 w-12 text-sm',
  lg: 'h-16 w-16 text-base',
} as const

type AvatarSize = keyof typeof SIZE_CLASS

function initials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '#'
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase()
  }
  return (parts[0] ?? '').slice(0, 2).toUpperCase() || '#'
}

/**
 * Rounded avatar for a community or channel. Fetches the encrypted media,
 * decrypts it with the community K_meta and renders it; falls back to a
 * monogram when there's no media or it can't be decrypted.
 */
export function CommunityAvatar({
  communityId,
  mediaId,
  label,
  size = 'md',
}: {
  communityId: string
  mediaId: string | null
  label: string
  size?: AvatarSize
}) {
  const [url, setUrl] = useState<string | null>(null)
  const kMetaVersion = useKMetaVersion()

  // biome-ignore lint/correctness/useExhaustiveDependencies: kMetaVersion re-decrypts the avatar once a cross-device grant supplies K_meta.
  useEffect(() => {
    setUrl(null)
    if (!mediaId) return
    let cancelled = false
    let objectUrl: string | null = null
    void (async () => {
      try {
        const kMeta = await getKMeta(communityId)
        if (!kMeta) return
        const bytes = await apiBytes(`/api/v1/communities/media/${mediaId}`)
        const plain = await openMedia(kMeta, bytes)
        if (!plain || cancelled) return
        // Copy into a fresh ArrayBuffer-backed view so the Blob typing is happy.
        const copy = new Uint8Array(plain.length)
        copy.set(plain)
        objectUrl = URL.createObjectURL(new Blob([copy]))
        setUrl(objectUrl)
      } catch {
        // fall back to the monogram
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [communityId, mediaId, kMetaVersion])

  // Communities read as struck seals: gold ring, jewel-tone field, serif monogram.
  const base = `${SIZE_CLASS[size]} rounded-full shrink-0 object-cover`
  if (url) {
    return (
      <span className={`${SIZE_CLASS[size]} seal shrink-0 overflow-hidden p-0`}>
        <img src={url} alt="" className={base} />
      </span>
    )
  }
  return (
    <span className={`${SIZE_CLASS[size]} seal uppercase`} aria-hidden>
      {initials(label)}
    </span>
  )
}

/** Resize to <=256px and encode as webp (jpeg fallback); return raw bytes. */
async function encodeAvatar(file: File): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  const toBlob = (type: string): Promise<Blob | null> =>
    new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, 0.85))
  const blob = (await toBlob('image/webp')) ?? (await toBlob('image/jpeg'))
  if (!blob) throw new Error('encode failed')
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * Avatar picker: choose an image, resize + seal it with K_meta, upload it to
 * the community media endpoint, and hand the resulting mediaId back so the
 * caller can persist it (PATCH community/channel `avatarMediaId`).
 */
export function AvatarUploader({
  communityId,
  currentMediaId,
  label,
  onUploaded,
  disabled,
}: {
  communityId: string
  currentMediaId: string | null
  label: string
  onUploaded: (mediaId: string) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewMediaId, setPreviewMediaId] = useState<string | null>(currentMediaId)

  const pick = async (file: File) => {
    setError(null)
    setBusy(true)
    try {
      const kMeta = await getKMeta(communityId)
      if (!kMeta) {
        setError(t('communities.avatarNoKey'))
        return
      }
      const bytes = await encodeAvatar(file)
      const ciphertext = await sealMedia(kMeta, bytes)
      if (ciphertext.length > MAX_CIPHERTEXT_B64) {
        setError(t('communities.avatarTooLarge'))
        return
      }
      const { mediaId } = await api<UploadMediaResponse>(
        'POST',
        `/api/v1/communities/${communityId}/media`,
        { ciphertext },
      )
      setPreviewMediaId(mediaId)
      onUploaded(mediaId)
    } catch {
      setError(t('communities.avatarFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-3">
      <CommunityAvatar communityId={communityId} mediaId={previewMediaId} label={label} size="lg" />
      <div className="space-y-1">
        <button
          type="button"
          className="btn-quiet text-xs px-2 py-1"
          disabled={busy || disabled}
          onClick={() => inputRef.current?.click()}
        >
          {busy
            ? t('common.loading')
            : previewMediaId
              ? t('communities.changeAvatar')
              : t('communities.uploadAvatar')}
        </button>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void pick(file)
          e.target.value = ''
        }}
      />
    </div>
  )
}
