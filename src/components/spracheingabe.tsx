'use client'
import { useEffect, useRef, useState } from 'react'

/**
 * Spracheingabe (Web Speech API, de-DE): ein Mikrofon-Knopf, der Diktat in
 * Echtzeit in ein Textfeld schreibt — fürs Befehlsfeld („Bestellung
 * anlegen"), den KI-Chat und die Zuruf-Zeile der Masken. Läuft komplett im
 * Browser (Chrome, Edge, Safari); wo die API fehlt, erscheint der Knopf
 * erst gar nicht. Es wird nichts automatisch abgeschickt — gesprochen wird
 * in das Feld, entschieden mit Enter bzw. dem Senden-Pfeil.
 *
 * Die Knöpfe sind im Composer-Stil (runde Kapsel wie in der Claude-App);
 * das Senden-Symbol wohnt mit hier, damit alle Composer dasselbe nutzen.
 */

interface ErkennungsAlternative {
  transcript: string
}
interface ErkennungsErgebnis {
  0: ErkennungsAlternative
  isFinal: boolean
}
interface ErkennungsEvent {
  results: { length: number; [index: number]: ErkennungsErgebnis }
}
interface Erkennung {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: ErkennungsEvent) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error?: string }) => void) | null
  start(): void
  stop(): void
}

function erkennungsKlasse(): (new () => Erkennung) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as Record<string, unknown>
  const K = w.SpeechRecognition ?? w.webkitSpeechRecognition
  return typeof K === 'function' ? (K as new () => Erkennung) : null
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
  titel = 'Spracheingabe (Deutsch)',
}: {
  /** Laufender Erkennungsstand — wird bei jedem Zwischenergebnis gerufen. */
  onText: (text: string) => void
  /** Endgültiger Text, wenn die Erkennung von selbst endet. */
  onFertig?: (text: string) => void
  titel?: string
}) {
  const [verfuegbar, setVerfuegbar] = useState(false)
  const [hoert, setHoert] = useState(false)
  const erkennung = useRef<Erkennung | null>(null)
  const letzterText = useRef('')

  useEffect(() => {
    setVerfuegbar(erkennungsKlasse() !== null)
    return () => erkennung.current?.stop()
  }, [])

  function umschalten() {
    if (hoert) {
      erkennung.current?.stop()
      return
    }
    const Klasse = erkennungsKlasse()
    if (!Klasse) return
    const e = new Klasse()
    e.lang = 'de-DE'
    e.continuous = false
    e.interimResults = true
    e.onresult = (ev) => {
      let text = ''
      for (let i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript
      letzterText.current = text.trim()
      onText(letzterText.current)
    }
    e.onend = () => {
      setHoert(false)
      if (letzterText.current) onFertig?.(letzterText.current)
    }
    e.onerror = () => setHoert(false)
    erkennung.current = e
    letzterText.current = ''
    e.start()
    setHoert(true)
  }

  if (!verfuegbar) return null
  return (
    <button
      type="button"
      className={`composer-knopf${hoert ? ' mikro-an' : ''}`}
      title={hoert ? 'Aufnahme beenden' : titel}
      aria-label={hoert ? 'Aufnahme beenden' : titel}
      aria-pressed={hoert}
      onClick={umschalten}
    >
      <MikrofonSymbol />
    </button>
  )
}
