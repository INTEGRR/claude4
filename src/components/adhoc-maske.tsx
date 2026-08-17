'use client'
import { useRef, useState } from 'react'
import { ProzessAktionen, type SchrittAngebot } from './prozess-aktionen'
import { MikrofonKnopf, SendenSymbol } from './spracheingabe'

/**
 * Ad-hoc-Maske mit KI-Zuruf: die GENERIERTE Maske steht sofort (das Schema
 * ist die Wahrheit) — und darunter baut ein Zuruf („ist aber Lieferant",
 * „Menge auf 500 und Preis 1,80") die Felder in Echtzeit um. Der Zuruf geht
 * an /api/ki/aktion/aendern, das Ergebnis wird gegen dasselbe Schema geprüft
 * und als neue Vorbelegung eingespielt — ausgeführt wird weiterhin nur über
 * den Absende-Knopf und den Torwächter.
 */
export function AdhocMaske({
  angebot,
  kiVerfuegbar,
}: {
  angebot: SchrittAngebot
  kiVerfuegbar: boolean
}) {
  const huelle = useRef<HTMLDivElement>(null)
  const [felder, setFelder] = useState(angebot.felder)
  const [version, setVersion] = useState(0)
  const [anweisung, setAnweisung] = useState('')
  const [busy, setBusy] = useState(false)
  const [hinweis, setHinweis] = useState<{ ok: boolean; text: string } | null>(null)

  /** Aktuelle Formularwerte einsammeln — die KI soll sehen, was schon dasteht. */
  function aktuelleWerte(): Record<string, unknown> {
    const form = huelle.current?.querySelector('form')
    const werte: Record<string, unknown> = {}
    if (!form) return werte
    const daten = new FormData(form)
    for (const feld of felder) {
      const roh = daten.get(feld.name)
      if (feld.typ === 'schalter') {
        werte[feld.name] = roh === 'on'
      } else if (roh != null && String(roh).trim() !== '') {
        werte[feld.name] = feld.typ === 'nummer' ? Number(roh) : String(roh)
      }
    }
    return werte
  }

  async function umbauen() {
    const text = anweisung.trim()
    if (!text || busy) return
    setBusy(true)
    setHinweis(null)
    try {
      const res = await fetch('/api/ki/aktion/aendern', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          aktion: angebot.aktionsName,
          parameter: aktuelleWerte(),
          anweisung: text,
        }),
      })
      const daten = (await res.json()) as {
        parameter?: Record<string, unknown>
        hinweis?: string | null
        error?: string
      }
      if (!res.ok || !daten.parameter) {
        setHinweis({ ok: false, text: daten.error ?? `Fehlgeschlagen (${res.status})` })
        return
      }
      // Neue Werte als Vorgaben einspielen; der key-Wechsel remountet die
      // unkontrollierten Felder mit den frischen defaultValues.
      const neu = daten.parameter
      setFelder((alt) =>
        alt.map((f) => ({
          ...f,
          vorgabe: f.name in neu ? (neu[f.name] as never) : undefined,
        })),
      )
      setVersion((v) => v + 1)
      setAnweisung('')
      setHinweis({ ok: true, text: daten.hinweis ?? 'Felder überarbeitet.' })
    } catch (err) {
      setHinweis({ ok: false, text: err instanceof Error ? err.message : 'Verbindungsfehler' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={huelle}>
      <ProzessAktionen
        key={version}
        schritte={[{ ...angebot, felder }]}
        sofortOffen={angebot.code}
      />
      {kiVerfuegbar && (
        <div style={{ marginTop: 10 }}>
          {/* Composer im Claude-App-Stil: Zuruf tippen oder diktieren, Pfeil baut um. */}
          <div className="composer">
            <input
              value={anweisung}
              onChange={(e) => setAnweisung(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void umbauen()
                }
              }}
              placeholder={'Umbau per Zuruf, z. B. „ist aber Lieferant" oder „Menge 500, Preis 1,80"'}
              disabled={busy}
            />
            <MikrofonKnopf onText={(text) => setAnweisung(text)} titel="Zuruf diktieren (Deutsch)" />
            <button
              type="button"
              className="composer-knopf senden"
              disabled={busy || !anweisung.trim()}
              onClick={() => void umbauen()}
              title="Felder umbauen"
              aria-label="Felder umbauen"
            >
              {busy ? <span className="led on" /> : <SendenSymbol />}
            </button>
          </div>
          {hinweis && (
            <div className={`notice ${hinweis.ok ? 'info' : 'danger'}`} style={{ marginTop: 8, marginBottom: 0 }}>
              {hinweis.text}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
