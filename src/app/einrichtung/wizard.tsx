'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { FlowDiagramm } from '@/modules/prozesse/flow-layout'
import { ProzessFlow } from '@/components/prozess-flow'
import type { ActionResult } from '@/modules/shared/action'
import {
  adminPasswort,
  demodatenEinspielen,
  einrichtungAbschliessen,
  firmaSpeichern,
  nutzerAnlegen,
  paketAktivieren,
  prozessAbnehmen,
  versionSchalten,
} from './actions'

/**
 * Der Einrichtungs-Assistent nach dem Design-Handoff „KRNL Onboarding":
 * erst die Weiche (Beispieldaten ansehen ODER richtig loslegen), dann fünf
 * Schritte, die genau das einlösen, was die Startseite verspricht —
 * Aufnehmen, Zeichnen, Läuft.
 *
 *   01 Instanz    Firma + Geschäftsmodell (das Paket entscheidet, welche
 *                 Prozesse aktiv sind — ohne Wahl ist ALLES aktiv)
 *   02 Team       Personen und Rollen; Rollen entscheiden später, wer welchen
 *                 Prozessschritt sehen und buchen darf, auch per Sprache
 *   03 Aufnehmen  vier Fragen; die Antworten gehen als Transkript an dieselbe
 *                 Strukturierung wie das Sprach-Interview der Werkstatt
 *   04 Zeichnen   das ECHTE Diagramm des Entwurfs; Schritte lassen sich als
 *                 falsch markieren, die Freigabe ist die protokollierte Abnahme
 *   05 Läuft      Version schalten — ab da ist der Ablauf das System
 *
 * Die Schritte 04/05 hängen an einem Entwurf, den der Server kennt: nach der
 * Aufnahme lädt die Seite mit ?entwurf=<code> neu. Die bisherigen Antworten
 * überleben das in der sessionStorage — sie werden für Korrekturrunden
 * gebraucht, gehören aber weder in die Datenbank noch in die URL.
 */

export interface EntwurfInfo {
  code: string
  name: string
  version: number
  status: string
  abgenommen: boolean
  schritte: { code: string; name: string; art: string }[]
  diagramm: FlowDiagramm
}

export interface Instanz {
  host: string
  region: string
  migrationen: number
  module: number
}

interface Mitglied {
  id: string
  name: string
  email: string
  role: string
}

const SCHRITTE = [
  { n: 1, titel: 'Instanz', meta: 'Firma · Geschäftsmodell' },
  { n: 2, titel: 'Team', meta: 'Personen · Rollen' },
  { n: 3, titel: 'Aufnehmen', meta: 'Ablauf erzählen' },
  { n: 4, titel: 'Zeichnen', meta: 'Diagramm abnehmen' },
  { n: 5, titel: 'Läuft', meta: 'Version schalten' },
] as const

const FRAGEN = [
  {
    frage: 'Welcher Ablauf soll zuerst laufen — und was löst ihn aus?',
    hinweis: 'z. B. „Der Auftragsdurchlauf. Los geht es, wenn eine Bestellung im Shop eingeht."',
    beispiel: 'Der Auftragsdurchlauf. Auslöser ist eine Bestellung aus dem Shop oder per Mail.',
    erfasst: 'Auslöser',
  },
  {
    frage: 'Welche Schritte kommen danach, bis er abgeschlossen ist?',
    hinweis: 'Einfach der Reihe nach erzählen — die Reihenfolge sortieren wir.',
    beispiel: 'Verfügbarkeit prüfen, dann kommissionieren, packen, und am Ende Versand melden.',
    erfasst: 'Schritte',
  },
  {
    frage: 'Wer ist für welchen Schritt zuständig?',
    hinweis: 'Rollen genügen, keine Namen.',
    beispiel:
      'Prüfen macht der Einkauf, Kommissionieren und Packen das Lager, Versand meldet das Lager mit.',
    erfasst: 'Zuständigkeiten',
  },
  {
    frage: 'Was sind die häufigsten Ausnahmen oder Abbruchwege?',
    hinweis: 'Genau die Fälle, die sonst in Excel landen.',
    beispiel: 'Wenn etwas fehlt, gehen wir in Rückstand und melden dem Kunden eine Teillieferung.',
    erfasst: 'Ausnahmen',
  },
]

