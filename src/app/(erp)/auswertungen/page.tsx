import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { Card, Empty, PageHeader, Stat, TableWrap } from '@/components/ui'
import { type ColumnSeries, ColumnChart, HBars, ShareBar } from '@/components/charts'
import { money, qty } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

/**
 * Feste Auswertungen: Inventarwert, Produktion je Endvariante, verbaute
 * Komponenten (z. B. "wie oft wurde weißes Gehäuse verbaut") und
 * Abverkaufsquote. Reine SQL-Aggregationen über das Bewegungs-Ledger —
 * keine Chart-Bibliothek, Balken sind schmale CSS-Divs.
 */

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function monthsBetween(von: string, bis: string): string[] {
  const months: string[] = []
  const cursor = new Date(von + 'T00:00:00Z')
  cursor.setUTCDate(1)
  const end = new Date(bis + 'T00:00:00Z')
  while (cursor <= end && months.length < 24) {
    months.push(monthKey(cursor))
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return months
}

/**
 * Größenanzeige in einer Tabellenzelle — Geometrie wie `.hbar-row` (Spur in
 * `--surface-2`, 3 px Radius), Füllung aber bewusst neutral: der Akzent bleibt
 * den Diagrammen und kritischen Zuständen vorbehalten, nicht 40 Tabellenzeilen.
 */
function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 90,
        height: 10,
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 3,
        verticalAlign: 'middle',
      }}
    >
      {/* Führende Serienfarbe wie bei allen Größenbalken der Anwendung —
          grau auf grau wäre auf Papier kaum ablesbar. */}
      <span
        style={{
          display: 'block',
          width: `${pct}%`,
          height: '100%',
          background: 'var(--viz-1)',
          borderRadius: 2,
        }}
      />
    </span>
  )
}

/** Einheitlicher Rahmen für die Diagramme in `tight`-Karten. */
function ChartBox({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '12px 12px 0' }}>{children}</div>
}

/** Summen- und Quotenzellen tragen überall dasselbe Gewicht. */
const summe = { fontWeight: 650 } as const

interface MonthRow {
  variant_id: string
  product: string
  sku: string | null
  monat: string
  menge: number
}

/** Zeilen (variant × Monat) zu einer Tabelle Variante → Monatsspalten drehen. */
function pivot(rows: MonthRow[], months: string[]) {
  const byVariant = new Map<
    string,
    { product: string; sku: string | null; total: number; perMonth: Map<string, number> }
  >()
  for (const r of rows) {
    let entry = byVariant.get(r.variant_id)
    if (!entry) {
      entry = { product: r.product, sku: r.sku, total: 0, perMonth: new Map() }
      byVariant.set(r.variant_id, entry)
    }
    const key = r.monat.slice(0, 7)
    entry.perMonth.set(key, (entry.perMonth.get(key) ?? 0) + Number(r.menge))
    entry.total += Number(r.menge)
  }
  return [...byVariant.entries()]
    .map(([id, e]) => ({ id, ...e }))
    .sort((a, b) => b.total - a.total)
}

/**
 * Pivot-Zeilen in Diagrammserien drehen: die stärksten Varianten einzeln,
 * der Rest gebündelt als „Übrige" — mehr als vier Serien trägt kein Diagramm.
 */
function toSeries(rows: ReturnType<typeof pivot>, months: string[], cap = 3): ColumnSeries[] {
  const head = rows.slice(0, cap)
  const tail = rows.slice(cap)
  const series: ColumnSeries[] = head.map((r) => ({
    name: r.product,
    values: months.map((m) => r.perMonth.get(m) ?? 0),
  }))
  if (tail.length > 0) {
    series.push({
      name: `Übrige (${tail.length})`,
      values: months.map((m) => tail.reduce((sum, r) => sum + (r.perMonth.get(m) ?? 0), 0)),
    })
  }
  return series
}

