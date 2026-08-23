import { FeldEingabe } from '@/components/feld-eingabe'
import type { SchrittAngebot } from '@/components/prozess-aktionen'

/**
 * „So sieht eure Maske aus" — die generierte Maske eines Schritts als reine
 * VORSCHAU: dieselben Felder, derselbe Renderer wie im Betrieb
 * (FeldEingabe), aber ohne Formular und ohne Absenden. Wer ein Diagramm
 * abnimmt, nimmt hier auch ab, WAS erfasst wird — vorher war die Oberfläche
 * der einzige Teil des Entwurfs, den der Kunde nie zu sehen bekam.
 *
 * Bewusst KEIN ProzessAktionen (das POSTet an /api/aktion) und kein
 * 'use client': ein <fieldset disabled> genügt, die Eingaben sind
 * unkontrolliert und tot.
 */
export function MaskenVorschau({ angebot }: { angebot: SchrittAngebot }) {
  const sichtbar = angebot.felder.filter((f) => !(f.name in angebot.vorbelegung))
  return (
    <fieldset
      disabled
      style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 12, margin: 0 }}
    >
      <legend className="mono-label" style={{ padding: '0 6px' }}>
        Maske „{angebot.name}"
      </legend>
      {sichtbar.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          Diese Maske hat keine Eingabefelder — der Schritt ist ein reiner Knopf.
        </p>
      ) : (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {sichtbar.map((f) => (
            <FeldEingabe key={f.name} feld={f} optionen={angebot.optionen[f.name]} />
          ))}
        </div>
      )}
    </fieldset>
  )
}
