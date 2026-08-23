'use client'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { FeldEingabe } from '@/components/feld-eingabe'
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
  /** Verlangte Befugnis (z. B. einkauf:freigabe) — der Schritt ist eine
      Entscheidung und trägt den violetten Akzent. */
  befugnis?: string
}

function eingabeWert(feld: FormularFeld, roh: FormDataEntryValue | null): unknown {
  if (feld.typ === 'schalter') return roh === 'on'
  if (roh === null || (typeof roh === 'string' && roh.trim() === '')) return undefined
  const text = String(roh).trim()
  if (feld.typ === 'nummer') return Number(text)
  if (feld.typ === 'json') return JSON.parse(text)
  return text
}

export function ProzessAktionen({
  schritte,
  recordId,
  instanzId,
  sofortOffen,
}: {
  schritte: SchrittAngebot[]
  /** Beleggebundener Prozess: die Beleg-ID des Aufrufs. */
  recordId?: string
  /** Belegloser Assistent: die Instanz, die nach Erfolg weitergeschaltet wird. */
  instanzId?: string
  /** Ad-hoc-Maske: dieses Formular steht sofort offen (Schritt-Code). */
  sofortOffen?: string
}) {
  const router = useRouter()
  const [offen, setOffen] = useState<string | null>(sofortOffen ?? null)
  const [fehler, setFehler] = useState<string | null>(null)
  const [meldung, setMeldung] = useState<{ text: string; link?: string } | null>(null)
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
    // Der Link zum Ergebnis (z. B. dem angelegten Auftrag) wandert in die
    // Erfolgsmeldung — auf Belegseiten wurde er früher stumm verworfen.
    if (daten.info) setMeldung({ text: daten.info, link: daten.link })
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
        const wert = eingabeWert(feld, daten.getAll(feld.name).at(-1) ?? null)
        if (wert === undefined) continue
        // Eigene Felder (zusatz.<name>) verschachtelt ablegen.
        if (feld.name.startsWith('zusatz.')) {
          const zusatz = (parameter.zusatz ??= {}) as Record<string, unknown>
          zusatz[feld.name.slice('zusatz.'.length)] = wert
        } else {
          parameter[feld.name] = wert
        }
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
            className={`small ${offen === s.code ? (s.befugnis ? 'wichtig' : 'primary') : ''}`}
            disabled={!s.erlaubt || pending}
            title={s.hinweis ?? s.aktionsName}
            onClick={() => klick(s)}
          >
            {s.befugnis && offen !== s.code && <span className="led wichtig" />}
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
                  <FeldEingabe key={f.name} feld={f} optionen={geoeffnet.optionen[f.name]} />
                ))}
            </div>
            <div className="actions" style={{ marginTop: 8 }}>
              <button className={`${geoeffnet.befugnis ? 'wichtig' : 'primary'} small`} type="submit">
                {geoeffnet.name}
              </button>
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
          {meldung.text}
          {meldung.link && (
            <>
              {' '}
              <a href={meldung.link}>Öffnen →</a>
            </>
          )}
        </div>
      )}
    </div>
  )
}
