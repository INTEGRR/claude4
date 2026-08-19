'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { HexcoreMark } from '@/components/marke'
import { SprechenLog, useGespraech, ZUSTAND_TEXT } from './nutze-gespraech'

/**
 * Die Gesprächs-Oberfläche der Seite /sprechen: die eigentliche Sitzung lebt
 * im Hook useGespraech (geteilt mit dem Buddy-Modus des KI-Chats). Das
 * Hexcore ist die einzige Zustandsanzeige (hören = pulsierend, sprechen =
 * atmend), darunter läuft das kompakte Live-Log — kurze Zeilen mit Werten,
 * kein Volltranskript.
 *
 * Nach dem Beenden lädt router.refresh() die Seite neu — die gesammelten
 * Vorgänge erscheinen dann als Prüftabelle (gebucht wird NUR dort).
 */
export function Gespraech() {
  const router = useRouter()
  const [hosentasche, setHosentasche] = useState(false)
  const { zustand, fehler, log, aktiv, verbinden, trennen } = useGespraech({
    beiEnde: () => {
      setHosentasche(false)
      router.refresh()
    },
  })

  // Hosentaschen-Modus: app-seitig abgedunkelt + berührungsgesperrt, das
  // Gespräch läuft weiter (WebRTC-Audio wie ein Telefonat, In-Ears via
  // Bluetooth). Bewusst KEINE echte Bildschirmsperre — iOS würde dabei das
  // Mikrofon kappen; der Wake Lock hält den Schirm, die Abdunkelung spart
  // Augen und verhindert Hosentaschen-Tipper. Doppeltipp entsperrt.
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
    <section className="card">
      <div className="body" style={{ textAlign: 'center', padding: '28px 16px 20px' }}>
        {/* Das Hexcore ist die Zustandsanzeige: pulsiert beim Hören,
            atmet beim Antworten — intuitiv statt Statustext-Wüste. */}
        <div className={`sprechen-kern zustand-${zustand}`} aria-live="polite">
          <HexcoreMark groesse={96} variante="voll" />
        </div>
        <div className="mono-label" style={{ marginTop: 10 }}>{ZUSTAND_TEXT[zustand]}</div>

        <div style={{ marginTop: 16 }}>
          {!aktiv ? (
            <button
              className="primary"
              onClick={() => void verbinden()}
              disabled={zustand === 'verbindet'}
              style={{ minWidth: 200 }}
            >
              {zustand === 'verbindet' ? 'Verbinde …' : 'Verbinden'}
            </button>
          ) : (
            <span style={{ display: 'inline-flex', gap: 8 }}>
              <button className="wichtig" onClick={() => trennen(true)} style={{ minWidth: 170 }}>
                Beenden &amp; prüfen
              </button>
              <button onClick={() => setHosentasche(true)} title="Bildschirm abdunkeln und sperren — das Gespräch läuft weiter (In-Ears)">
                Hosentasche
              </button>
            </span>
          )}
        </div>
        {fehler && (
          <div className="notice danger" role="alert" style={{ marginTop: 12, display: 'inline-block' }}>
            <span className="led warn" style={{ marginRight: 6 }} />
            {fehler}{' '}
            <button className="small" onClick={() => void verbinden()} style={{ marginLeft: 8 }}>
              Neu verbinden
            </button>
          </div>
        )}

        {/* Kompaktes Live-Log: Themen und Werte, keine Textwüste. */}
        <SprechenLog log={log} />
      </div>
    </section>
  )
}
