import type { Diagramm } from '@/modules/prozesse/diagramm-layout'

/**
 * Prozessdiagramm als reines SVG — Server Component im Stil der
 * Auswertungs-Charts: Theme-Farben aus CSS-Variablen, keine Bibliothek.
 * Formsprache: Kreis = Start/Ende, Rechteck = Aktion, Raute = Entscheidung,
 * ⚙/⚡/≡ kennzeichnen Dienst/Ereignis/Matching. Der aktuelle Schritt trägt
 * den Akzentrahmen, Erledigtes ist gedimmt mit Häkchen, Abgeschaltetes
 * gestrichelt.
 */
export function ProzessDiagramm({ d }: { d: Diagramm }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg
        viewBox={`0 0 ${d.breite} ${d.hoehe}`}
        width={d.breite}
        height={d.hoehe}
        role="img"
        aria-label="Prozessdiagramm"
        style={{ maxWidth: '100%', height: 'auto', display: 'block' }}
      >
        {d.kanten.map((k, i) => (
          <g key={i}>
            <path
              d={k.pfad}
              fill="none"
              stroke="var(--border)"
              strokeWidth={1.5}
              markerEnd={`url(#pfeil)`}
            />
            {k.beschriftung && (
              <text
                x={k.textX}
                y={k.textY}
                fontSize={10}
                fill="var(--text-muted)"
                textAnchor="middle"
              >
                {k.beschriftung}
              </text>
            )}
          </g>
        ))}

        <defs>
          <marker id="pfeil" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M 0 0 L 7 3.5 L 0 7 z" fill="var(--border)" />
          </marker>
        </defs>

        {d.knoten.map((k) => {
          const rand = k.aktuell ? 'var(--accent)' : 'var(--border)'
          const deckkraft = k.erledigt ? 0.55 : 1
          const strich = k.abgeschaltet ? '4 3' : undefined
          const mitteX = k.x + k.breite / 2
          const mitteY = k.y + k.hoehe / 2

          return (
            <g key={k.code} opacity={deckkraft}>
              {k.art === 'start' || k.art === 'ende' ? (
                <circle
                  cx={mitteX}
                  cy={mitteY}
                  r={k.hoehe / 2 - 4}
                  fill="var(--surface-2)"
                  stroke={rand}
                  strokeWidth={k.art === 'ende' ? 3 : 1.5}
                  strokeDasharray={strich}
                />
              ) : k.art === 'xor' ? (
                <path
                  d={`M ${mitteX} ${k.y} L ${k.x + k.breite} ${mitteY} L ${mitteX} ${k.y + k.hoehe} L ${k.x} ${mitteY} z`}
                  fill="var(--surface-2)"
                  stroke={rand}
                  strokeWidth={k.aktuell ? 2 : 1.5}
                  strokeDasharray={strich}
                />
              ) : (
                <rect
                  x={k.x}
                  y={k.y}
                  width={k.breite}
                  height={k.hoehe}
                  rx={6}
                  fill="var(--surface-2)"
                  stroke={rand}
                  strokeWidth={k.aktuell ? 2 : 1.5}
                  strokeDasharray={strich}
                />
              )}

              {k.art !== 'xor' && (
                <text
                  x={mitteX}
                  y={mitteY + (k.art === 'start' || k.art === 'ende' ? 3 : -2)}
                  fontSize={11}
                  fontWeight={k.aktuell ? 650 : 450}
                  fill="var(--text)"
                  textAnchor="middle"
                >
                  {k.name.length > 26 ? `${k.name.slice(0, 25)}…` : k.name}
                </text>
              )}
              {/* Art-Kennzeichen unter dem Namen — Dienst/Ereignis/Matching
                  sind asynchrone bzw. wartende Schritte. */}
              {(k.art === 'dienst' || k.art === 'ereignis' || k.art === 'matching' || k.art === 'prozess' || k.optional) && (
                <text
                  x={mitteX}
                  y={mitteY + 12}
                  fontSize={9}
                  fill="var(--text-muted)"
                  textAnchor="middle"
                >
                  {[
                    k.art === 'dienst' && '⚙ asynchron',
                    k.art === 'ereignis' && '⚡ wartet auf Ereignis',
                    k.art === 'matching' && '≡ Klärliste',
                    k.art === 'prozess' && '▣ Teilprozess',
                    k.optional && 'optional',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </text>
              )}
              {k.erledigt && (
                <text x={k.x + 8} y={k.y + 14} fontSize={11} fill="var(--success)">
                  ✓
                </text>
              )}
              {k.aktuell && <circle cx={k.x + 8} cy={k.y + 10} r={4} fill="var(--accent)" />}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