function PivotTable({ rows, months, unit }: { rows: ReturnType<typeof pivot>; months: string[]; unit?: string }) {
  if (rows.length === 0) return <Empty>Keine Buchungen im Zeitraum.</Empty>
  const max = Math.max(...rows.map((r) => r.total))
  return (
    <TableWrap>
      <table>
        <thead>
          <tr>
            <th>Produkt</th>
            <th className="num">Gesamt</th>
            <th />
            {months.map((m) => (
              <th key={m} className="num small">{m}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                {r.product}
                {r.sku && <span className="muted small mono"> · {r.sku}</span>}
              </td>
              <td className="num" style={summe}>
                {qty(r.total)}
                {unit ? ` ${unit}` : ''}
              </td>
              <td><Bar value={r.total} max={max} /></td>
              {months.map((m) => (
                <td key={m} className="num muted mono">
                  {r.perMonth.has(m) ? qty(r.perMonth.get(m)!) : '·'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  )
}

export default async function AuswertungenPage({
  searchParams,
}: {
  searchParams: Promise<{ von?: string; bis?: string }>
}) {
  await requireArea('auswertungen')
  const params = await searchParams

  // Default: die letzten 6 Monate (der Kern der Abverkaufs-Frage).
  const heute = new Date()
  const defaultVon = new Date(heute)
  defaultVon.setUTCMonth(defaultVon.getUTCMonth() - 6)
  const von = params.von ?? defaultVon.toISOString().slice(0, 10)
  const bis = params.bis ?? heute.toISOString().slice(0, 10)
  const months = monthsBetween(von, bis)

  // --- Inventarwert aus der Bewertung (gleitender Durchschnitt, Migration 0018).
  // Bis dahin war das eine Schätzung aus gepflegten Einstandspreisen; jetzt
  // steht dort der Wert, mit dem der Bestand tatsächlich im Buch steht.
  const inventar = await sql<
    { id: string; product: string; sku: string | null; on_hand: number; unit_cost: number; value: number }[]
  >`
    select variant_id as id, product, sku, on_hand,
           moving_avg_cost as unit_cost, valuation_total as value
    from stock_value
    where on_hand <> 0 or valuation_total <> 0
    order by value desc`

  const inventarSumme = inventar.reduce((sum, r) => sum + Number(r.value), 0)

  // --- Produktion je Endvariante (Fertigmeldungen im Zeitraum)
  const produktion = await sql<MonthRow[]>`
    select m.variant_id, coalesce(pv.display_name, pt.name) as product, pv.sku,
           to_char(date_trunc('month', m.date_done), 'YYYY-MM') as monat,
           sum(m.qty_done) as menge
    from stock_moves m
    join product_variants pv on pv.id = m.variant_id
    join product_templates pt on pt.id = pv.template_id
    where m.production_id is not null and m.reference = 'Fertigmeldung'
      and m.state = 'done'
      and m.date_done >= ${von} and m.date_done < ${bis}::date + 1
    group by 1, 2, 3, 4`

  // --- Verbaute Komponenten je Variante (Komponentenverbrauch im Zeitraum)
  const komponenten = await sql<MonthRow[]>`
    select m.variant_id, coalesce(pv.display_name, pt.name) as product, pv.sku,
           to_char(date_trunc('month', m.date_done), 'YYYY-MM') as monat,
           sum(m.qty_done) as menge
    from stock_moves m
    join product_variants pv on pv.id = m.variant_id
    join product_templates pt on pt.id = pv.template_id
    where m.production_id is not null and m.reference = 'Komponentenverbrauch'
      and m.state = 'done'
      and m.date_done >= ${von} and m.date_done < ${bis}::date + 1
    group by 1, 2, 3, 4`

  // --- Abverkauf: verkauft ÷ (verkauft + Bestand) je verkaufter Variante
  const abverkauf = await sql<
    {
      variant_id: string
      product: string
      sku: string | null
      verkauft: number
      geliefert: number
      bestand: number
    }[]
  >`
    select l.variant_id, coalesce(pv.display_name, pt.name) as product, pv.sku,
           sum(l.qty) as verkauft, sum(l.qty_delivered) as geliefert,
           on_hand_qty(l.variant_id) as bestand
    from sales_order_lines l
    join sales_orders so on so.id = l.order_id
    join product_variants pv on pv.id = l.variant_id
    join product_templates pt on pt.id = pv.template_id
    where so.state = 'sale' and l.variant_id is not null
      and so.order_date >= ${von} and so.order_date < ${bis}::date + 1
    group by 1, 2, 3
    order by verkauft desc`

  const abverkaufMonate = await sql<MonthRow[]>`
    select l.variant_id, coalesce(pv.display_name, pt.name) as product, pv.sku,
           to_char(date_trunc('month', so.order_date), 'YYYY-MM') as monat,
           sum(l.qty) as menge
    from sales_order_lines l
    join sales_orders so on so.id = l.order_id
    join product_variants pv on pv.id = l.variant_id
    join product_templates pt on pt.id = pv.template_id
    where so.state = 'sale' and l.variant_id is not null
      and so.order_date >= ${von} and so.order_date < ${bis}::date + 1
    group by 1, 2, 3, 4`

  const verkauftJeMonat = pivot(abverkaufMonate, months)
  const produktionRows = pivot(produktion, months)
  const komponentenRows = pivot(komponenten, months)

  return (
    <>
      <PageHeader
        title="Mengen & Abverkauf"
        subtitle="Bestand, Produktion, verbaute Komponenten und Abverkauf"
        actions={
          <form className="row">
            <label className="field">
              <span>Von</span>
              <input type="date" name="von" defaultValue={von} />
            </label>
            <label className="field">
              <span>Bis</span>
              <input type="date" name="bis" defaultValue={bis} />
            </label>
            <div className="shrink field">
              <button type="submit">Anwenden</button>
            </div>
            <div className="shrink field">
              <Link className="btn" href="/auswertungen/kennzahlen">Zu den Kennzahlen</Link>
            </div>
          </form>
        }
      />

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <Stat
          label="Inventarwert"
          value={money(inventarSumme)}
          hint="bewerteter Bestand (gleitender Durchschnitt)"
        />
        <Stat
          label="Produziert im Zeitraum"
          value={qty(produktion.reduce((s, r) => s + Number(r.menge), 0))}
          hint="Fertigmeldungen, alle Varianten"
        />
        <Stat
          label="Verkauft im Zeitraum"
          value={qty(abverkauf.reduce((s, r) => s + Number(r.verkauft), 0))}
          hint="bestätigte Aufträge"
        />
      </div>

      <Card
        title="Abverkauf (Sell-Through)"
        actions={<span className="muted small">verkauft ÷ (verkauft + Bestand)</span>}
        tight
      >
        {abverkauf.length === 0 ? (
          <Empty>Keine bestätigten Aufträge im Zeitraum.</Empty>
        ) : (
          <>
          <ChartBox>
            <ColumnChart categories={months} series={toSeries(verkauftJeMonat, months)} unit="Stk." />
          </ChartBox>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Produkt</th>
                  <th className="num">Verkauft</th>
                  <th className="num">Geliefert</th>
                  <th className="num">Bestand</th>
                  <th className="num">Quote</th>
                  <th />
                  {months.map((m) => (
                    <th key={m} className="num small">{m}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {abverkauf.map((r) => {
                  const quote =
                    Number(r.verkauft) + Number(r.bestand) > 0
                      ? Number(r.verkauft) / (Number(r.verkauft) + Number(r.bestand))
                      : 0
                  const monate = verkauftJeMonat.find((v) => v.id === r.variant_id)
                  return (
                    <tr key={r.variant_id}>
                      <td>
                        {r.product}
                        {r.sku && <span className="muted small mono"> · {r.sku}</span>}
                      </td>
                      <td className="num">{qty(r.verkauft)}</td>
                      <td className="num">{qty(r.geliefert)}</td>
                      <td className="num">{qty(r.bestand)}</td>
                      <td className="num" style={summe}>
                        {(quote * 100).toFixed(0)} %
                      </td>
                      <td><Bar value={quote} max={1} /></td>
                      {months.map((m) => (
                        <td key={m} className="num muted mono">
                          {monate?.perMonth.has(m) ? qty(monate.perMonth.get(m)!) : '·'}
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableWrap>
          </>
        )}
      </Card>

      <Card title="Produktion je Endvariante" tight>
        {produktionRows.length > 0 && (
          <ChartBox>
            <ColumnChart categories={months} series={toSeries(produktionRows, months)} unit="Stk." />
          </ChartBox>
        )}
        <PivotTable rows={produktionRows} months={months} />
      </Card>

      <Card
        title="Verbaute Komponenten"
        actions={
          <span className="muted small">
            zählt den Komponentenverbrauch der Fertigung — z. B. „wie oft wurde weißes Gehäuse verbaut"
          </span>
        }
        tight
      >
        {komponentenRows.length > 0 && (
          <ChartBox>
            <HBars
              rows={komponentenRows.slice(0, 10).map((r) => ({ label: r.product, value: r.total }))}
            />
          </ChartBox>
        )}
        <PivotTable rows={komponentenRows} months={months} />
      </Card>

      <Card title="Inventarwert je Produkt" tight>
        {inventar.length === 0 ? (
          <Empty>Kein Bestand vorhanden.</Empty>
        ) : (
          <>
          <ChartBox>
            <ShareBar
              parts={(() => {
                const top = inventar.slice(0, 5).map((r) => ({ label: r.product, value: Number(r.value) }))
                const rest = inventar.slice(5).reduce((sum, r) => sum + Number(r.value), 0)
                return rest > 0 ? [...top, { label: `Übrige (${inventar.length - 5})`, value: rest }] : top
              })()}
              format={(v) => money(v)}
            />
          </ChartBox>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Produkt</th>
                  <th className="num">Bestand</th>
                  <th className="num">Einstandskosten</th>
                  <th className="num">Wert</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {inventar.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.product}
                      {r.sku && <span className="muted small mono"> · {r.sku}</span>}
                    </td>
                    <td className="num">{qty(r.on_hand)}</td>
                    <td className="num">{money(r.unit_cost)}</td>
                    <td className="num" style={summe}>{money(r.value)}</td>
                    <td><Bar value={Number(r.value)} max={Number(inventar[0]?.value ?? 0)} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} className="num muted">Gesamt</td>
                  <td className="num" style={summe}>{money(inventarSumme)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </TableWrap>
          </>
        )}
        <div className="small muted" style={{ padding: '8px 12px' }}>
          Kostenbasis: Einstandskosten des Produkts; ohne gepflegte Kosten wird die Summe der
          Stücklisten-Komponentenkosten der Variante angesetzt.
        </div>
      </Card>
    </>
  )
}
