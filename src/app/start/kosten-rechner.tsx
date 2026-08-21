'use client'

import { useState } from 'react'
import { Seg } from './anzeige'

/**
 * Kostenvergleich Jahr 1: klassisches ERP-Projekt gegen KRNL. Die Aussage
 * ist nicht „billiger", sondern „der Customizing-Block entfällt" — deshalb
 * ist im klassischen Balken genau dieses Segment orange und alles andere
 * grau, und beide Balken stehen auf DERSELBEN Skala.
 *
 * ACHTUNG — ANNAHMEN SIND PLATZHALTER: Die Multiplikatoren unten stammen aus
 * dem Design-Handoff und sind branchenübliche Hausnummern, KEINE geprüften
 * Zahlen von ANVIL. Vor dem Livegang durch echte Werte ersetzen (docs/
 * website.md führt die Liste offener Platzhalter). Deshalb steht die
 * Disclaimer-Zeile unter den Reglern nicht zur Disposition.
 */

const ANNAHMEN = {
  lizenzJeNutzer: 1200, // Lizenz Jahr 1 je Nutzer
  beratungstageJeProzess: 4,
  schulungAnteil: 0.18, // Schulung & Projektleitung auf Beratung + Customizing
  aufnahmetageJeProzess: 0.5, // KRNL: Prozessaufnahme statt Workshop
  betriebJeNutzer: 480, // Instanz & Betrieb Jahr 1 je Nutzer
  monateGrundlast: 4, // klassisch: Monate bis Produktivbetrieb
  monateJeProzess: 0.5,
  wochenGrundlast: 2, // KRNL: Wochen bis Produktivbetrieb
  wochenJeProzess: 0.25,
}

const REGLER = [
  { key: 'nutzer', label: 'Nutzer', min: 5, max: 250, step: 5 },
  { key: 'prozesse', label: 'Prozesse', min: 3, max: 40, step: 1 },
  { key: 'satz', label: 'Tagessatz €', min: 800, max: 2200, step: 50 },
  { key: 'customizing', label: 'Customizing-Tage', min: 0, max: 200, step: 5 },
] as const

type Schluessel = (typeof REGLER)[number]['key']

const K = (wert: number) => Math.round(wert / 1000)
const de = (wert: number) => wert.toLocaleString('de-DE')

export function KostenRechner() {
  const [w, setW] = useState<Record<Schluessel, number>>({
    nutzer: 40,
    prozesse: 12,
    satz: 1400,
    customizing: 60,
  })

  const lizenz = w.nutzer * ANNAHMEN.lizenzJeNutzer
  const beratung = w.prozesse * ANNAHMEN.beratungstageJeProzess * w.satz
  const customizing = w.customizing * w.satz
  const schulung = Math.round((beratung + customizing) * ANNAHMEN.schulungAnteil)
  const klassisch = lizenz + beratung + customizing + schulung

  const aufnahme = Math.round(w.prozesse * ANNAHMEN.aufnahmetageJeProzess * w.satz)
  const betrieb = w.nutzer * ANNAHMEN.betriebJeNutzer
  const krnl = aufnahme + betrieb

  const differenz = klassisch - krnl
  const monate = Math.round(ANNAHMEN.monateGrundlast + w.prozesse * ANNAHMEN.monateJeProzess)
  const wochen = Math.round(ANNAHMEN.wochenGrundlast + w.prozesse * ANNAHMEN.wochenJeProzess)

  const anteil = (teil: number) => `${(teil / klassisch) * 100}%`

  return (
    <>
      <div className="regler">
        <p className="mono" style={{ margin: '0 0 16px' }}>Annahmen anpassen</p>
        {REGLER.map((r) => (
          <div key={r.key} className="feldzeile">
            <label htmlFor={`regler-${r.key}`}>
              <span className="mono" style={{ letterSpacing: '0.12em' }}>{r.label}</span>
              <span className="wert">{de(w[r.key])}</span>
            </label>
            <input
              id={`regler-${r.key}`}
              type="range"
              min={r.min}
              max={r.max}
              step={r.step}
              value={w[r.key]}
              onChange={(e) => setW((alt) => ({ ...alt, [r.key]: Number(e.target.value) }))}
            />
          </div>
        ))}
        <p className="hinweis">
          Modellrechnung für Jahr 1. Kein Angebot — die belastbare Zahl entsteht im Erstgespräch.
        </p>
      </div>

      <div className="anzeige">
        <div className="balkenblock">
          <div className="balkenkopf">
            <span className="mono">Klassisches ERP-Projekt</span>
            <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, fontSize: 30 }}>
              <Seg wert={K(klassisch)} farbe="neutral" stellen={3} />
              <span className="mono" style={{ fontSize: 11 }}>K €</span>
            </span>
          </div>
          <div className="balken">
            <span style={{ width: anteil(lizenz), background: '#4a4c50' }} />
            <span style={{ width: anteil(beratung), background: '#6a6c70' }} />
            <span style={{ width: anteil(customizing), background: 'var(--accent)' }} />
            <span style={{ width: anteil(schulung), background: '#33363b' }} />
          </div>
          <div className="legende">
            <span><i style={{ background: '#4a4c50' }} />Lizenz {K(lizenz)}K</span>
            <span><i style={{ background: '#6a6c70' }} />Beratung {K(beratung)}K</span>
            <span><i style={{ background: 'var(--accent)' }} />Customizing {K(customizing)}K</span>
            <span><i style={{ background: '#33363b' }} />Schulung &amp; PL {K(schulung)}K</span>
          </div>
        </div>

        <div className="balkenblock">
          <div className="balkenkopf">
            <span className="mono">KRNL</span>
            <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, fontSize: 30 }}>
              <Seg wert={K(krnl)} farbe="signal" stellen={3} />
              <span className="mono" style={{ fontSize: 11 }}>K €</span>
            </span>
          </div>
          {/* Gleiche Skala wie oben — genau das macht den Unterschied lesbar. */}
          <div className="balken">
            <span style={{ width: anteil(aufnahme), background: 'var(--kernel)' }} />
            <span style={{ width: anteil(betrieb), background: 'var(--accent)' }} />
          </div>
          <div className="legende">
            <span><i style={{ background: 'var(--kernel)' }} />Prozessaufnahme {K(aufnahme)}K</span>
            <span><i style={{ background: 'var(--accent)' }} />Instanz &amp; Betrieb {K(betrieb)}K</span>
            <span style={{ color: '#6a6c70' }}>kein Customizing-Block</span>
          </div>
        </div>

        <div className="delta">
          <div>
            <span className="mono" style={{ display: 'block', marginBottom: 6 }}>Differenz</span>
            <Seg wert={K(differenz)} farbe="signal" stellen={3} />
            <span className="mono" style={{ display: 'block', marginTop: 6 }}>K €</span>
          </div>
          <div>
            <span className="mono" style={{ display: 'block', marginBottom: 6 }}>Klassisch</span>
            <Seg wert={monate} farbe="neutral" stellen={2} />
            <span className="mono" style={{ display: 'block', marginTop: 6 }}>Monate</span>
          </div>
          <div>
            <span className="mono" style={{ display: 'block', marginBottom: 6 }}>KRNL</span>
            <Seg wert={wochen} farbe="kernel" stellen={2} />
            <span className="mono" style={{ display: 'block', marginTop: 6 }}>Wochen</span>
          </div>
        </div>
      </div>
    </>
  )
}
