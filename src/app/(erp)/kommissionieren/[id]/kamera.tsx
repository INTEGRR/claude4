'use client'
import { useEffect, useRef, useState } from 'react'

/**
 * Barcode-Scan mit der Handykamera (0091). Wo der Browser einen eigenen
 * BarcodeDetector mit Formaten mitbringt (Chrome auf Android), nimmt er
 * den; sonst — etwa Safari auf iPhone/iPad — wird @zxing/browser erst bei
 * Bedarf nachgeladen. Derselbe Code zweimal hintereinander zählt erst nach
 * einer Pause erneut, damit ein ruhig gehaltener Artikel nicht mehrfach
 * zählt.
 */

const ENTPRELLEN_MS = 1500

interface Detektor {
  detect(quelle: HTMLVideoElement): Promise<{ rawValue: string }[]>
}
interface DetektorKlasse {
  new (optionen?: { formats: string[] }): Detektor
  getSupportedFormats?: () => Promise<string[]>
}

function kameraFehler(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  if (name === 'NotAllowedError') {
    return 'Kamerazugriff verweigert — in den Browser-Einstellungen für diese Seite erlauben.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Keine Kamera gefunden.'
  if (name === 'NotReadableError') return 'Die Kamera wird gerade von einer anderen App benutzt.'
  return err instanceof Error ? err.message : 'Kamera ließ sich nicht starten.'
}

export function Kamera({ onCode, onSchliessen }: { onCode: (code: string) => void; onSchliessen: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const meldenRef = useRef(onCode)
  useEffect(() => {
    meldenRef.current = onCode
  }, [onCode])
  const [fehler, setFehler] = useState<string | null>(null)
  const [weg, setWeg] = useState<'nativ' | 'zxing' | null>(null)

  useEffect(() => {
    let aus = false
    let stoppen: (() => void) | null = null
    let letzter = { code: '', zeit: 0 }
    const melden = (code: string) => {
      const jetzt = Date.now()
      if (code === letzter.code && jetzt - letzter.zeit < ENTPRELLEN_MS) return
      letzter = { code, zeit: jetzt }
      meldenRef.current(code)
    }

    async function starten() {
      const video = videoRef.current
      if (!video) return
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Kamera nur über HTTPS verfügbar.')
      }
      const Klasse = (window as unknown as { BarcodeDetector?: DetektorKlasse }).BarcodeDetector
      const formate = Klasse ? ((await Klasse.getSupportedFormats?.().catch(() => [])) ?? []) : []

      if (Klasse && formate.length > 0) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        })
        if (aus) {
          for (const spur of stream.getTracks()) spur.stop()
          return
        }
        video.srcObject = stream
        await video.play()
        setWeg('nativ')
        const detektor = new Klasse({ formats: formate })
        let takt = 0
        const tick = async () => {
          if (aus) return
          try {
            const treffer = await detektor.detect(video)
            const code = treffer[0]?.rawValue?.trim()
            if (code) melden(code)
          } catch {
            // Einzelbild nicht lesbar — nächster Versuch.
          }
          takt = window.setTimeout(tick, 200)
        }
        void tick()
        stoppen = () => {
          window.clearTimeout(takt)
          for (const spur of stream.getTracks()) spur.stop()
        }
        return
      }

      const { BrowserMultiFormatReader } = await import('@zxing/browser')
      const leser = new BrowserMultiFormatReader()
      const steuerung = await leser.decodeFromConstraints(
        { video: { facingMode: 'environment' }, audio: false },
        video,
        (ergebnis) => {
          const code = ergebnis?.getText().trim()
          if (code) melden(code)
        },
      )
      if (aus) steuerung.stop()
      else {
        setWeg('zxing')
        stoppen = () => steuerung.stop()
      }
    }

    starten().catch((err) => {
      if (!aus) setFehler(kameraFehler(err))
    })
    return () => {
      aus = true
      stoppen?.()
    }
  }, [])

  return (
    <div className="kommi-kamera">
      <video ref={videoRef} muted playsInline aria-label="Kamerabild zum Scannen" />
      <div className="kommi-kamera-zeile">
        <span className="mono-label">
          {fehler ? 'Kamera aus' : weg ? 'Kamera scannt — Barcode ins Bild halten' : 'Kamera startet…'}
        </span>
        <button type="button" className="small" onClick={onSchliessen}>
          Kamera schließen
        </button>
      </div>
      {fehler && (
        <div className="notice danger" role="alert" style={{ margin: 0 }}>
          {fehler}
        </div>
      )}
    </div>
  )
}
