'use client'

import { useState } from 'react'
import {
  normalisiereRegistrierung,
  pruefeRegistrierung,
  type RegistrierungsFehler,
} from '@/modules/shared/registrierung'

/**
 * Das Anmeldeformular der Startseite. Es schreibt über /api/registrierung —
 * den einzigen Schreibweg ohne Sitzung (Begründung dort). Hier wird nur
 * vorvalidiert, damit niemand für einen Tippfehler auf die Antwort des
 * Servers warten muss; die verbindliche Prüfung macht der Endpunkt.
 */

const NUTZERKLASSEN = ['1–10', '11–50', '51–150', 'über 150']
const SYSTEME = ['Excel & Insellösungen', 'Bestehendes ERP', 'Branchenlösung', 'Noch nichts']

const LEER = {
  firma: '',
  ansprechpartner: '',
  email: '',
  telefon: '',
  nutzer: '',
  heutiges_system: '',
  ablauf: '',
}

type Felder = typeof LEER

export function Registrierung() {
  const [werte, setWerte] = useState<Felder>(LEER)
  const [fehler, setFehler] = useState<RegistrierungsFehler & { gesamt?: string }>({})
  const [status, setStatus] = useState<'offen' | 'sendet' | 'fertig'>('offen')
  const [honig, setHonig] = useState('')

  function aendern(feld: keyof Felder, wert: string) {
    setWerte((alt) => ({ ...alt, [feld]: wert }))
    setFehler((alt) => ({ ...alt, [feld]: undefined, gesamt: undefined }))
  }

  async function absenden(e: React.FormEvent) {
    e.preventDefault()
    // Dieselben Regeln wie im Endpunkt — eine Quelle, kein zweiter Dialekt.
    const neu = pruefeRegistrierung(normalisiereRegistrierung(werte))
    if (Object.keys(neu).length > 0) {
      setFehler(neu)
      return
    }

    setStatus('sendet')
    try {
      const res = await fetch('/api/registrierung', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...werte, webseite: honig }),
      })
      if (res.ok) {
        setStatus('fertig')
        return
      }
      const antwort = (await res.json().catch(() => ({}))) as { fehler?: unknown }
      if (res.status === 429) {
        setFehler({ gesamt: 'Zu viele Anfragen in kurzer Zeit — bitte später erneut versuchen.' })
      } else if (antwort.fehler && typeof antwort.fehler === 'object') {
        setFehler(antwort.fehler as RegistrierungsFehler)
      } else {
        setFehler({ gesamt: 'Das hat nicht geklappt — bitte erneut versuchen.' })
      }
      setStatus('offen')
    } catch {
      // Kein stiller Erfolg: Wer hier nichts absetzen kann, muss das sehen,
      // sonst wartet er auf einen Rückruf, den es nie gab.
      setFehler({ gesamt: 'Keine Verbindung zum Server — bitte erneut versuchen.' })
      setStatus('offen')
    }
  }

  if (status === 'fertig') {
    return (
      <div className="anzeige">
        <p className="mono" style={{ color: '#FF5A1F', margin: '0 0 10px' }}>{'// Registriert'}</p>
        <h3 style={{ fontSize: 23, margin: '0 0 8px', color: '#f4f3ef' }}>Danke. Wir melden uns.</h3>
        <p style={{ color: '#9a9c9f', margin: '0 0 18px' }}>
          Ihr hört innerhalb von zwei Werktagen von uns — mit einem Terminvorschlag
          für die Prozessaufnahme.
        </p>
        <button
          type="button"
          className="taste"
          onClick={() => {
            setWerte(LEER)
            setFehler({})
            setStatus('offen')
          }}
        >
          Weitere Registrierung
        </button>
      </div>
    )
  }

  return (
    <form className="formular" onSubmit={(e) => void absenden(e)} noValidate>
      <div className="paar">
        <div className="feld">
          <label htmlFor="reg-firma">Unternehmen *</label>
          <input
            id="reg-firma"
            value={werte.firma}
            onChange={(e) => aendern('firma', e.target.value)}
            autoComplete="organization"
          />
          {fehler.firma && <span className="fehler">{fehler.firma}</span>}
        </div>
        <div className="feld">
          <label htmlFor="reg-name">Ansprechpartner *</label>
          <input
            id="reg-name"
            value={werte.ansprechpartner}
            onChange={(e) => aendern('ansprechpartner', e.target.value)}
            autoComplete="name"
          />
          {fehler.ansprechpartner && <span className="fehler">{fehler.ansprechpartner}</span>}
        </div>
      </div>

      <div className="paar">
        <div className="feld">
          <label htmlFor="reg-mail">E-Mail *</label>
          <input
            id="reg-mail"
            type="email"
            value={werte.email}
            onChange={(e) => aendern('email', e.target.value)}
            autoComplete="email"
          />
          {fehler.email && <span className="fehler">{fehler.email}</span>}
        </div>
        <div className="feld">
          <label htmlFor="reg-tel">Telefon</label>
          <input
            id="reg-tel"
            value={werte.telefon}
            onChange={(e) => aendern('telefon', e.target.value)}
            autoComplete="tel"
          />
        </div>
      </div>

      <div className="paar">
        <div className="feld">
          <label htmlFor="reg-nutzer">Nutzer</label>
          <select
            id="reg-nutzer"
            value={werte.nutzer}
            onChange={(e) => aendern('nutzer', e.target.value)}
          >
            <option value="">— wählen —</option>
            {NUTZERKLASSEN.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
        <div className="feld">
          <label htmlFor="reg-system">Heutiges System</label>
          <select
            id="reg-system"
            value={werte.heutiges_system}
            onChange={(e) => aendern('heutiges_system', e.target.value)}
          >
            <option value="">— wählen —</option>
            {SYSTEME.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="feld">
        <label htmlFor="reg-ablauf">Welcher Ablauf klemmt? *</label>
        <textarea
          id="reg-ablauf"
          value={werte.ablauf}
          onChange={(e) => aendern('ablauf', e.target.value)}
          placeholder="z. B. „Der Auftragsdurchlauf vom Shop bis zum Versand — die Rückstände laufen in Excel."
        />
        {fehler.ablauf && <span className="fehler">{fehler.ablauf}</span>}
      </div>

      {/* Honigtopf: für Menschen unsichtbar, Bots füllen ihn aus. */}
      <div aria-hidden style={{ position: 'absolute', left: '-9999px' }}>
        <label htmlFor="reg-webseite">Webseite</label>
        <input
          id="reg-webseite"
          tabIndex={-1}
          autoComplete="off"
          value={honig}
          onChange={(e) => setHonig(e.target.value)}
        />
      </div>

      {fehler.gesamt && (
        <p className="fehler" role="alert" style={{ marginBottom: 12 }}>{fehler.gesamt}</p>
      )}

      <button type="submit" className="taste fuehrend" disabled={status === 'sendet'}>
        {status === 'sendet' ? 'SENDE …' : 'Registrierung absenden'}
      </button>
      <p className="hinweis" style={{ marginTop: 12 }}>
        Vertraulich. Keine Weitergabe, keine Newsletter-Anmeldung.
      </p>
    </form>
  )
}
