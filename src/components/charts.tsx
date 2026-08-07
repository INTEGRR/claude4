import { qty } from '@/modules/shared/format'

/**
 * Kleine SVG-/HTML-Diagramme (Server Components, keine Bibliothek).
 * Regeln aus dem dataviz-Leitfaden: schmale Balken (≤ 24 px) mit 4-px-Rundung
 * am Datenende, Hairline-Gitter, Legende ab zwei Serien, Werte nur selektiv,
 * Serienfarben aus der validierten Palette (--viz-1 … --viz-6), Text trägt
 * nie die Serienfarbe. Unter jedem Diagramm bleibt die Tabelle als
 * vollständige Datensicht bestehen.
 */

const SERIES_COLORS = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)', 'var(--viz-5)', 'var(--viz-6)']

function fmt(value: number, unit?: string): string {
  const text = qty(value)
  return unit ? `${text} ${unit}` : text
}

/** Runde Achsenwerte: 3–4 Ticks bei "schönen" Zahlen. */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1]
  const raw = max / 3
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? raw
  const ticks: number[] = []
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Number(v.toFixed(6)))
  if (ticks.at(-1)! < max) ticks.push(ticks.at(-1)! + step)
  return ticks
}

/** Balken mit 4 px gerundetem Datenende, eckig an der Basislinie. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h)
  return `M ${x} ${y + h} v ${-(h - r)} a ${r} ${r} 0 0 1 ${r} ${-r} h ${w - 2 * r} a ${r} ${r} 0 0 1 ${r} ${r} v ${h - r} z`
}

export interface ColumnSeries {
  name: string
  values: number[]
}

/**
 * Säulendiagramm über Kategorien (z. B. Monate); eine oder mehrere Serien.
 * Serienfarben in fester Reihenfolge nach Serienname (alphabetisch), damit
 * ein geänderter Zeitraum die Farben nicht umverteilt.
 */
export function ColumnChart({
  categories,
  series,
  unit,
  height = 190,
}: {
  categories: string[]
  series: ColumnSeries[]
  unit?: string
  height?: number
}) {
  const sorted = [...series].sort((a, b) => a.name.localeCompare(b.name, 'de')).slice(0, 6)
  const max = Math.max(0, ...sorted.flatMap((s) => s.values))
  if (max === 0) return null
  const ticks = niceTicks(max)
  const top = ticks.at(-1)!

  const W = 720
  const padL = 46
  const padR = 8
  const padT = 14
  const padB = 20
  const plotW = W - padL - padR
  const plotH = height - padT - padB
  const band = plotW / categories.length
  const n = sorted.length
  const barW = Math.min(24, (band * 0.72 - 2 * (n - 1)) / n)
  const groupW = barW * n + 2 * (n - 1)
  const y = (v: number) => padT + plotH - (v / top) * plotH

  const single = n === 1
  // Selektive Beschriftung: bei einer Serie Maximum und letzten Wert.
  const labelIdx = new Set<number>()
  if (single) {
    labelIdx.add(sorted[0].values.indexOf(Math.max(...sorted[0].values)))
    labelIdx.add(sorted[0].values.length - 1)
  }

  return (
    <div>
      {n > 1 && (
        <div className="chart-legend">
          {sorted.map((s, i) => (
            <span key={s.name}>
              <span className="swatch" style={{ background: SERIES_COLORS[i] }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth="1" />
            <text x={padL - 6} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill="var(--text-muted)">
              {qty(t)}
            </text>
          </g>
        ))}
        {categories.map((cat, ci) => (
          <g key={cat}>
            <text
              x={padL + band * ci + band / 2}
              y={height - 6}
              textAnchor="middle"
              fontSize="10"
              fill="var(--text-muted)"
            >
              {cat}
            </text>
            {sorted.map((s, si) => {
              const v = s.values[ci] ?? 0
              if (v <= 0) return null
              const x = padL + band * ci + (band - groupW) / 2 + si * (barW + 2)
              const h = ((v / top) * plotH)
              return (
                <g key={s.name}>
                  <path d={barPath(x, y(v), barW, h)} fill={SERIES_COLORS[si]}>
                    <title>{`${n > 1 ? s.name + ' · ' : ''}${cat}: ${fmt(v, unit)}`}</title>
                  </path>
                  {single && labelIdx.has(ci) && (
                    <text
                      x={x + barW / 2}
                      y={y(v) - 4}
                      textAnchor="middle"
                      fontSize="10.5"
                      fontWeight="600"
                      fill="var(--text)"
                    >
                      {qty(v)}
                    </text>
                  )}
                </g>
              )
            })}
          </g>
        ))}
      </svg>
    </div>
  )
}

/** Horizontale Größenvergleichs-Balken (eine Farbe, Wert an der Spitze). */
export function HBars({
  rows,
  unit,
  max: maxProp,
}: {
  rows: { label: string; value: number }[]
  unit?: string
  max?: number
}) {
  const max = maxProp ?? Math.max(0, ...rows.map((r) => r.value))
  if (max === 0) return null
  return (
    <div>
      {rows.map((r) => (
        <div className="hbar-row" key={r.label} title={`${r.label}: ${fmt(r.value, unit)}`}>
          <span className="label">{r.label}</span>
          <span className="track">
            <span className="fill" style={{ width: `${Math.max(1, (r.value / max) * 100)}%` }} />
          </span>
          <span className="num">{fmt(r.value, unit)}</span>
        </div>
      ))}
    </div>
  )
}

/** Ein horizontaler Anteilsbalken (Teil-vom-Ganzen) mit Legende. */
export function ShareBar({
  parts,
  format = (v: number) => qty(v),
}: {
  parts: { label: string; value: number }[]
  format?: (v: number) => string
}) {
  const total = parts.reduce((sum, p) => sum + p.value, 0)
  if (total <= 0) return null
  const shown = parts.slice(0, 6)
  return (
    <div>
      <div className="share-bar">
        {shown.map((p, i) => (
          <span
            key={p.label}
            style={{ width: `${(p.value / total) * 100}%`, background: SERIES_COLORS[i] }}
            title={`${p.label}: ${format(p.value)} (${((p.value / total) * 100).toFixed(0)} %)`}
          />
        ))}
      </div>
      <div className="chart-legend">
        {shown.map((p, i) => (
          <span key={p.label}>
            <span className="swatch" style={{ background: SERIES_COLORS[i] }} />
            {p.label} · {((p.value / total) * 100).toFixed(0)} %
          </span>
        ))}
      </div>
    </div>
  )
}
