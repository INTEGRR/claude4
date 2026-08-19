'use client'

import { useState } from 'react'
import type { ActionResult } from '@/modules/shared/action'
import {
  adminPasswort,
  demodatenEinspielen,
  einrichtungAbschliessen,
  firmaSpeichern,
  nutzerAnlegen,
  paketAktivieren,
} from './actions'

/**
 * Der Einrichtungs-Assistent: erst die Weiche (Demo-Modus oder geführt),
 * dann Firma → Geschäftsmodell-Paket → Nutzer → Admin-Passwort → fertig.
 * Jeder Schritt ruft nur vorhandene Registry-Aktionen; die Paketwahl ist
 * der wichtigste Schritt — ohne sie sind ALLE Prozesse aktiv und die
 * Navigation zeigt das Maximum (Chamäleon).
 */

type Schritt = 'weiche' | 'firma' | 'paket' | 'nutzer' | 'passwort' | 'fertig'

const SCHRITTE: { id: Schritt; label: string }[] = [
  { id: 'firma', label: 'Firma' },
  { id: 'paket', label: 'Geschäftsmodell' },
  { id: 'nutzer', label: 'Team' },
  { id: 'passwort', label: 'Passwort' },
  { id: 'fertig', label: 'Fertig' },
]

function fehlerText(res: ActionResult): string | null {
  return res && 'error' in res ? res.error : null
}

