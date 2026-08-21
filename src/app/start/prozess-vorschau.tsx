'use client'

import { useState } from 'react'

/**
 * Das Kernversprechen der Seite als anfassbares Stück: dieselbe
 * Prozessversion einmal geschaltet (v1.4) und einmal als Entwurf mit einem
 * zusätzlichen Prüfschritt (v1.5). Ein Knopf schaltet um — genau das ist die
 * These „am selben Tag, ohne Release".
 *
 * Der Graph liegt auf Prozentkoordinaten über einer SVG-Kantenebene und
 * braucht rund 452 px Panelbreite, sonst laufen die 142 px breiten Knoten
 * ineinander. Darunter wird deshalb die DARSTELLUNG getauscht (senkrechte
 * Liste, gleiche Knoten und Farben) statt der Graph umgebrochen — die Regel
 * steckt in start.css, hier steht nur beides im Markup.
 */

type Art = 'start' | 'schritt' | 'tor' | 'ende' | 'abbruch' | 'neu'

interface Knoten {
  id: string
  tag: string
  name: string
  x: number
  y: number
  art: Art
}

interface Version {
  id: string
  status: string
  statusArt: 'aktiv' | 'entwurf'
  meta: string
  knopf: string
  knoten: Knoten[]
  kanten: [string, string, ('abbruch' | 'neu')?][]
}

const PALETTE: Record<Art, { bg: string; bd: string; tag: string }> = {
  start: { bg: '#1B1E22', bd: '#7d7f84', tag: '#9a9c9f' },
  schritt: { bg: '#16181B', bd: '#3a3c40', tag: '#7a7c80' },
  tor: { bg: '#141a24', bd: '#4a5a7a', tag: '#8fa2c4' },
  ende: { bg: '#1B1E22', bd: '#7d7f84', tag: '#9a9c9f' },
  abbruch: { bg: '#16181B', bd: '#33363b', tag: '#5a5c62' },
  neu: { bg: '#1a1430', bd: '#7C5AFF', tag: '#A98CFF' },
}

const V14: Version = {
  id: 'v1.4',
  status: 'Geschaltet',
  statusArt: 'aktiv',
  meta: 'Version 1.4 · aktiv · 6 Schritte',
  knopf: 'Schritt ergänzen',
  knoten: [
    { id: 'a', tag: 'AUSLÖSER', name: 'Bestellung erfasst', x: 20, y: 12, art: 'start' },
    { id: 'b', tag: 'SCHRITT', name: 'Verfügbarkeit prüfen', x: 55, y: 12, art: 'schritt' },
    { id: 'c', tag: 'ENTSCHEID', name: 'Vollständig?', x: 84, y: 34, art: 'tor' },
    { id: 'd', tag: 'SCHRITT', name: 'Kommissionieren', x: 55, y: 52, art: 'schritt' },
    { id: 'e', tag: 'SCHRITT', name: 'Packen', x: 22, y: 52, art: 'schritt' },
    { id: 'f', tag: 'ABSCHLUSS', name: 'Versand gemeldet', x: 22, y: 86, art: 'ende' },
    { id: 'x', tag: 'ABBRUCH', name: 'Rückstand melden', x: 80, y: 86, art: 'abbruch' },
  ],
  kanten: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f'], ['c', 'x', 'abbruch']],
}

const V15: Version = {
  id: 'v1.5',
  status: 'Entwurf',
  statusArt: 'entwurf',
  meta: 'Version 1.5 · Entwurf · 7 Schritte · +1 Prüfschritt',
  knopf: 'Version schalten',
  knoten: [
    { id: 'a', tag: 'AUSLÖSER', name: 'Bestellung erfasst', x: 20, y: 12, art: 'start' },
    { id: 'b', tag: 'SCHRITT', name: 'Verfügbarkeit prüfen', x: 55, y: 12, art: 'schritt' },
    { id: 'c', tag: 'ENTSCHEID', name: 'Vollständig?', x: 84, y: 34, art: 'tor' },
    { id: 'd', tag: 'SCHRITT', name: 'Kommissionieren', x: 55, y: 52, art: 'schritt' },
    { id: 'e', tag: 'SCHRITT', name: 'Packen', x: 22, y: 52, art: 'schritt' },
    { id: 'q', tag: 'NEU', name: 'Qualitätscheck', x: 52, y: 86, art: 'neu' },
    { id: 'f', tag: 'ABSCHLUSS', name: 'Versand gemeldet', x: 84, y: 68, art: 'ende' },
    { id: 'x', tag: 'ABBRUCH', name: 'Rückstand melden', x: 20, y: 86, art: 'abbruch' },
  ],
  kanten: [
    ['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'],
    ['e', 'q', 'neu'], ['q', 'f', 'neu'], ['c', 'x', 'abbruch'],
  ],
}

function KnotenKarte({ k }: { k: Knoten }) {
  const p = PALETTE[k.art]
  return (
    <div
      className={`knoten${k.art === 'neu' ? ' neu' : ''}`}
      style={{ left: `${k.x}%`, top: `${k.y}%`, background: p.bg, borderColor: p.bd }}
    >
      <span className="tag" style={{ color: p.tag }}>{k.tag}</span>
      <span className="name" style={{ color: k.art === 'abbruch' ? '#8a8c93' : '#ededea' }}>
        {k.name}
      </span>
    </div>
  )
}

export function ProzessVorschau({ start = 'v1.5' }: { start?: 'v1.4' | 'v1.5' }) {
  const [entwurf, setEntwurf] = useState(start === 'v1.5')
  const v = entwurf ? V15 : V14
  const mitte = new Map(v.knoten.map((k) => [k.id, k]))

  return (
    <div className="anzeige">
      <div className="anzeige-kopf">
        <span className="mono">Prozessversion · Auftragsdurchlauf</span>
        <span className="mono" style={{ color: v.statusArt === 'aktiv' ? '#FF5A1F' : '#7C5AFF' }}>
          Status: {v.status}
        </span>
      </div>

      <div className="graph">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          {v.kanten.map(([von, nach, art]) => {
            const a = mitte.get(von)
            const b = mitte.get(nach)
            if (!a || !b) return null
            const farbe = art === 'neu' ? '#7C5AFF' : art === 'abbruch' ? '#2f3238' : '#3a3c40'
            return (
              <line
                key={`${von}-${nach}`}
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={farbe}
                strokeWidth={1.4}
                strokeDasharray={art === 'abbruch' ? '3 3' : undefined}
                vectorEffect="non-scaling-stroke"
              />
            )
          })}
        </svg>
        {v.knoten.map((k) => (
          <KnotenKarte key={k.id} k={k} />
        ))}
      </div>

      {/* Schmale Panels: gleiche Knoten als senkrechte Wirbelsäule. */}
      <div className="liste">
        {v.knoten.map((k) => {
          const p = PALETTE[k.art]
          return (
            <div key={k.id} className="liste-zeile">
              <span className="mono" style={{ color: p.tag, display: 'block', marginBottom: 2 }}>
                {k.tag}
              </span>
              <span style={{ color: k.art === 'abbruch' ? '#8a8c93' : '#ededea', fontSize: 14 }}>
                {k.name}
              </span>
            </div>
          )
        })}
      </div>

      <div className="anzeige-fuss">
        <span className="mono">{v.meta}</span>
        <button
          type="button"
          className={`taste ${entwurf ? 'kern' : 'fuehrend'}`}
          onClick={() => setEntwurf((a) => !a)}
        >
          {v.knopf}
        </button>
      </div>
    </div>
  )
}
