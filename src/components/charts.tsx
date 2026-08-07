import { qty } from '@/modules/shared/format'
import { Empty } from '@/components/ui'

/**
 * Kleine SVG-/HTML-Diagramme (Server Components, keine Bibliothek).
 * Regeln aus dem dataviz-Leitfaden: schmale Balken (≤ 24 px) mit 4-px-Rundung
 * am Datenende, Hairline-Gitter, Legende ab zwei Serien, Werte nur selektiv,
 * Serienfarben aus der validierten Palette (--viz-1 … --viz-6), Text trägt
 * nie die Serienfarbe. Unter jedem Diagramm bleibt die Tabelle als
 * vollständige Datensicht bestehen.
 *
 * Alle Zahlen und Kategorien im Diagramm sind Beschriftung und laufen deshalb
 * in Mono — dieselbe Schrift wie Legende, Balkenwerte und Tabellenköpfe.
 */

// --viz-1 ist praktisch der Akzent. Er gehört der führenden Serie, nie dem
// Zufall der Sortierung.
const SERIES_COLORS = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)', 'var(--viz-5)', 'var(--viz-6)']

/** Beschriftungsschrift im SVG. */
const TICK = { className: 'mono', fontSize: '10', fill: 'var(--text-muted)', letterSpacing: '.05em' } as const

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
 * Zeichen- und Legendenreihenfolge nach Serienname (alphabetisch), damit die
 * Balken bei geändertem Zeitraum nicht die Plätze tauschen. Die Farbe folgt
 * dagegen dem Datenrang: die größte Serie bekommt --viz-1 (den Akzent), sonst
 * würde Orange nur den Anfangsbuchstaben belohnen.
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
  const summe = (s: ColumnSeries) => s.values.reduce((a, b) => a + b, 0)
  // Die sechs größten Serien — nicht die sechs alphabetisch ersten.
  const ranked = [...series]
    .sort((a, b) => summe(b) - summe(a) || a.name.localeCompare(b.name, 'de'))
    .slice(0, 6)
  const farbrang = new Map(ranked.map((s, i) => [s.name, i]))
  const farbe = (s: ColumnSeries) => SERIES_COLORS[farbrang.get(s.name) ?? 0]
  const sorted = [...ranked].sort((a, b) => a.name.localeCompare(b.name, 'de'))
  const verworfen = series.length - ranked.length
  const max = Math.max(0, ...sorted.flatMap((s) => s.values))
  if (max === 0) return <Empty>Keine Daten im Zeitraum.</Empty>
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
          {sorted.map((s) => (
            <span key={s.name}>
              <span className="swatch" style={{ background: farbe(s) }} />
              {s.name}
            </span>
          ))}
          {/* Datenehrlichkeit: gekappte Serien werden benannt, nicht verschwiegen. */}
          {verworfen > 0 && <span>+{verworfen} weitere nicht gezeigt</span>}
        </div>
      )}
      <svg
        viewBox={`0 0 ${W} ${height}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        role="img"
        aria-label={
          n > 1
            ? `Säulendiagramm über ${categories.length} Kategorien, Serien: ${sorted.map((s) => s.name).join(', ')}`
            : `Säulendiagramm über ${categories.length} Kategorien`
        }
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth="1" />
            <text x={padL - 6} y={y(t) + 3.5} textAnchor="end" {...TICK}>
              {qty(t)}
            </text>
          </g>
        ))}
        {categories.map((cat, ci) => (
          <g key={cat}>
            <text x={padL + band * ci + band / 2} y={height - 6} textAnchor="middle" {...TICK} letterSpacing=".06em">
              {cat}
            </text>
            {sorted.map((s, si) => {
              const v = s.values[ci] ?? 0
              if (v <= 0) return null
              const x = padL + band * ci + (band - groupW) / 2 + si * (barW + 2)
              const h = ((v / top) * plotH)
              return (
                <g key={s.name}>
                  <path d={barPath(x, y(v), barW, h)} fill={farbe(s)}>
                    <title>{`${n > 1 ? s.name + ' · ' : ''}${cat}: ${fmt(v, unit)}`}</title>
                  </path>
                  {single && labelIdx.has(ci) && (
                    <text
                      x={x + barW / 2}
                      y={y(v) - 4}
                      textAnchor="middle"
                      className="mono"
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
  if (max === 0) return <Empty>Keine Daten vorhanden.</Empty>
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

/**
 * Ein horizontaler Anteilsbalken (Teil-vom-Ganzen) mit Legende.
 *
 * Vertrag an den Aufrufer: `parts` kommt absteigend sortiert, der führende
 * Anteil steht vorn — er bekommt --viz-1, den Akzent. Bewusst KEINE Sortierung
 * in der Komponente: ein Sammelposten wie "Übrige" gehört ans Ende, auch wenn
 * er in Summe größer ist als der größte Einzelposten. Sonst glühte der Rest.
 */
export function ShareBar({
  parts,
  format = (v: number) => qty(v),
}: {
  parts: { label: string; value: number }[]
  format?: (v: number) => string
}) {
  const total = parts.reduce((sum, p) => sum + p.value, 0)
  if (total <= 0) return <Empty>Keine Daten vorhanden.</Empty>
  const shown = parts.slice(0, 6)
  const verworfen = parts.length - shown.length
  const gezeigt = shown.reduce((sum, p) => sum + p.value, 0)
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
        {/* Der Balken endet vor 100 % — die Lücke wird benannt. */}
        {verworfen > 0 && (
          <span>
            +{verworfen} weitere · {(((total - gezeigt) / total) * 100).toFixed(0)} %
          </span>
        )}
      </div>
    </div>
  )
}