export function Wizard({
  adminId,
  pakete,
  firma,
}: {
  adminId: string
  pakete: { code: string; name: string; beschreibung: string | null }[]
  firma: Record<string, string>
}) {
  const [schritt, setSchritt] = useState<Schritt>('weiche')
  const [busy, setBusy] = useState<string | null>(null)
  const [fehler, setFehler] = useState<string | null>(null)
  const [hinweis, setHinweis] = useState<string | null>(null)
  const [nutzer, setNutzer] = useState<string[]>([])

  async function lauf(name: string, fn: () => Promise<ActionResult>): Promise<boolean> {
    setBusy(name)
    setFehler(null)
    try {
      const res = await fn()
      const f = fehlerText(res)
      if (f) {
        setFehler(f)
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

  async function demoWeg() {
    // Beispieldaten + abschließen — danach direkt ins volle System.
    if (!(await lauf('demo', demodatenEinspielen))) return
    if (!(await lauf('demo', () => einrichtungAbschliessen('demo')))) return
    window.location.href = '/'
  }

  async function abschliessen() {
    if (!(await lauf('fertig', () => einrichtungAbschliessen('gefuehrt')))) return
    setSchritt('fertig')
  }

  const leiste =
    schritt !== 'weiche' ? (
      <div className="actions" style={{ justifyContent: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        {SCHRITTE.map((s, i) => (
          <span
            key={s.id}
            className={`badge ${s.id === schritt ? 'success' : 'neutral'}`}
            style={{ opacity: SCHRITTE.findIndex((x) => x.id === schritt) >= i ? 1 : 0.5 }}
          >
            {i + 1} · {s.label}
          </span>
        ))}
      </div>
    ) : null

  return (
    <div>
      {leiste}
      {fehler && (
        <div className="notice danger" role="alert">
          <span className="led warn" style={{ marginRight: 6 }} />
          {fehler}
        </div>
      )}
      {hinweis && <div className="notice success">{hinweis}</div>}

      {schritt === 'weiche' && (
        <div className="row" style={{ gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>
          <div className="card" style={{ flex: '1 1 280px' }}>
            <header><span>Erst einmal ansehen</span></header>
            <div className="body">
              <p className="muted">
                Beispieldaten einspielen: eine Tastaturfertigung mit Varianten,
                Stückliste, Betriebshistorie und Finanzen — zum Ausprobieren und
                für den Rundgang. Später per „Gefahrenzone" restlos entfernbar.
              </p>
              <button disabled={busy !== null} onClick={() => void demoWeg()}>
                {busy === 'demo' ? 'Spielt Beispieldaten ein … (dauert etwas)' : 'Demo-Modus starten'}
              </button>
            </div>
          </div>
          <div className="card" style={{ flex: '1 1 280px' }}>
            <header><span>Richtig loslegen</span></header>
            <div className="body">
              <p className="muted">
                Geführte Einrichtung mit echten Daten: Firma, Geschäftsmodell,
                Team, Passwort — danach Prozesse in der Werkstatt aufnehmen.
              </p>
              {/* Violett: die Entscheidung, mit echten Daten zu starten. */}
              <button className="wichtig" disabled={busy !== null} onClick={() => setSchritt('firma')}>
                Geführtes Onboarding
              </button>
            </div>
          </div>
        </div>
      )}

      {schritt === 'firma' && (
        <div className="card">
          <header><span>Ihre Firma</span></header>
          <form
            className="body"
            onSubmit={(e) => {
              e.preventDefault()
              const fd = new FormData(e.currentTarget)
              void lauf('firma', () => firmaSpeichern(fd)).then((ok) => {
                if (ok) setSchritt('paket')
              })
            }}
          >
            <div className="field"><label>Name</label>
              <input name="name" required defaultValue={firma.name === 'Meine Firma GmbH' ? '' : firma.name} placeholder="ANVIL GmbH" /></div>
            <div className="row" style={{ gap: 8 }}>
              <div className="field" style={{ flex: 3 }}><label>Straße</label>
                <input name="street" defaultValue={firma.street ?? ''} /></div>
              <div className="field" style={{ flex: 1 }}><label>Nr.</label>
                <input name="house" defaultValue={firma.house ?? ''} /></div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <div className="field" style={{ flex: 1 }}><label>PLZ</label>
                <input name="zip" defaultValue={firma.zip ?? ''} /></div>
              <div className="field" style={{ flex: 2 }}><label>Ort</label>
                <input name="city" defaultValue={firma.city ?? ''} /></div>
              <div className="field" style={{ flex: 1 }}><label>Land (ISO-3)</label>
                <input name="country" defaultValue={firma.country ?? 'DEU'} /></div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <div className="field" style={{ flex: 1 }}><label>E-Mail</label>
                <input name="email" type="email" defaultValue={firma.email ?? ''} /></div>
              <div className="field" style={{ flex: 1 }}><label>Telefon</label>
                <input name="phone" defaultValue={firma.phone ?? ''} /></div>
            </div>
            <div className="actions">
              <button className="primary" type="submit" disabled={busy !== null}>
                {busy === 'firma' ? 'Speichert …' : 'Weiter'}
              </button>
            </div>
          </form>
        </div>
      )}

      {schritt === 'paket' && (
        <div className="card">
          <header><span>Geschäftsmodell wählen</span></header>
          <div className="body">
            <p className="muted">
              Das Paket bestimmt, welche Prozesse aktiv sind — Navigation und
              Assistenten passen sich an. Ohne Wahl bleibt ALLES aktiv (volle
              Navigation); zuschalten geht später jederzeit unter Prozesse.
            </p>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'stretch' }}>
              {pakete.map((p) => (
                <div key={p.code} className="card" style={{ flex: '1 1 200px' }}>
                  <div className="body">
                    <strong>{p.name}</strong>
                    <p className="muted small">{p.beschreibung}</p>
                    <button
                      className="wichtig small"
                      disabled={busy !== null}
                      onClick={() =>
                        void lauf('paket', () => paketAktivieren(p.code)).then((ok) => {
                          if (ok) {
                            setHinweis(`Paket „${p.name}" aktiv — die Navigation zeigt jetzt genau diese Prozesse.`)
                            setSchritt('nutzer')
                          }
                        })
                      }
                    >
                      {busy === 'paket' ? 'Aktiviert …' : 'Dieses Paket'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="actions" style={{ marginTop: 10 }}>
              <button disabled={busy !== null} onClick={() => setSchritt('nutzer')}>
                Überspringen (alles aktiv lassen)
              </button>
            </div>
          </div>
        </div>
      )}

      {schritt === 'nutzer' && (
        <div className="card">
          <header><span>Team anlegen (optional)</span></header>
          <form
            className="body"
            onSubmit={(e) => {
              e.preventDefault()
              const form = e.currentTarget
              const fd = new FormData(form)
              const email = String(fd.get('email') ?? '')
              void lauf('nutzer', () => nutzerAnlegen(fd)).then((ok) => {
                if (ok) {
                  setNutzer((alt) => [...alt, email])
                  form.reset()
                }
              })
            }}
          >
            {nutzer.length > 0 && (
              <p className="muted small">Angelegt: {nutzer.join(', ')}</p>
            )}
            <div className="row" style={{ gap: 8 }}>
              <div className="field" style={{ flex: 2 }}><label>E-Mail</label>
                <input name="email" type="email" required /></div>
              <div className="field" style={{ flex: 2 }}><label>Name</label>
                <input name="name" required /></div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <div className="field" style={{ flex: 1 }}><label>Rolle</label>
                <select name="role" defaultValue="mitarbeiter">
                  <option value="mitarbeiter">Mitarbeiter</option>
                  <option value="lager">Lager</option>
                  <option value="fertigung">Fertigung</option>
                  <option value="admin">Administrator</option>
                </select></div>
              <div className="field" style={{ flex: 1 }}><label>Passwort (min. 8)</label>
                <input name="password" type="password" required minLength={8} /></div>
            </div>
            <div className="actions">
              <button type="submit" disabled={busy !== null}>
                {busy === 'nutzer' ? 'Legt an …' : 'Nutzer anlegen'}
              </button>
              <button
                className="primary"
                type="button"
                disabled={busy !== null}
                onClick={() => setSchritt('passwort')}
              >
                Weiter
              </button>
            </div>
          </form>
        </div>
      )}

      {schritt === 'passwort' && (
        <div className="card">
          <header><span>Admin-Passwort ändern</span></header>
          <form
            className="body"
            onSubmit={(e) => {
              e.preventDefault()
              const fd = new FormData(e.currentTarget)
              void lauf('passwort', () => adminPasswort(adminId, fd)).then((ok) => {
                if (ok) void abschliessen()
              })
            }}
          >
            <p className="muted">
              Das Startpasswort aus der Provisionierung sollte jetzt ersetzt
              werden — es stand im Klartext im Terminal.
            </p>
            <div className="field"><label>Neues Passwort (min. 8 Zeichen)</label>
              <input name="password" type="password" required minLength={8} /></div>
            <div className="actions">
              <button className="primary" type="submit" disabled={busy !== null}>
                {busy === 'passwort' || busy === 'fertig' ? 'Speichert …' : 'Passwort setzen & abschließen'}
              </button>
              <button type="button" disabled={busy !== null} onClick={() => void abschliessen()}>
                Später ändern
              </button>
            </div>
          </form>
        </div>
      )}

      {schritt === 'fertig' && (
        <div className="card">
          <header><span>Fertig eingerichtet</span></header>
          <div className="body">
            <p>
              KRNL ist startklar. Der nächste sinnvolle Schritt: die eigenen
              Abläufe aufnehmen — im Gespräch mit dem Agenten oder als
              Sprach-Interview.
            </p>
            <div className="actions">
              <a className="btn wichtig" href="/prozesse/werkstatt">Zur Prozess-Werkstatt</a>
              <a className="btn" href="/">Zur Übersicht</a>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
