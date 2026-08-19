'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { HexcoreMark } from '@/components/marke'
import { SprechenLog, useGespraech, ZUSTAND_TEXT } from '@/components/nutze-gespraech'

/**
 * Das Sprach-Interview der Werkstatt: die Prozess-Aufnahme beim Kunden.
 * Dieselbe Sitzung wie /sprechen, aber im Aufnahme-Modus (Interview-
 * Anleitung, nur zwei Werkzeuge). Sobald die Strukturierung den Entwurf
 * angelegt hat, springt die Seite direkt auf dessen Diagramm-Vorschau.
 */
export function WerkstattAufnahme() {
  const router = useRouter()
  const [hosentasche, setHosentasche] = useState(false)
  const { zustand, fehler, log, aktiv, verbinden, trennen } = useGespraech({
    beiEntwurf: (code) => {
      router.push(`/prozesse/werkstatt?code=${encodeURIComponent(code)}`)
      router.refresh()
    },
  })

  // Hosentaschen-Modus fürs Interview unterwegs (siehe gespraech.tsx —
  // bewusst keine echte Bildschirmsperre, iOS würde das Mikrofon kappen).
  if (hosentasche && aktiv) {
    return (
      <div
        className="sprechen-hosentasche"
        onDoubleClick={() => setHosentasche(false)}
        role="button"
        aria-label="Hosentaschen-Modus — Doppeltipp zum Entsperren"
      >
        <div className={`sprechen-kern zustand-${zustand}`}>
          <HexcoreMark groesse={72} variante="voll" />
        </div>
        <div className="mono-label" style={{ opacity: 0.5, marginTop: 14 }}>
          Doppeltipp zum Entsperren
        </div>
      </div>
    )
  }

  return (
    <section className="card" style={{ marginTop: 12 }}>
      <header>
        <span>Prozess-Aufnahme (Sprach-Interview)</span>
        <span className="actions">
          <span className="mono-label">{ZUSTAND_TEXT[zustand]}</span>
        </span>
      </header>
      <div className="body" style={{ textAlign: 'center', padding: '18px 16px 16px' }}>
        <div className={`sprechen-kern zustand-${zustand}`} aria-live="polite">
          <HexcoreMark groesse={64} variante="voll" />
        </div>
        <div style={{ marginTop: 12 }}>
          {!aktiv ? (
            <button
              className="wichtig"
              onClick={() => void verbinden('aufnahme')}
              disabled={zustand === 'verbindet'}
              title="Ist-Prozess beim Kunden aufnehmen — die KI führt das Interview; am Ende entsteht ein Entwurf mit Diagramm"
              style={{ minWidth: 220 }}
            >
              {zustand === 'verbindet' ? 'Verbinde …' : 'Sprach-Interview starten'}
            </button>
          ) : (
            <span style={{ display: 'inline-flex', gap: 8 }}>
              <button onClick={() => trennen(true)} style={{ minWidth: 140 }}>
                Interview beenden
              </button>
              <button
                onClick={() => setHosentasche(true)}
                title="Bildschirm abdunkeln und sperren — das Gespräch läuft weiter (In-Ears)"
              >
                Hosentasche
              </button>
            </span>
          )}
        </div>
        {fehler && (
          <div className="notice danger" role="alert" style={{ marginTop: 12, display: 'inline-block' }}>
            <span className="led warn" style={{ marginRight: 6 }} />
            {fehler}
          </div>
        )}
        <SprechenLog log={log} />
      </div>
    </section>
  )
}
