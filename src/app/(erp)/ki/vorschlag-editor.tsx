'use client'

/**
 * Editor für die Felder eines Aktionsvorschlags.
 *
 * Ein Vorschlag ist nichts als ein JSON-Objekt, dessen Form die jeweilige
 * Aktion vorgibt — mal flach (Kontakt), mal zwei Ebenen tief (Produkt mit
 * Attributen und deren Werten). Statt für jede Aktion ein eigenes Formular zu
 * bauen, leitet dieser Editor die Darstellung aus den Daten ab: Skalare
 * werden Eingabefelder, Objektlisten werden Tabellen mit editierbaren Zellen.
 *
 * Was er bewusst NICHT tut: Feldnamen erfinden oder Typen ändern. Er
 * bearbeitet, was da ist — geprüft wird ohnehin serverseitig gegen das Schema
 * der Aktion, bevor irgendetwas angelegt wird.
 */

type Wert = unknown

/** Unveränderliches Setzen entlang eines Pfads aus Schlüsseln und Indizes. */
function setzeIn(wurzel: Wert, pfad: (string | number)[], neu: Wert): Wert {
  if (pfad.length === 0) return neu
  const [kopf, ...rest] = pfad
  if (typeof kopf === 'number') {
    const liste = Array.isArray(wurzel) ? [...wurzel] : []
    liste[kopf] = setzeIn(liste[kopf], rest, neu)
    return liste
  }
  const objekt = { ...(wurzel as Record<string, Wert>) }
  objekt[kopf] = setzeIn(objekt[kopf], rest, neu)
  return objekt
}

function entferneAus(wurzel: Wert, pfad: (string | number)[], index: number): Wert {
  const liste = (pfad.reduce<Wert>((w, k) => (w as Record<string, Wert>)?.[k as string], wurzel) ??
    []) as Wert[]
  return setzeIn(wurzel, pfad, liste.filter((_, i) => i !== index))
}

/** Leere Kopie einer Listenzeile — gleiche Schlüssel, geleerte Werte. */
function leereZeile(vorlage: Record<string, Wert> | undefined): Record<string, Wert> {
  if (!vorlage) return {}
  return Object.fromEntries(
    Object.entries(vorlage).map(([k, v]) => [
      k,
      typeof v === 'number' ? 0 : typeof v === 'boolean' ? false : Array.isArray(v) ? [] : '',
    ]),
  )
}

const istObjektliste = (v: Wert): v is Record<string, Wert>[] =>
  Array.isArray(v) && v.length > 0 && v.every((e) => e !== null && typeof e === 'object' && !Array.isArray(e))

export function Zelle({
  wert,
  onChange,
  breit,
}: {
  wert: Wert
  onChange: (neu: Wert) => void
  breit?: boolean
}) {
  if (typeof wert === 'boolean') {
    return <input type="checkbox" checked={wert} onChange={(e) => onChange(e.target.checked)} />
  }
  if (typeof wert === 'number') {
    return (
      <input
        type="number"
        step="any"
        value={wert}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
        style={{ width: 90 }}
      />
    )
  }
  return (
    <input
      value={wert === null || wert === undefined ? '' : String(wert)}
      onChange={(e) => onChange(e.target.value)}
      style={breit ? undefined : { minWidth: 90 }}
    />
  )
}

