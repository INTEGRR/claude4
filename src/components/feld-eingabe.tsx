import type { FormularFeld } from '@/modules/prozesse/schema-felder'

/**
 * DER Feld-Renderer der generierten Masken — eine Darstellung je Feldtyp,
 * benutzt von den Schrittformularen (prozess-aktionen.tsx), der Details-Karte
 * der Vorgangsseite und der Maskenvorschau in Onboarding/Werkstatt.
 *
 * Bewusst ohne 'use client' und ohne Hooks: alle Eingaben sind unkontrolliert
 * (defaultValue/defaultChecked), damit dieselbe Komponente in Server- wie
 * Client-Komponenten lebt. Der Ist-Wert eines Feldes kommt über
 * `feld.vorgabe` — wer eine Maske mit Bestandsdaten rendert, setzt sie dort.
 */
export function FeldEingabe({
  feld,
  optionen,
}: {
  feld: FormularFeld
  optionen?: { id: string; label: string }[]
}) {
  const name = feld.name
  const vorgabe = feld.vorgabe
  switch (feld.typ) {
    case 'schalter':
      return (
        <label className="field shrink" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {/* Abgewählte Checkboxen fehlen im FormData — der stille Begleiter
              sorgt dafür, dass „aus" überhaupt übertragen wird (die Auswertung
              nimmt den LETZTEN Wert des Namens). */}
          <input type="hidden" name={name} value="" />
          <input type="checkbox" name={name} defaultChecked={vorgabe === true} />
          <span>{feld.label}</span>
        </label>
      )
    case 'nummer':
      return (
        <label className="field shrink">
          <span>{feld.label}</span>
          <input
            type="number"
            name={name}
            step="any"
            required={feld.pflicht}
            defaultValue={typeof vorgabe === 'number' ? vorgabe : undefined}
            style={{ width: 110 }}
          />
        </label>
      )
    case 'auswahl':
      return (
        <label className="field shrink">
          <span>{feld.label}</span>
          <select name={name} required={feld.pflicht} defaultValue={typeof vorgabe === 'string' ? vorgabe : ''}>
            {!feld.pflicht && <option value="">—</option>}
            {(feld.auswahl ?? []).map((wert) => (
              <option key={wert} value={wert}>{wert}</option>
            ))}
          </select>
        </label>
      )
    case 'verweis':
      return (
        <label className="field" style={{ minWidth: 220 }}>
          <span>{feld.label}</span>
          <select
            name={name}
            required={feld.pflicht}
            defaultValue={typeof vorgabe === 'string' ? vorgabe : ''}
          >
            <option value="" disabled={feld.pflicht}>— auswählen —</option>
            {(optionen ?? []).map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </label>
      )
    case 'datum':
      return (
        <label className="field shrink">
          <span>{feld.label}</span>
          <input
            type="date"
            name={name}
            required={feld.pflicht}
            defaultValue={typeof vorgabe === 'string' ? vorgabe.slice(0, 10) : undefined}
          />
        </label>
      )
    case 'mehrzeilig':
      return (
        <label className="field" style={{ flex: '1 1 100%' }}>
          <span>{feld.label}</span>
          <textarea
            name={name}
            rows={3}
            required={feld.pflicht}
            defaultValue={typeof vorgabe === 'string' ? vorgabe : undefined}
          />
        </label>
      )
    case 'json':
      return (
        <label className="field" style={{ flex: '1 1 100%' }}>
          <span>{feld.label} <span className="muted small">(JSON)</span></span>
          <textarea className="mono" name={name} rows={2} required={feld.pflicht} placeholder="{}" />
        </label>
      )
    default:
      return (
        <label className="field">
          <span>{feld.label}</span>
          <input name={name} required={feld.pflicht}
                 defaultValue={typeof vorgabe === 'string' ? vorgabe : undefined} />
        </label>
      )
  }
}
