'use client'

import { useState } from 'react'
import { Seg } from './anzeige'

/**
 * Der Sprachkanal in einem Bild: Zuruf, Rückfrage, Bestätigungstor. Die
 * Aussage des Bausteins ist nicht „KRNL versteht Sprache", sondern „die
 * Stimme bekommt keine Sonderrechte" — deshalb ist das Tor der eigentliche
 * Inhalt und nicht der Dialog darüber.
 */

const POSITIONEN = 12

export function SprechVorschau() {
  const [aufgenommen, setAufgenommen] = useState(false)

  return (
    <div className="anzeige">
      <div className="anzeige-kopf">
        <span className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span className="punkt" /> Inventur · Dialog
        </span>
        <span className="mono">Halle 2 · Packtisch 4</span>
      </div>

      <div className="blase stimme">
        <span className="wer">Stimme</span>
        Zähl Artikel SW-4021, Menge 48.
      </div>
      <div className="blase krnl">
        <span className="wer">KRNL</span>
        SW-4021 · Kippschalter grau · <strong>48 Stück</strong>. In die Prüftabelle aufnehmen?
      </div>

      {aufgenommen ? (
        <div className="tor erledigt">
          <div className="zeile">
            <span className="mono" style={{ color: '#FF5A1F' }}>In Prüftabelle aufgenommen</span>
            <button type="button" className="taste geist" onClick={() => setAufgenommen(false)}>
              Nochmal
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 10 }}>
            <span style={{ fontSize: 30 }}>
              <Seg wert={POSITIONEN} stellen={2} />
            </span>
            <span className="mono">Positionen · ungebucht</span>
          </div>
        </div>
      ) : (
        <div className="tor">
          <div className="zeile">
            <span className="mono">Bestätigung erforderlich</span>
            <span style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="taste fuehrend" onClick={() => setAufgenommen(true)}>
                Bestätigen
              </button>
              <button type="button" className="taste geist" onClick={() => setAufgenommen(false)}>
                Verwerfen
              </button>
            </span>
          </div>
        </div>
      )}

      <div className="anzeige-fuss">
        <span className="mono" style={{ textTransform: 'none', letterSpacing: '0.04em' }}>
          Buchung erst nach Sichtprüfung der Prüftabelle — gesammelt, nicht im Vorbeigehen.
        </span>
      </div>
    </div>
  )
}