function Feld({
  name,
  wert,
  pfad,
  tiefe,
  onChange,
  onEntfernen,
}: {
  name: string
  wert: Wert
  pfad: (string | number)[]
  tiefe: number
  onChange: (pfad: (string | number)[], neu: Wert) => void
  onEntfernen: (pfad: (string | number)[], index: number) => void
}) {
  // Objektlisten als Tabelle: eine Spalte je Schlüssel, jede Zelle editierbar.
  if (istObjektliste(wert) && tiefe < 3) {
    const spalten = [...new Set(wert.flatMap((z) => Object.keys(z)))]
    return (
      <div style={{ margin: '8px 0' }}>
        <div className="mono-label" style={{ marginBottom: 4 }}>
          {name} ({wert.length})
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {spalten.map((s) => (
                  <th key={s}>{s}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {wert.map((zeile, i) => (
                <tr key={i}>
                  {spalten.map((s) => (
                    <td key={s}>
                      {/* Verschachtelte Listen (Attribut → Werte) bekommen
                          ihre eigene Tabelle, sonst eine Zelle. */}
                      {istObjektliste(zeile[s]) && tiefe < 2 ? (
                        <Feld
                          name={s}
                          wert={zeile[s]}
                          pfad={[...pfad, i, s]}
                          tiefe={tiefe + 1}
                          onChange={onChange}
                          onEntfernen={onEntfernen}
                        />
                      ) : (
                        <Zelle
                          wert={zeile[s]}
                          onChange={(neu) => onChange([...pfad, i, s], neu)}
                        />
                      )}
                    </td>
                  ))}
                  <td className="num">
                    <button
                      type="button"
                      className="small danger"
                      title="Zeile entfernen"
                      onClick={() => onEntfernen(pfad, i)}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          className="small"
          style={{ marginTop: 4 }}
          onClick={() => onChange([...pfad, wert.length], leereZeile(wert[0]))}
        >
          Zeile hinzufügen
        </button>
      </div>
    )
  }

  // Alles Verschachtelte, was keine Objektliste ist, bleibt ehrlich JSON —
  // ein erfundenes Formular wäre hier schlechter als der Rohwert.
  if (wert !== null && typeof wert === 'object') {
    return (
      <label className="field" style={{ margin: '6px 0' }}>
        <span>{name}</span>
        <textarea
          rows={Math.min(8, JSON.stringify(wert, null, 2).split('\n').length)}
          defaultValue={JSON.stringify(wert, null, 2)}
          onBlur={(e) => {
            try {
              onChange(pfad, JSON.parse(e.target.value))
            } catch {
              // Ungültiges JSON: Feld bleibt stehen, damit nichts verloren geht.
            }
          }}
        />
      </label>
    )
  }

  return (
    <label
      className="field"
      style={
        typeof wert === 'boolean'
          ? { flexDirection: 'row', alignItems: 'center', gap: 8, margin: '6px 0' }
          : { margin: '6px 0' }
      }
    >
      <span>{name}</span>
      <Zelle wert={wert} onChange={(neu) => onChange(pfad, neu)} breit />
    </label>
  )
}

export function VorschlagEditor({
  parameter,
  onChange,
}: {
  parameter: Record<string, unknown>
  onChange: (neu: Record<string, unknown>) => void
}) {
  const setzen = (pfad: (string | number)[], neu: Wert) =>
    onChange(setzeIn(parameter, pfad, neu) as Record<string, unknown>)
  const entfernen = (pfad: (string | number)[], index: number) =>
    onChange(entferneAus(parameter, pfad, index) as Record<string, unknown>)

  const eintraege = Object.entries(parameter)
  // Skalare zuerst, Listen darunter — sonst versinken Name und Preis zwischen
  // zwei Tabellen.
  const skalare = eintraege.filter(([, v]) => v === null || typeof v !== 'object')
  const rest = eintraege.filter(([, v]) => v !== null && typeof v === 'object')

  return (
    <div style={{ margin: '4px 0 10px' }}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {skalare.map(([name, wert]) => (
          <Feld
            key={name}
            name={name}
            wert={wert}
            pfad={[name]}
            tiefe={0}
            onChange={setzen}
            onEntfernen={entfernen}
          />
        ))}
      </div>
      {rest.map(([name, wert]) => (
        <Feld
          key={name}
          name={name}
          wert={wert}
          pfad={[name]}
          tiefe={0}
          onChange={setzen}
          onEntfernen={entfernen}
        />
      ))}
    </div>
  )
}