const ROLLEN = [
  { wert: 'mitarbeiter', label: 'Mitarbeiter' },
  { wert: 'lager', label: 'Lager' },
  { wert: 'fertigung', label: 'Fertigung' },
  { wert: 'admin', label: 'Geschäftsführung / Administrator' },
]

const SPEICHER = 'krnl-einrichtung-runden'

interface Runde {
  frage: string
  antwort: string
}

function rundenLesen(): Runde[] {
  try {
    const roh = sessionStorage.getItem(SPEICHER)
    return roh ? (JSON.parse(roh) as Runde[]) : []
  } catch {
    return []
  }
}

function rundenSchreiben(runden: Runde[]) {
  try {
    sessionStorage.setItem(SPEICHER, JSON.stringify(runden))
  } catch {
    // Privater Modus o. Ä. — dann geht nur die Korrekturrunde verloren.
  }
}

function Seg({ wert, farbe = 'signal' }: { wert: number | string; farbe?: 'signal' | 'kernel' }) {
  const text = String(wert)
  return (
    <span className={`seg ${farbe}`}>
      <span className="seg-geist" aria-hidden>{'8'.repeat(text.length)}</span>
      <span className="seg-wert">{text}</span>
    </span>
  )
}

export function Wizard({
  adminId,
  adminName,
  pakete,
  firma,
  instanz,
  team,
  entwurf,
  kiBereit,
}: {
  adminId: string
  adminName: string
  pakete: { code: string; name: string; beschreibung: string | null }[]
  firma: Record<string, string>
  instanz: Instanz
  team: Mitglied[]
  entwurf: EntwurfInfo | null
  kiBereit: boolean
}) {
  const router = useRouter()
  // Mit Entwurf steigen wir dort ein, wo er hingehört: geprüft wird das
  // Diagramm, abgenommene Entwürfe warten aufs Schalten.
  const [schritt, setSchritt] = useState<number | 'weiche'>(
    entwurf ? (entwurf.abgenommen ? 5 : 4) : 'weiche',
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [fehler, setFehler] = useState<string | null>(null)
  const [hinweis, setHinweis] = useState<string | null>(null)

  const [mitglieder, setMitglieder] = useState<Mitglied[]>(team)
  const [qIndex, setQIndex] = useState(0)
  const [antworten, setAntworten] = useState<string[]>([])
  const [eingabe, setEingabe] = useState('')
  const [markiert, setMarkiert] = useState<string[]>([])
  const [geschaltet, setGeschaltet] = useState(false)

  async function lauf(name: string, fn: () => Promise<ActionResult>): Promise<boolean> {
    setBusy(name)
    setFehler(null)
    try {
      const res = await fn()
      if (res && 'error' in res) {
        setFehler(res.error)
        return false
      }
      return true
    } catch (err) {
      setFehler(err instanceof Error ? err.message : 'Unerwarteter Fehler')
      return false
    } finally {
      setBusy(null)
    }
  }

  async function abschliessenUndRein() {
    if (!(await lauf('fertig', () => einrichtungAbschliessen('gefuehrt')))) return
    window.location.href = '/'
  }

  async function demoWeg() {
    if (!(await lauf('demo', demodatenEinspielen))) return
    if (!(await lauf('demo', () => einrichtungAbschliessen('demo')))) return
    window.location.href = '/'
  }

  // --- Schritt 03: Antworten strukturieren ---------------------------------

  async function aufnahmeAbschicken(alleRunden: Runde[]) {
    setBusy('aufnahme')
    setFehler(null)
    try {
      const res = await fetch('/api/aufnahme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runden: alleRunden,
          titel: `${firma.name || 'Erster Ablauf'} — Ablauf aus der Ersteinrichtung`,
        }),
      })
      const daten = (await res.json()) as { text?: string; code?: string; error?: string }
      if (!res.ok || daten.error) {
        setFehler(daten.error ?? 'Die Aufnahme ist fehlgeschlagen.')
        return
      }
      if (!daten.code) {
        setFehler(daten.text ?? 'Es ist kein Entwurf entstanden — bitte ausführlicher erzählen.')
        return
      }
      // Der Server kennt den Entwurf; die Seite lädt mit Diagramm neu.
      router.push(`/einrichtung?entwurf=${encodeURIComponent(daten.code)}`)
      router.refresh()
    } catch {
      setFehler('Keine Verbindung — bitte erneut versuchen.')
    } finally {
      setBusy(null)
    }
  }

  function antwortSenden() {
    const text = eingabe.trim()
    if (!text) return
    const neueAntworten = [...antworten, text]
    setAntworten(neueAntworten)
    setEingabe('')

    const istKorrektur = qIndex >= FRAGEN.length
    const frage = istKorrektur
      ? `Was stimmt an diesen Schritten nicht: ${markiert.join(', ')}?`
      : FRAGEN[qIndex].frage
    const runden = istKorrektur
      ? [...rundenLesen(), { frage, antwort: text }]
      : [...neueAntworten.map((a, i) => ({ frage: FRAGEN[i].frage, antwort: a }))]
    rundenSchreiben(runden)
    setQIndex(qIndex + 1)

    if (istKorrektur || neueAntworten.length === FRAGEN.length) {
      void aufnahmeAbschicken(runden)
    }
  }

  // --- Ansichtsteile --------------------------------------------------------

  const rail = (
    <nav className="rail" aria-label="Ablauf der Einrichtung">
      <p className="mono" style={{ margin: '0 0 12px', paddingLeft: 12 }}>Ablauf der Einrichtung</p>
      {SCHRITTE.map((s) => {
        const aktiv = s.n === schritt
        const erledigt = typeof schritt === 'number' && s.n < schritt
        const gesperrt = s.n >= 4 && !entwurf
        return (
          <button
            key={s.n}
            type="button"
            className={`rail-eintrag${aktiv ? ' aktiv' : ''}${erledigt ? ' erledigt' : ''}`}
            disabled={gesperrt}
            onClick={() => setSchritt(s.n)}
          >
            <span className="rail-nr">{erledigt ? '✓' : `0${s.n}`}</span>
            <span>
              <span className="rail-titel">{s.titel}</span>
              <span className="rail-meta">{s.meta}</span>
            </span>
          </button>
        )
      })}
      <p className="rail-fuss">
        Eigene Instanz · Betrieb in der EU. Nichts wird geschaltet, bevor ihr das
        Diagramm abgenommen habt.
      </p>
    </nav>
  )

  const provisionierung = (
    <div className="anzeige">
      <div className="anzeige-kopf">
        <span className="mono">Instanz</span>
        <span className="mono" style={{ color: '#7c5aff' }}>ring 0</span>
      </div>
      <div className="protokoll">
        <div><span className="ok">[ ok ]</span> Deployment erreichbar · {instanz.host}</div>
        <div><span className="ok">[ ok ]</span> Eigene Datenbank · {instanz.region}</div>
        <div><span className="ok">[ ok ]</span> Schema migriert · {instanz.migrationen} Schritte, {instanz.module} Module</div>
        <div><span className="ok">[ ok ]</span> Sicherung &amp; Rückholpunkt aktiv</div>
        <div><span className="wartet">[ .. ]</span> Daten-TÜV geplant · nachts</div>
      </div>
      <p className="mono" style={{ marginTop: 14, textTransform: 'none', letterSpacing: '0.04em' }}>
        Rückholpunkte und der nächtliche Daten-TÜV laufen ab Tag 1 — nicht optional.
      </p>
    </div>
  )

  return (
    <div className="krnl-einrichtung">
      <div className="kopfleiste">
        <span className="marke">
          <strong style={{ fontSize: 18, letterSpacing: '-0.05em' }}>KRNL</strong>
          <span className="mono">Einrichtung</span>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 14 }}>
          <span className="mono">{instanz.host}</span>
          {typeof schritt === 'number' && (
            <span className="schrittstand">
              <span className="mono">Schritt</span>
              <Seg wert={schritt} />
              <span className="mono">/ 5</span>
            </span>
          )}
        </span>
      </div>

      {schritt === 'weiche' ? (
        <div className="weiche">
          <p className="eyebrow">{'// Ersteinrichtung'}</p>
          <h1>Einmal einrichten — dann läuft euer Ablauf.</h1>
          <p className="lead">
            Zwei Wege: erst mit Beispieldaten umsehen, oder gleich mit euren
            eigenen Daten beginnen. Beispieldaten lassen sich später restlos
            entfernen.
          </p>
          {fehler && <div className="meldung fehler" role="alert">{fehler}</div>}
          <div className="zwei">
            <div className="karte">
              <h2>Erst einmal ansehen</h2>
              <p style={{ color: 'var(--text-2)', marginTop: 0 }}>
                Beispieldaten einspielen: eine Tastaturfertigung mit Varianten,
                Stückliste, Betriebshistorie und Finanzen — zum Ausprobieren und
                für den Rundgang.
              </p>
              <button type="button" className="taste" disabled={busy !== null} onClick={() => void demoWeg()}>
                {busy === 'demo' ? 'Spielt Beispieldaten ein … (dauert etwas)' : 'Demo-Modus starten'}
              </button>
            </div>
            <div className="karte">
              <h2>Richtig loslegen</h2>
              <p style={{ color: 'var(--text-2)', marginTop: 0 }}>
                Fünf Schritte mit euren echten Daten: Firma, Team, euer Ablauf im
                Gespräch, Diagramm abnehmen, Version schalten.
              </p>
              <button type="button" className="taste fuehrend" onClick={() => setSchritt(1)}>
                Einrichtung starten →
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="schale">
          {rail}
          <div className="buehne">
            {fehler && <div className="meldung fehler" role="alert">{fehler}</div>}
            {hinweis && <div className="meldung">{hinweis}</div>}

            {schritt === 1 && (
              <>
                <p className="eyebrow">{'// Schritt 01 · Instanz'}</p>
                <h1>Eure Instanz steht.</h1>
                <p className="lead">
                  Eigenes Deployment, eigene Datenbank — kein gemeinsamer
                  Mandantentopf. Bleiben zwei Angaben: wer ihr seid, und was ihr
                  macht.
                </p>
                <div className="zwei">
                  <div>
                    <form
                      className="karte"
                      onSubmit={(e) => {
                        e.preventDefault()
                        const fd = new FormData(e.currentTarget)
                        void lauf('firma', () => firmaSpeichern(fd)).then((ok) => {
                          if (ok) setHinweis('Firmendaten gespeichert.')
                        })
                      }}
                    >
                      <h2>Firma</h2>
                      <div className="feld">
                        <label htmlFor="f-name">Name</label>
                        <input
                          id="f-name"
                          name="name"
                          required
                          defaultValue={firma.name === 'Meine Firma GmbH' ? '' : (firma.name ?? '')}
                          placeholder="Nordwerk GmbH"
                        />
                      </div>
                      <div className="feldreihe">
                        <div className="feld" style={{ flex: 3 }}>
                          <label htmlFor="f-street">Straße</label>
                          <input id="f-street" name="street" defaultValue={firma.street ?? ''} />
                        </div>
                        <div className="feld" style={{ flex: 1 }}>
                          <label htmlFor="f-house">Nr.</label>
                          <input id="f-house" name="house" defaultValue={firma.house ?? ''} />
                        </div>
                      </div>
                      <div className="feldreihe">
                        <div className="feld" style={{ flex: 1 }}>
                          <label htmlFor="f-zip">PLZ</label>
                          <input id="f-zip" name="zip" defaultValue={firma.zip ?? ''} />
                        </div>
                        <div className="feld" style={{ flex: 2 }}>
                          <label htmlFor="f-city">Ort</label>
                          <input id="f-city" name="city" defaultValue={firma.city ?? ''} />
                        </div>
                        <div className="feld" style={{ flex: 1 }}>
                          <label htmlFor="f-country">Land (ISO-3)</label>
                          <input id="f-country" name="country" defaultValue={firma.country ?? 'DEU'} />
                        </div>
                      </div>
                      <div className="feldreihe">
                        <div className="feld">
                          <label htmlFor="f-mail">E-Mail</label>
                          <input id="f-mail" name="email" type="email" defaultValue={firma.email ?? ''} />
                        </div>
                        <div className="feld">
                          <label htmlFor="f-phone">Telefon</label>
                          <input id="f-phone" name="phone" defaultValue={firma.phone ?? ''} />
                        </div>
                      </div>
                      <button type="submit" className="taste" disabled={busy !== null}>
                        {busy === 'firma' ? 'Speichert …' : 'Firmendaten speichern'}
                      </button>
                    </form>

                    <div className="karte">
                      <h2>Geschäftsmodell</h2>
                      <p style={{ color: 'var(--text-2)', marginTop: 0 }}>
                        Das Paket bestimmt, welche Prozesse aktiv sind — Navigation
                        und Assistenten richten sich danach. Ohne Wahl bleibt alles
                        aktiv; zuschalten geht später jederzeit unter Prozesse.
                      </p>
                      {pakete.map((p) => (
                        <div key={p.code} style={{ marginBottom: 12 }}>
                          <strong>{p.name}</strong>
                          <p className="feldhinweis" style={{ margin: '2px 0 6px' }}>{p.beschreibung}</p>
                          <button
                            type="button"
                            className="taste kern"
                            disabled={busy !== null}
                            onClick={() =>
                              void lauf('paket', () => paketAktivieren(p.code)).then((ok) => {
                                if (ok) setHinweis(`Paket „${p.name}" aktiv — die Navigation zeigt jetzt genau diese Prozesse.`)
                              })
                            }
                          >
                            {busy === 'paket' ? 'Aktiviert …' : 'Dieses Paket'}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                  {provisionierung}
                </div>
              </>
            )}

            {schritt === 2 && (
              <>
                <p className="eyebrow">{'// Schritt 02 · Team'}</p>
                <h1>Wer arbeitet im System?</h1>
                <p className="lead">
                  Rollen entscheiden später, welche Prozessschritte jemand sehen und
                  buchen darf — auch per Sprache. Ergänzen geht jederzeit.
                </p>
                <div className="karte">
                  <table>
                    <thead>
                      <tr>
                        <th>Person</th>
                        <th>Rolle</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mitglieder.map((m) => (
                        <tr key={m.id}>
                          <td>
                            {m.name}
                            <span className="zeile2">{m.email}</span>
                          </td>
                          <td className={m.role === 'admin' ? 'rolle-fuehrung' : ''}>
                            {ROLLEN.find((r) => r.wert === m.role)?.label ?? m.role}
                            {m.id === adminId && <span className="zeile2">euer Zugang</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <form
                    style={{ marginTop: 16 }}
                    onSubmit={(e) => {
                      e.preventDefault()
                      const form = e.currentTarget
                      const fd = new FormData(form)
                      void lauf('nutzer', () => nutzerAnlegen(fd)).then((ok) => {
                        if (!ok) return
                        setMitglieder((alt) => [
                          ...alt,
                          {
                            id: `neu-${alt.length}`,
                            name: String(fd.get('name') ?? ''),
                            email: String(fd.get('email') ?? ''),
                            role: String(fd.get('role') ?? 'mitarbeiter'),
                          },
                        ])
                        form.reset()
                      })
                    }}
                  >
                    <div className="feldreihe">
                      <div className="feld"><label htmlFor="t-name">Name</label>
                        <input id="t-name" name="name" required /></div>
                      <div className="feld"><label htmlFor="t-mail">E-Mail</label>
                        <input id="t-mail" name="email" type="email" required /></div>
                    </div>
                    <div className="feldreihe">
                      <div className="feld"><label htmlFor="t-rolle">Rolle</label>
                        <select id="t-rolle" name="role" defaultValue="mitarbeiter">
                          {ROLLEN.map((r) => (
                            <option key={r.wert} value={r.wert}>{r.label}</option>
                          ))}
                        </select></div>
                      <div className="feld"><label htmlFor="t-pw">Startpasswort (min. 8)</label>
                        <input id="t-pw" name="password" type="password" required minLength={8} /></div>
                    </div>
                    <button type="submit" className="taste fuehrend" disabled={busy !== null}>
                      {busy === 'nutzer' ? 'Legt an …' : 'Hinzufügen'}
                    </button>
                  </form>
                </div>

                <form
                  className="karte"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const fd = new FormData(e.currentTarget)
                    void lauf('passwort', () => adminPasswort(adminId, fd)).then((ok) => {
                      if (ok) setHinweis('Passwort geändert.')
                    })
                  }}
                >
                  <h2>Euer eigenes Passwort</h2>
                  <p style={{ color: 'var(--text-2)', marginTop: 0 }}>
                    Das Startpasswort aus der Provisionierung sollte jetzt ersetzt
                    werden — es stand im Klartext im Terminal. Konto: {adminName}.
                  </p>
                  <div className="feld">
                    <label htmlFor="pw-neu">Neues Passwort (min. 8 Zeichen)</label>
                    <input id="pw-neu" name="password" type="password" required minLength={8} />
                  </div>
                  <button type="submit" className="taste" disabled={busy !== null}>
                    {busy === 'passwort' ? 'Speichert …' : 'Passwort setzen'}
                  </button>
                </form>
              </>
            )}

            {schritt === 3 && (
              <>
                <p className="eyebrow">{'// Schritt 03 · Aufnehmen'}</p>
                <h1>Erzählt euren Ablauf.</h1>
                <p className="lead">
                  Kein Lastenheft, kein Formular-Marathon. Vier Fragen — Auslöser,
                  Schritte, Zuständigkeiten, Ausnahmen — daraus entsteht die erste
                  Prozessversion.
                </p>
                {!kiBereit && (
                  <div className="meldung">
                    Die Aufnahme braucht den KI-Zugang (ANTHROPIC_API_KEY). Ohne ihn
                    lässt sich der Ablauf später in der Prozess-Werkstatt aufnehmen —
                    die Einrichtung könnt ihr hier trotzdem abschließen.
                  </div>
                )}
                <div className="zwei">
                  <div className="anzeige">
                    <div className="anzeige-kopf">
                      <span className="mono">Prozessaufnahme · Diktat</span>
                      <span className="mono">
                        {Math.min(qIndex + 1, FRAGEN.length)} / {FRAGEN.length}
                      </span>
                    </div>
                    {antworten.map((a, i) => (
                      <div key={`runde-${i}-${a.slice(0, 12)}`}>
                        <div className="blase krnl">
                          <span className="wer">KRNL</span>
                          {FRAGEN[i]?.frage ?? 'Was stimmt an den markierten Schritten nicht?'}
                        </div>
                        <div className="blase nutzer">
                          <span className="wer">Ihr</span>
                          {a}
                        </div>
                      </div>
                    ))}
                    {qIndex < FRAGEN.length ? (
                      <>
                        <div className="blase krnl">
                          <span className="wer">KRNL</span>
                          {FRAGEN[qIndex].frage}
                        </div>
                        <div className="feld" style={{ marginTop: 14, marginBottom: 0 }}>
                          <textarea
                            aria-label="Antwort"
                            value={eingabe}
                            placeholder={FRAGEN[qIndex].hinweis}
                            onChange={(e) => setEingabe(e.target.value)}
                          />
                        </div>
                        <div className="tastenreihe">
                          <button
                            type="button"
                            className="taste fuehrend"
                            disabled={busy !== null || !eingabe.trim()}
                            onClick={antwortSenden}
                          >
                            {busy === 'aufnahme' ? 'Strukturiert …' : 'Antwort senden'}
                          </button>
                          <button
                            type="button"
                            className="taste"
                            onClick={() => setEingabe(FRAGEN[qIndex].beispiel)}
                          >
                            Beispiel einsetzen
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="blase krnl">
                        <span className="wer">KRNL</span>
                        {busy === 'aufnahme'
                          ? 'Danke — ich baue daraus die erste Prozessversion …'
                          : 'Aufnahme vollständig. Das Diagramm steht im nächsten Schritt.'}
                      </div>
                    )}
                  </div>

                  <div className="karte">
                    <h2>Was der Assistent erfasst</h2>
                    <ul className="erfassung">
                      {FRAGEN.map((f, i) => {
                        const zustand = i < antworten.length ? 'erfasst' : i === qIndex ? 'jetzt' : 'offen'
                        return (
                          <li key={f.erfasst}>
                            <span className={`punkt ${zustand}`} />
                            <span className="titel">{f.erfasst}</span>
                            <span className="mono">{zustand}</span>
                          </li>
                        )
                      })}
                    </ul>
                    <p className="feldhinweis" style={{ marginTop: 14 }}>
                      Nichts davon wird programmiert. Alles davon wird eine
                      Prozessversion — als Entwurf, der erst nach eurer Abnahme
                      geschaltet wird.
                    </p>
                  </div>
                </div>
              </>
            )}

            {schritt === 4 && entwurf && (
              <>
                <p className="eyebrow">{'// Schritt 04 · Zeichnen'}</p>
                <h1>Stimmt das so?</h1>
                <p className="lead">
                  Das ist euer Ablauf, wie wir ihn verstanden haben. Markiert die
                  Schritte, die nicht stimmen. Eure Freigabe hier ist die Abnahme —
                  kein Lastenheft.
                </p>
                <div className="diagramm" style={{ height: 420 }}>
                  <ProzessFlow d={entwurf.diagramm} />
                </div>
                <div className="karte" style={{ marginTop: 18 }}>
                  <h2>
                    {markiert.length === 0
                      ? 'Keine Einwände'
                      : `${markiert.length} Korrektur${markiert.length === 1 ? '' : 'en'} markiert`}
                  </h2>
                  <ul className="erfassung">
                    {entwurf.schritte.map((s) => (
                      <li key={s.code}>
                        <span className={`punkt ${markiert.includes(s.name) ? 'jetzt' : ''}`} />
                        <span className="titel">
                          {s.name}
                          <span className="zeile2">{s.art}</span>
                        </span>
                        <button
                          type="button"
                          className="taste"
                          onClick={() =>
                            setMarkiert((alt) =>
                              alt.includes(s.name)
                                ? alt.filter((n) => n !== s.name)
                                : [...alt, s.name],
                            )
                          }
                        >
                          {markiert.includes(s.name) ? 'Markierung lösen' : 'Stimmt nicht'}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div className="tastenreihe">
                    {markiert.length === 0 ? (
                      <button
                        type="button"
                        className="taste fuehrend"
                        disabled={busy !== null}
                        onClick={() =>
                          void lauf('abnahme', () =>
                            prozessAbnehmen(entwurf.code, entwurf.version),
                          ).then((ok) => {
                            if (ok) {
                              setHinweis('Abnahme protokolliert.')
                              setSchritt(5)
                            }
                          })
                        }
                      >
                        {busy === 'abnahme' ? 'Protokolliert …' : 'Abnahme erteilen'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="taste kern"
                        disabled={busy !== null || !kiBereit}
                        onClick={() => {
                          setAntworten([])
                          setQIndex(FRAGEN.length)
                          setEingabe('')
                          setSchritt(3)
                        }}
                      >
                        Korrekturen aufnehmen
                      </button>
                    )}
                    {markiert.length > 0 && (
                      <button type="button" className="taste" onClick={() => setMarkiert([])}>
                        Markierungen zurücksetzen
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}

            {schritt === 5 &&
              (!entwurf ? (
                  <>
                    <p className="eyebrow">{'// Schritt 05 · Läuft'}</p>
                    <h1>Noch kein Ablauf aufgenommen.</h1>
                    <p className="lead">
                      Ihr könnt die Einrichtung jetzt abschließen und den ersten
                      Ablauf später in der Prozess-Werkstatt aufnehmen — im Gespräch
                      oder als Sprach-Interview.
                    </p>
                    <button
                      type="button"
                      className="taste fuehrend"
                      disabled={busy !== null}
                      onClick={() => void abschliessenUndRein()}
                    >
                      {busy === 'fertig' ? 'Schließt ab …' : 'Einrichtung abschließen'}
                    </button>
                  </>
                ) : geschaltet ? (
                  <>
                    <p className="eyebrow">{'// v1 geschaltet'}</p>
                    <h1>Läuft.</h1>
                    <p className="lead">
                      „{entwurf.name}" ist ab jetzt das System: Masken, Knöpfe und
                      Navigation entstehen aus den Schritten. Ändert sich der Ablauf,
                      entwerft ihr eine neue Version — am selben Tag, ohne Release.
                    </p>
                    <div className="anzeige">
                      <div className="anzeige-kopf">
                        <span className="mono">{instanz.host}</span>
                        <span className="mono">{instanz.region} · eigene Instanz</span>
                      </div>
                      <div className="protokoll">
                        <div><span className="ok">[ ok ]</span> Abnahme protokolliert</div>
                        <div><span className="ok">[ ok ]</span> Version {entwurf.version} aktiv</div>
                        <div><span className="ok">[ ok ]</span> Berechtigungen aus Rollen abgeleitet</div>
                      </div>
                    </div>
                    <div className="tastenreihe">
                      <button
                        type="button"
                        className="taste fuehrend"
                        disabled={busy !== null}
                        onClick={() => void abschliessenUndRein()}
                      >
                        {busy === 'fertig' ? 'Schließt ab …' : 'Zum System →'}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="eyebrow">{'// Schritt 05 · Läuft'}</p>
                    <h1>Version schalten.</h1>
                    <p className="lead">
                      Der abgenommene Ablauf wird ab jetzt das System: Masken, Knöpfe
                      und Navigation entstehen aus den Schritten. Keine
                      Entwicklungsrunde dazwischen.
                    </p>
                    <div className="anzeige">
                      <div className="anzeige-kopf">
                        <span className="mono">{entwurf.name}</span>
                        <span className="mono">Version {entwurf.version} · {entwurf.status}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', marginBottom: 16 }}>
                        <span>
                          <span className="mono" style={{ display: 'block', marginBottom: 6 }}>Schritte</span>
                          <span style={{ fontSize: 26 }}><Seg wert={entwurf.schritte.length} /></span>
                        </span>
                        <span>
                          <span className="mono" style={{ display: 'block', marginBottom: 6 }}>Rollen</span>
                          <span style={{ fontSize: 26 }}>
                            <Seg wert={new Set(mitglieder.map((m) => m.role)).size} farbe="kernel" />
                          </span>
                        </span>
                        <span>
                          <span className="mono" style={{ display: 'block', marginBottom: 6 }}>Masken</span>
                          <span style={{ fontSize: 26 }}>
                            <Seg wert={entwurf.schritte.filter((s) => s.art === 'aktion').length} />
                          </span>
                        </span>
                      </div>
                      <div className="protokoll">
                        <div>
                          <span className={entwurf.abgenommen ? 'ok' : 'wartet'}>
                            [ {entwurf.abgenommen ? 'ok' : '..'} ]
                          </span>{' '}
                          Abnahme protokolliert · {instanz.host}
                        </div>
                        <div><span className="ok">[ ok ]</span> Berechtigungen aus Rollen abgeleitet</div>
                        <div><span className="wartet">[ .. ]</span> Version {entwurf.version} bereit zum Schalten</div>
                      </div>
                    </div>
                    <div className="tastenreihe">
                      <button
                        type="button"
                        className="taste fuehrend"
                        disabled={busy !== null}
                        onClick={() =>
                          void lauf('schalten', () =>
                            versionSchalten(entwurf.code, entwurf.version),
                          ).then((ok) => {
                            if (ok) setGeschaltet(true)
                          })
                        }
                      >
                        {busy === 'schalten' ? 'Schaltet …' : 'Version schalten'}
                      </button>
                      <button
                        type="button"
                        className="taste"
                        disabled={busy !== null}
                        onClick={() => void abschliessenUndRein()}
                      >
                        Später schalten, jetzt abschließen
                      </button>
                    </div>
                  </>
                ))}

            {!geschaltet && (
              <div className="fussnav">
                <button
                  type="button"
                  className="taste"
                  disabled={schritt === 1}
                  onClick={() => setSchritt(Math.max(1, (schritt as number) - 1))}
                >
                  ← Zurück
                </button>
                <span className="mono" style={{ textTransform: 'none', letterSpacing: '0.04em' }}>
                  {schritt === 3
                    ? 'Nichts wird geschaltet, bevor ihr das Diagramm abgenommen habt.'
                    : schritt === 4
                      ? 'Markiert, was nicht stimmt — sonst gebt ihr frei.'
                      : 'Alles hier lässt sich später ändern.'}
                </span>
                <button
                  type="button"
                  className="taste fuehrend"
                  disabled={(schritt as number) >= 5 || ((schritt as number) >= 3 && !entwurf)}
                  onClick={() => setSchritt(Math.min(5, (schritt as number) + 1))}
                >
                  Weiter →
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
