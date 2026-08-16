'use client'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import type { FormularFeld } from '@/modules/prozesse/schema-felder'

/**
 * Die aktive Seite des Prozess-Panels: die JETZT möglichen Schritte als
 * Tasten, dahinter GENERIERTE Formulare aus den Registry-Schemas. Abgeschickt
 * wird an POST /api/aktion/<name> — denselben Torwächter wie alle Knöpfe.
 *
 * Felder, die der Prozessschritt per params festlegt (z. B. status=behoben
 * am Schritt „Beheben"), erscheinen nicht als Eingabe: der Schritt definiert
 * sie, das Formular zeigt nur die offenen Angaben.
 */

export interface SchrittAngebot {
  code: string
  name: string
  aktionsName: string
  felder: FormularFeld[]
  /** Vorbelegung aus den Schritt-params — wird fest mitgesendet. */
  vorbelegung: Record<string, unknown>
  /** Auswahllisten für Verweisfelder, vom Server aufgelöst. */
  optionen: Record<string, { id: string; label: string }[]>
  erlaubt: boolean
  hinweis?: string
}

function eingabeWert(feld: FormularFeld, roh: FormDataEntryValue | null): unknown {
  if (feld.typ === 'schalter') return roh === 'on'
  if (roh === null || (typeof roh === 'string' && roh.trim() === '')) return undefined
  const text = String(roh).trim()
  if (feld.typ === 'nummer') return Number(text)
  if (feld.typ === 'json') return JSON.parse(text)
  return text
}

function Feld({ feld, optionen }: { feld: FormularFeld; optionen?: { id: string; label: string }[] }) {
  const name = feld.name
  const vorgabe = feld.vorgabe
  switch (feld.typ) {
    case 'schalter':
      return (
        <label className="field shrink" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
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
          <select name={name} required={feld.pflicht} defaultValue="">
            <option value="" disabled={feld.pflicht}>— auswählen —</option>
            {(optionen ?? []).map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </label>
      )
    case 'mehrzeilig':
      return (
        <label className="field" style={{ flex: '1 1 100%' }}>
          <span>{feld.label}</span>
          <textarea name={name} rows={3} required={feld.pflicht} />
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

export function ProzessAktionen({
  schritte,
  recordId,
  instanzId,
}: {
  schritte: SchrittAngebot[]
  /** Beleggebundener Prozess: die Beleg-ID des Aufrufs. */
  recordId?: string
  /** Belegloser Assistent: die Instanz, die nach Erfolg weitergeschaltet wird. */
  instanzId?: string
}) {
  const router = useRouter()
  const [offen, setOffen] = useState<string | null>(null)
  const [fehler, setFehler] = useState<string | null>(null)
  const [meldung, setMeldung] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  async function ausfuehren(schritt: SchrittAngebot, parameter: Record<string, unknown>) {
    setFehler(null)
    setMeldung(null)
    const antwort = await fetch(`/api/aktion/${encodeURIComponent(schritt.aktionsName)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parameter: { ...schritt.vorbelegung, ...parameter },
        ...(recordId ? { record_id: recordId } : {}),
        ...(instanzId ? { instanz_id: instanzId, schritt: schritt.code } : {}),
      }),
    })
    const daten = (await antwort.json().catch(() => ({}))) as {
      error?: string
      info?: string
      link?: string
    }
    if (!antwort.ok || daten.error) {
      setFehler(daten.error ?? `Aktion fehlgeschlagen (${antwort.status})`)
      return
    }
    setOffen(null)
    if (daten.info) setMeldung(daten.info)
    // Im Assistenten bleiben (der nächste Schritt erscheint nach dem Refresh);
    // neu angelegte Belege sonst sofort öffnen.
    if (daten.link && recordId === undefined && instanzId === undefined) router.push(daten.link)
    else router.refresh()
  }

  function klick(schritt: SchrittAngebot) {
    if (!schritt.erlaubt) return
    const sichtbare = schritt.felder.filter((f) => !(f.name in schritt.vorbelegung))
    if (sichtbare.length === 0) {
      if (!window.confirm(`${schritt.name} — jetzt ausführen?`)) return
      startTransition(() => ausfuehren(schritt, {}))
      return
    }
    setFehler(null)
    setOffen(offen === schritt.code ? null : schritt.code)
  }

  function absenden(schritt: SchrittAngebot, e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const daten = new FormData(e.currentTarget)
    const parameter: Record<string, unknown> = {}
    try {
      for (const feld of schritt.felder) {
        if (feld.name in schritt.vorbelegung) continue
        const wert = eingabeWert(feld, daten.get(feld.name))
        if (wert !== undefined) parameter[feld.name] = wert
      }
    } catch {
      setFehler('Ungültige JSON-Eingabe.')
      return
    }
    startTransition(() => ausfuehren(schritt, parameter))
  }

  const geoeffnet = schritte.find((s) => s.code === offen)

  return (
    <div>
      <div className="actions" style={{ flexWrap: 'wrap', gap: 6 }}>
        {schritte.map((s) => (
          <button
            key={s.code}
            type="button"
            className={`small ${offen === s.code ? 'primary' : ''}`}
            disabled={!s.erlaubt || pending}
            title={s.hinweis ?? s.aktionsName}
            onClick={() => klick(s)}
          >
            {s.name}
            {!s.erlaubt && ' 🔒'}
          </button>
        ))}
      </div>

      {geoeffnet && (
        <form
          onSubmit={(e) => absenden(geoeffnet, e)}
          style={{ marginTop: 10, padding: 10, border: '1px solid var(--border)', borderRadius: 6 }}
        >
          <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {geoeffnet.felder
                .filter((f) => !(f.name in geoeffnet.vorbelegung))
                .map((f) => (
                  <Feld key={f.name} feld={f} optionen={geoeffnet.optionen[f.name]} />
                ))}
            </div>
            <div className="actions" style={{ marginTop: 8 }}>
              <button className="primary small" type="submit">{geoeffnet.name}</button>
              <button className="small" type="button" onClick={() => setOffen(null)}>Abbrechen</button>
            </div>
          </fieldset>
        </form>
      )}

      {fehler && (
        <div className="notice danger" role="alert" style={{ marginTop: 8, maxWidth: 460 }}>
          <span className="led warn" style={{ marginRight: 6 }} />
          <span className="mono-label" style={{ marginRight: 6, color: 'inherit' }}>Fehler</span>
          {fehler}
        </div>
      )}
      {meldung && (
        <div className="notice success" role="status" style={{ marginTop: 8, maxWidth: 460 }}>
          <span className="led ok" style={{ marginRight: 6 }} />
          {meldung}
        </div>
      )}
    </div>
  )
}
