import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MicIcon } from '../../components/icons.tsx'

/** Prefer Opus-in-WebM; fall back to whatever the browser records. */
function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']) {
    if (MediaRecorder.isTypeSupported(m)) return m
  }
  return undefined
}

/**
 * A mic button that records a voice note via MediaRecorder. On stop it hands the raw
 * (unencrypted) audio Blob + duration to `onRecorded`; the caller encrypts + uploads
 * it (the recorder never touches the network). Tap to start, then send or cancel.
 */
export function VoiceRecorder({
  disabled,
  onRecorded,
}: {
  disabled?: boolean
  onRecorded: (blob: Blob, durationMs: number) => void
}) {
  const { t } = useTranslation()
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    // Safety net: stop any live recorder/timer if this unmounts mid-record.
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      const rec = recorderRef.current
      if (rec && rec.state !== 'inactive') {
        cancelledRef.current = true
        rec.stop()
      }
    }
  }, [])

  const start = async () => {
    if (disabled || !navigator.mediaDevices?.getUserMedia) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = pickMime()
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      chunksRef.current = []
      cancelledRef.current = false
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = () => {
        for (const track of stream.getTracks()) track.stop()
        if (timerRef.current) clearInterval(timerRef.current)
        setRecording(false)
        const durationMs = Date.now() - startRef.current
        if (!cancelledRef.current && chunksRef.current.length > 0) {
          onRecorded(new Blob(chunksRef.current, { type: rec.mimeType }), durationMs)
        }
      }
      recorderRef.current = rec
      startRef.current = Date.now()
      rec.start()
      setRecording(true)
      setElapsed(0)
      timerRef.current = setInterval(
        () => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)),
        250,
      )
    } catch {
      // mic permission denied / unavailable — no-op
    }
  }

  const finish = (cancel: boolean) => {
    cancelledRef.current = cancel
    recorderRef.current?.stop()
  }

  if (recording) {
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
    const ss = String(elapsed % 60).padStart(2, '0')
    return (
      <div className="flex items-center gap-2">
        <span className="text-danger animate-pulse" aria-hidden>
          ●
        </span>
        <span className="text-sm tabular-nums text-ink-soft">
          {mm}:{ss}
        </span>
        <button
          type="button"
          className="btn-quiet px-2 text-sm"
          onClick={() => finish(true)}
          title={t('common.cancel')}
        >
          ✕
        </button>
        <button
          type="button"
          className="btn-gold px-3 text-sm"
          onClick={() => finish(false)}
          title={t('chat.send')}
        >
          ▶
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      className="btn-mic"
      disabled={disabled}
      title={t('chat.recordVoice')}
      aria-label={t('chat.recordVoice')}
      onClick={() => void start()}
    >
      <MicIcon />
    </button>
  )
}
