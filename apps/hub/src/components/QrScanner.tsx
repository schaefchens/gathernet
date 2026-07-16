import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface QrScannerProps {
  /** Recognized payload prefixes, e.g. 'gathernet:invite:'. */
  prefixes: string[]
  /** Called once with the payload (prefix stripped) and the matched prefix. */
  onCode(payload: string, prefix: string): void
}

/**
 * Camera QR scanner built on BarcodeDetector. Renders the live preview, polls
 * for QR codes and stops after the first prefix match. Falls back to an
 * "unsupported" note when the API or the camera is unavailable.
 */
export function QrScanner({ prefixes, onCode }: QrScannerProps) {
  const { t } = useTranslation()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [unsupported, setUnsupported] = useState(false)
  const onCodeRef = useRef(onCode)
  onCodeRef.current = onCode
  const prefixesRef = useRef(prefixes)
  prefixesRef.current = prefixes

  useEffect(() => {
    if (!('BarcodeDetector' in globalThis)) {
      setUnsupported(true)
      return
    }
    let stream: MediaStream | null = null
    let stopped = false
    const Detector = (
      globalThis as unknown as {
        BarcodeDetector: new (options: {
          formats: string[]
        }) => {
          detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>
        }
      }
    ).BarcodeDetector
    const detector = new Detector({ formats: ['qr_code'] })

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        if (videoRef.current && !stopped) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
          const poll = async () => {
            if (stopped || !videoRef.current) return
            try {
              const codes = await detector.detect(videoRef.current)
              for (const code of codes) {
                const prefix = prefixesRef.current.find((p) => code.rawValue.startsWith(p))
                if (prefix) {
                  onCodeRef.current(code.rawValue.slice(prefix.length), prefix)
                  return
                }
              }
            } catch {
              // frame not ready — keep polling
            }
            setTimeout(poll, 300)
          }
          void poll()
        }
      } catch {
        setUnsupported(true)
      }
    })()

    return () => {
      stopped = true
      for (const track of stream?.getTracks() ?? []) track.stop()
    }
  }, [])

  if (unsupported) {
    return <p className="text-sm text-ink-soft">{t('qr.unsupported')}</p>
  }
  return (
    // biome-ignore lint/a11y/useMediaCaption: live camera preview has no audio
    <video ref={videoRef} className="w-full rounded-md bg-overlay aspect-square object-cover" />
  )
}
