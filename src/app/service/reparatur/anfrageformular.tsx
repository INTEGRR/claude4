'use client'

import { useState } from 'react'
import {
  type AnfrageFeld,
  normalisiereAnfrage,
  pruefeAnfrage,
} from '@/modules/shared/reparaturanfrage'

/**
 * Das Anfrageformular. Es schreibt über /api/reparaturanfrage — den zweiten
 * Schreibweg ohne Sitzung (Begründung dort). Hier wird nur vorvalidiert,
 * damit niemand für einen Tippfehler auf den Server warten muss; die
 * verbindliche Prüfung macht der Endpunkt mit denselben Regeln.
 */

const LEER: Record<AnfrageFeld, string> = {
  kontakt_name: '',
  email: '',
  telefon: '',
  strasse: '',
  hausnummer: '',
  plz: '',
  ort: '',
  land: 'DE',
  fehlerbeschreibung: '',
  bestellnummer: '',
}

type Fehler = Partial<Record<AnfrageFeld, string>> & { gesamt?: string }

export function Anfrageformular() {
  const [werte, setWerte] = useState(LEER)
  const [fehler, setFehler] = useState<Fehler>({})
  const [status, setStatus] = useState<'offen' | 'sendet' | 'fertig'>('offen')
  const [nummer, setNummer] = useState('')
  const [honig, setHonig] = useState('')

  function aendern(feld: AnfrageFeld, wert: string) {
    setWerte((alt) => ({ ...alt, [feld]: wert }))
    setFehler((alt) => ({ ...alt, [feld]: undefined, gesamt: undefined }))
  }

  async function absenden(e: React.FormEvent) {
    e.preventDefault()
    // Dieselben Regeln wie im Endpunkt — eine Quelle, kein zweiter Dialekt.
    const neu = pruefeAnfrage(normalisiereAnfrage(werte))
    if (Object.keys(neu).length > 0) {
      setFehler(neu)
      return
    }

    setStatus('sendet')
    try {
      const res = await fetch('/api/reparaturanfrage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...werte, webseite: honig }),
      })
      const antwort = (await res.json().catch(() => ({}))) as { fehler?: unknown; nummer?: string }
      if (res.ok) {
        setNummer(antwort.nummer ?? '')
        setStatus('fertig')
        return
      }
      if (res.status === 429) {
        setFehler({ gesamt: 'Zu viele Anfragen in kurzer Zeit — bitte später erneut versuchen.' })
      } else if (res.status === 503) {
        setFehler({ gesamt: 'Reparaturanfragen sind gerade nicht möglich — bitte per E-Mail melden.' })
      } else if (antwort.fehler && typeof antwort.fehler === 'object') {
        setFehler(antwort.fehler as Fehler)
      } else {
        setFehler({ gesamt: 'Das hat nicht geklappt — bitte erneut versuchen.' })
      }
      setStatus('offen')
    } catch {
      // Kein stiller Erfolg: Wer hier nichts absetzen kann, muss das sehen,
      // sonst wartet er auf ein Label, das nie kommt.
      setFehler({ gesamt: 'Keine Verbindung zum Server — bitte erneut versuchen.' })
      setStatus('offen')
    }
  }

  if (status === 'fertig') {
    return (
      <div className="anzeige">
        <p className="mono" style={{ color: '#FF5A1F', margin: '0 0 10px' }}>{'// Anfrage eingegangen'}</p>
        <h3 style={{ fontSize: 23, margin: '0 0 8px', color: '#f4f3ef' }}>
          Danke{nummer ? ` — Ihre Anfrage hat die Nummer ${nummer}` : ''}.
        </h3>
        <p style={{ color: '#9a9c9f', margin: 0 }}>
          Sie erhalten gleich eine Bestätigung per E-Mail. Wir prüfen die Anfrage und melden uns
          mit dem Retourenlabel oder einer Rückfrage. Bitte schicken Sie das Gerät erst nach Erhalt
          des Labels.
        </p>
      </div>
    )
  }

  return (
    <form className="formular" onSubmit={(e) => void absenden(e)} noValidate>
      <div className="paar">
        <div className="feld">
          <label htmlFor="ra-name">Name *</label>
          <input
            id="ra-name"
            value={werte.kontakt_name}
            onChange={(e) => aendern('kontakt_name', e.target.value)}
            autoComplete="name"
          />
          {fehler.kontakt_name && <span className="fehler">{fehler.kontakt_name}</span>}
        </div>
        <div className="feld">
          <label htmlFor="ra-mail">E-Mail *</label>
          <input
            id="ra-mail"
            type="email"
            value={werte.email}
            onChange={(e) => aendern('email', e.target.value)}
            autoComplete="email"
          />
          {fehler.email && <span className="fehler">{fehler.email}</span>}
        </div>
      </div>

      <div className="paar">
        <div className="feld">
          <label htmlFor="ra-tel">Telefon</label>
          <input
            id="ra-tel"
            value={werte.telefon}
            onChange={(e) => aendern('telefon', e.target.value)}
            autoComplete="tel"
          />
        </div>
        <div className="feld">
          <label htmlFor="ra-bestellung">Bestellnummer (optional)</label>
          <input
            id="ra-bestellung"
            value={werte.bestellnummer}
            onChange={(e) => aendern('bestellnummer', e.target.value)}
            placeholder="z. B. #1042"
          />
        </div>
      </div>

      <div className="paar">
        <div className="feld">
          <label htmlFor="ra-strasse">Straße *</label>
          <input
            id="ra-strasse"
            value={werte.strasse}
            onChange={(e) => aendern('strasse', e.target.value)}
            autoComplete="address-line1"
          />
          {fehler.strasse && <span className="fehler">{fehler.strasse}</span>}
        </div>
        <div className="feld">
          <label htmlFor="ra-hausnummer">Hausnummer *</label>
          <input
            id="ra-hausnummer"
            value={werte.hausnummer}
            onChange={(e) => aendern('hausnummer', e.target.value)}
          />
          {fehler.hausnummer && <span className="fehler">{fehler.hausnummer}</span>}
        </div>
      </div>

      <div className="paar">
        <div className="feld">
          <label htmlFor="ra-plz">PLZ *</label>
          <input
            id="ra-plz"
            value={werte.plz}
            onChange={(e) => aendern('plz', e.target.value)}
            autoComplete="postal-code"
          />
          {fehler.plz && <span className="fehler">{fehler.plz}</span>}
        </div>
        <div className="feld">
          <label htmlFor="ra-ort">Ort *</label>
          <input
            id="ra-ort"
            value={werte.ort}
            onChange={(e) => aendern('ort', e.target.value)}
            autoComplete="address-level2"
          />
          {fehler.ort && <span className="fehler">{fehler.ort}</span>}
        </div>
      </div>

      <div className="feld">
        <label htmlFor="ra-land">Land *</label>
        <select id="ra-land" value={werte.land} onChange={(e) => aendern('land', e.target.value)}>
          <option value="DE">Deutschland</option>
          <option value="AT">Österreich</option>
          <option value="CH">Schweiz</option>
          <option value="NL">Niederlande</option>
          <option value="BE">Belgien</option>
          <option value="FR">Frankreich</option>
          <option value="DK">Dänemark</option>
          <option value="PL">Polen</option>
        </select>
        {fehler.land && <span className="fehler">{fehler.land}</span>}
      </div>

      <div className="feld">
        <label htmlFor="ra-fehler">Was funktioniert nicht? *</label>
        <textarea
          id="ra-fehler"
          value={werte.fehlerbeschreibung}
          onChange={(e) => aendern('fehlerbeschreibung', e.target.value)}
          placeholder="z. B. „Die Leertaste prellt — jeder zweite Anschlag kommt doppelt. Seit etwa zwei Wochen."
        />
        {fehler.fehlerbeschreibung && <span className="fehler">{fehler.fehlerbeschreibung}</span>}
      </div>

      {/* Honigtopf: für Menschen unsichtbar, Bots füllen ihn aus. */}
      <div aria-hidden style={{ position: 'absolute', left: '-9999px' }}>
        <label htmlFor="ra-webseite">Webseite</label>
        <input
          id="ra-webseite"
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
        {status === 'sendet' ? 'SENDE …' : 'Reparaturanfrage absenden'}
      </button>
      <p className="hinweis" style={{ marginTop: 12 }}>
        Ihre Daten werden nur zur Bearbeitung der Reparatur verwendet.
      </p>
    </form>
  )
}
