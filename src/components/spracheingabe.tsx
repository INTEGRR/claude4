'use client'
import { useEffect, useRef, useState } from 'react'

/**
 * Spracheingabe über Whisper: der Browser nimmt nur noch AUF (MediaRecorder),
 * transkribiert wird serverseitig über /api/transkription — keine Browser-
 * Raterei, ein Modell für alle Geräte, gut mit Fachvokabular. Ablauf: Klick
 * startet die Aufnahme (Puls), zweiter Klick stoppt sie, der Text landet im
 * Feld. Es wird nichts automatisch abgeschickt — gesprochen wird in das
 * Feld, entschieden mit Enter bzw. dem Senden-Pfeil.
 *
 * Ohne konfigurierten Dienst (OPENAI_API_KEY) oder ohne Mikrofon-API
 * erscheint der Knopf erst gar nicht.
 *
 * Die Knöpfe sind im Composer-Stil (runde Kapsel wie in der Claude-App);
 * das Senden-Symbol wohnt mit hier, damit alle Composer dasselbe nutzen.
 */

// Diktate sind kurz — die Leine verhindert versehentliche Dauerschleifen
// (Mikro an, Handy in die Tasche) und hält den Upload klein.
const MAX_AUFNAHME_MS = 90_000

// Ob der Server transkribieren kann, ändert sich nicht pro Knopf — einmal
// fragen, alle Mikrofon-Knöpfe der Seite teilen sich die Antwort.
let dienstVerfuegbar: Promise<boolean> | null = null
function dienstPruefen(): Promise<boolean> {
  dienstVerfuegbar ??= fetch('/api/transkription')
    .then(async (res) => {
      if (!res.ok) return false
      const daten = (await res.json()) as { verfuegbar?: boolean }
      return daten.verfuegbar === true
    })
    .catch(() => false)
  return dienstVerfuegbar
}

function aufnahmeFormat(): { mime: string; datei: string } {
  if (typeof MediaRecorder !== 'undefined') {
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus'))
      return { mime: 'audio/webm;codecs=opus', datei: 'aufnahme.webm' }
    if (MediaRecorder.isTypeSupported('audio/mp4'))
      return { mime: 'audio/mp4', datei: 'aufnahme.mp4' }
    if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus'))
      return { mime: 'audio/ogg;codecs=opus', datei: 'aufnahme.ogg' }
  }
  return { mime: '', datei: 'aufnahme.webm' }
}

function MikrofonSymbol() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  )
}

function StoppSymbol() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  )
}

/** Der Senden-Pfeil aller Composer (Befehlsfeld, KI-Chat, Zuruf-Zeile). */
export function SendenSymbol() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </svg>
  )
}

export function MikrofonKnopf({
  onText,
  onFertig,
  titel = 'Diktieren (Whisper, Deutsch)',
}: {
  /** Der transkribierte Text, sobald die Aufnahme verarbeitet ist. */
  onText: (text: string) => void
  /** Zusätzlicher Haken nach der Transkription (z. B. Fokus setzen). */
  onFertig?: (text: string) => void
  titel?: string
}) {
  const [verfuegbar, setVerfuegbar] = useState(false)
  const [zustand, setZustand] = useState<'aus' | 'aufnahme' | 'sendet'>('aus')
  const [fehler, setFehler] = useState<string | null>(null)
  const rekorder = useRef<MediaRecorder | null>(null)
  const leine = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const mikrofonDa =
      typeof MediaRecorder !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      Boolean(navigator.mediaDevices?.getUserMedia)
    if (!mikrofonDa) return
    let lebt = true
    void dienstPruefen().then((ok) => {
      if (lebt) setVerfuegbar(ok)
    })
    return () => {
      lebt = false
      if (leine.current) clearTimeout(leine.current)
      rekorder.current?.stream.getTracks().forEach((t) => t.stop())
    }
  }, [])

  async function hochladen(blob: Blob, datei: string) {
    setZustand('sendet')
    try {
      const form = new FormData()
      form.append('audio', new File([blob], datei, { type: blob.type }))
      const res = await fetch('/api/transkription', { method: 'POST', body: form })
      const daten = (await res.json().catch(() => ({}))) as { text?: string; error?: string }
      if (!res.ok || !daten.text) {
        setFehler(daten.error ?? `Transkription fehlgeschlagen (${res.status})`)
        return
      }
      onText(daten.text)
      onFertig?.(daten.text)
    } catch {
      setFehler('Verbindungsfehler bei der Transkription')
    } finally {
      setZustand('aus')
    }
  }

  async function umschalten() {
    setFehler(null)
    if (zustand === 'sendet') return
    if (zustand === 'aufnahme') {
      rekorder.current?.stop()
      return
    }
    try {
      const strom = await navigator.mediaDevices.getUserMedia({ audio: true })
      const { mime, datei } = aufnahmeFormat()
      const r = new MediaRecorder(strom, mime ? { mimeType: mime } : undefined)
      const stuecke: Blob[] = []
      r.ondataavailable = (e) => {
        if (e.data.size > 0) stuecke.push(e.data)
      }
      r.onstop = () => {
        if (leine.current) clearTimeout(leine.current)
        strom.getTracks().forEach((t) => t.stop())
        rekorder.current = null
        const blob = new Blob(stuecke, { type: mime || 'audio/webm' })
        if (blob.size > 0) void hochladen(blob, datei)
        else setZustand('aus')
      }
      rekorder.current = r
      r.start()
      setZustand('aufnahme')
      leine.current = setTimeout(() => rekorder.current?.stop(), MAX_AUFNAHME_MS)
    } catch {
      setFehler('Kein Zugriff aufs Mikrofon — Berechtigung im Browser erteilen')
    }
  }

  if (!verfuegbar) return null
  const beschriftung =
    zustand === 'aufnahme'
      ? 'Aufnahme beenden'
      : zustand === 'sendet'
        ? 'Transkribiert …'
        : (fehler ?? titel)
  return (
    <button
      type="button"
      className={`composer-knopf${zustand === 'aufnahme' ? ' mikro-an' : ''}${fehler ? ' mikro-fehler' : ''}`}
      title={beschriftung}
      aria-label={beschriftung}
      aria-pressed={zustand === 'aufnahme'}
      disabled={zustand === 'sendet'}
      onClick={() => void umschalten()}
    >
      {zustand === 'aufnahme' ? (
        <StoppSymbol />
      ) : zustand === 'sendet' ? (
        <span className="led on" />
      ) : (
        <MikrofonSymbol />
      )}
    </button>
  )
}
