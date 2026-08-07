import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { ActionButton } from '@/components/action-button'
import { Card, Empty, PageHeader, Stat, TableWrap } from '@/components/ui'
import { ColumnChart, HBars, ShareBar } from '@/components/charts'
import { dateTime, money, qty } from '@/modules/shared/format'
import { refreshAnalytics } from '../actions'

export const dynamic = 'force-dynamic'

/**
 * Kennzahlen aus den materialisierten Sichten (Migration 0023). Die Zahlen
 * sind so frisch wie der letzte Lauf — das steht bewusst im Kopf der Seite,
 * damit niemand eine Momentaufnahme für Echtzeit hält.
 */

function monat(iso: string): string {
  return iso.slice(0, 7)
}

/** Prozent mit einer Nachkommastelle, robust gegen Division durch null. */
function anteil(zaehler: number, nenner: number): string {
  if (!(nenner > 0)) return '—'
  return `${((zaehler / nenner) * 100).toFixed(1)} %`
}

export default async function KennzahlenPage() {
  const user = await requireArea('auswertungen')
  const darfRechnen = canWrite(user.role, 'auswertungen')

  const [stand] = await sql<{ refreshed_at: string | null }[]>`
    select value ->> 'refreshed_at' as refreshed_at from settings where key = 'analytics'`

  // --- Bestandswert im Zeitverlauf (letzte 12 Monate) ----------------------
  const wertverlauf = await sql<{ monat: string; value_end: number }[]>`
    select monat::text, sum(value_end) as value_end
    from mv_stock_value_history
    where monat >= date_trunc('month', current_date) - interval '11 months'
    group by 1 order by 1`

  // --- Deckungsbeitrag je Monat -------------------------------------------
  const margeMonat = await sql<
    { monat: string; revenue: number; cost: number; margin: number; qty: number }[]
  >`
    select monat::text, sum(revenue) as revenue, sum(cost) as cost,
           sum(revenue) - sum(cost) as margin, sum(qty) as qty
    from mv_contribution_margin
    where monat >= date_trunc('month', current_date) - interval '11 months'
    group by 1 order by 1`

  // --- Deckungsbeitrag je Variante (12 Monate) ----------------------------
  const margeVariante = await sql<
    {
      variant_id: string
      product: string
      sku: string | null
      qty: number
      revenue: number
      cost: number
      margin: number
    }[]
  >`
    select m.variant_id, variant_display_name(m.variant_id) as product, pv.sku,
           sum(m.qty) as qty, sum(m.revenue) as revenue, sum(m.cost) as cost,
           sum(m.revenue) - sum(m.cost) as margin
    from mv_contribution_margin m
    join product_variants pv on pv.id = m.variant_id
    where m.monat >= date_trunc('month', current_date) - interval '12 months'
    group by 1, 2, 3
    having sum(m.qty) <> 0
    order by margin desc`

  // --- Umschlag und Reichweite --------------------------------------------
  const umschlag = await sql<
    {
      variant_id: string
      product: string
      sku: string | null
      on_hand: number
      value_now: number
      avg_value_12m: number
      cogs_12m: number
      turnover: number | null
      days_of_supply: number | null
    }[]
  >`
    select variant_id, product, sku, on_hand, value_now, avg_value_12m, cogs_12m,
           turnover, days_of_supply
    from mv_inventory_turnover
    where on_hand <> 0 or cogs_12m <> 0
    order by value_now desc nulls last`

  // --- Lieferantentreue (12 Monate) ---------------------------------------
  const lieferanten = await sql<
    {
      vendor_id: string
      vendor: string
      lines: number
      delivered: number
      on_time: number
      overdue: number
      avg_delay_days: number | null
      qty_ordered: number
      qty_received: number
    }[]
  >`
    select vendor_id, vendor, sum(lines)::int as lines, sum(delivered)::int as delivered,
           sum(on_time)::int as on_time, sum(overdue)::int as overdue,
           round(avg(avg_delay_days), 1) as avg_delay_days,
           sum(qty_ordered) as qty_ordered, sum(qty_received) as qty_received
    from mv_supplier_otd
    where monat >= date_trunc('month', current_date) - interval '12 months'
    group by 1, 2
    order by lines desc`

  // --- RMA-Quote ----------------------------------------------------------
  const rmaMonat = await sql<
    { monat: string; rma_count: number; qty_delivered: number }[]
  >`
    select monat::text, sum(rma_count)::int as rma_count, sum(qty_delivered) as qty_delivered
    from mv_rma_analysis
    where monat >= date_trunc('month', current_date) - interval '11 months'
    group by 1 order by 1`

  const rmaVariante = await sql<
    {
      variant_id: string
      product: string
      rma_count: number
      repaired: number
      qty_delivered: number
    }[]
  >`
    select r.variant_id, variant_display_name(r.variant_id) as product,
           sum(r.rma_count)::int as rma_count, sum(r.repaired)::int as repaired,
           sum(r.qty_delivered) as qty_delivered
    from mv_rma_analysis r
    where r.monat >= date_trunc('month', current_date) - interval '12 months'
    group by 1, 2
    having sum(r.rma_count) > 0
    order by rma_count desc
    limit 20`

  // --- Arbeitszeit --------------------------------------------------------
  const arbeitszeit = await sql<
    { monat: string; kind: string; minutes: number; cost: number }[]
  >`
    select monat::text, kind, sum(minutes) as minutes, sum(cost) as cost
    from mv_labor_hours
    where monat >= date_trunc('month', current_date) - interval '11 months'
    group by 1, 2 order by 1`

  const monate = [...new Set([
    ...wertverlauf.map((r) => monat(r.monat)),
    ...margeMonat.map((r) => monat(r.monat)),
    ...rmaMonat.map((r) => monat(r.monat)),
    ...arbeitszeit.map((r) => monat(r.monat)),
  ])].sort()

  const umsatz12 = margeVariante.reduce((s, r) => s + Number(r.revenue), 0)
  const einsatz12 = margeVariante.reduce((s, r) => s + Number(r.cost), 0)
  const bestandswert = umschlag.reduce((s, r) => s + Number(r.value_now), 0)
  const lieferzeilen = lieferanten.reduce((s, r) => s + r.lines, 0)
  const puenktlich = lieferanten.reduce((s, r) => s + r.on_time, 0)
  const geliefert = lieferanten.reduce((s, r) => s + r.delivered, 0)
  const rmaGesamt = rmaVariante.reduce((s, r) => s + r.rma_count, 0)
  const geliefertMenge = rmaMonat.reduce((s, r) => s + Number(r.qty_delivered), 0)

  return (
    <>
      <PageHeader
        title="Kennzahlen"
        subtitle={
          <>
            Deckungsbeitrag, Umschlag, Liefertreue und RMA-Quote — berechnet aus dem
            Bewegungs- und Wertschichten-Ledger
            {stand?.refreshed_at && (
              <>
                {' · Stand '}
                <span className="mono">{dateTime(stand.refreshed_at)}</span>
              </>
            )}
          </>
        }
        actions={
          <>
            {darfRechnen && (
              <ActionButton action={refreshAnalytics}>Neu berechnen</ActionButton>
            )}
            <Link className="btn" href="/auswertungen">Zu den Mengen</Link>
          </>
        }
      />

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <Stat
          label="Deckungsbeitrag (12 Monate)"
          value={money(umsatz12 - einsatz12)}
          hint={`${money(umsatz12)} Umsatz − ${money(einsatz12)} Wareneinsatz`}
        />
        <Stat
          label="Rohertragsquote"
          value={anteil(umsatz12 - einsatz12, umsatz12)}
          hint="Deckungsbeitrag je Euro Umsatz"
        />
        <Stat label="Bestandswert" value={money(bestandswert)} hint="bewerteter Bestand heute" />
      </div>

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <Stat
          label="Liefertreue"
          value={anteil(puenktlich, geliefert)}
          hint={`${puenktlich} von ${geliefert} gelieferten Positionen pünktlich`}
        />
        <Stat
          label="Offene Bestellpositionen"
          value={String(lieferzeilen - geliefert)}
          hint={`${lieferanten.reduce((s, r) => s + r.overdue, 0)} davon überfällig`}
        />
        <Stat
          label="RMA-Quote"
          value={anteil(rmaGesamt, geliefertMenge)}
          hint={`${rmaGesamt} Reparaturauftrag/-aufträge in 12 Monaten`}
        />
      </div>

      <Card
        title="Umsatz und Wareneinsatz je Monat"
        actions={
          <span className="mono-label">
            Deckungsbeitrag = Abstand der Säulen · Werte in der Tabelle
          </span>
        }
        tight
      >
        <div style={{ padding: '12px 12px 0' }}>
          <ColumnChart
            categories={monate}
            series={[
              {
                name: 'Umsatz',
                values: monate.map((m) =>
                  Number(margeMonat.find((r) => monat(r.monat) === m)?.revenue ?? 0),
                ),
              },
              {
                name: 'Wareneinsatz',
                values: monate.map((m) =>
                  Number(margeMonat.find((r) => monat(r.monat) === m)?.cost ?? 0),
                ),
              },
            ]}
            unit="€"
          />
        </div>
        {margeMonat.length === 0 ? (
          <Empty>Noch keine Auslieferung gebucht.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Monat</th>
                  <th className="num">Menge</th>
                  <th className="num">Umsatz</th>
                  <th className="num">Wareneinsatz</th>
                  <th className="num">Deckungsbeitrag</th>
                  <th className="num">Quote</th>
                </tr>
              </thead>
              <tbody>
                {margeMonat.map((r) => (
                  <tr key={r.monat}>
                    <td className="mono">{monat(r.monat)}</td>
                    <td className="num mono">{qty(r.qty)}</td>
                    <td className="num mono">{money(r.revenue)}</td>
                    <td className="num mono muted">{money(r.cost)}</td>
                    <td className="num mono" style={{ fontWeight: 650 }}>{money(r.margin)}</td>
                    <td className="num mono">{anteil(Number(r.margin), Number(r.revenue))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Card title="Bestandswert am Monatsende" tight>
        <div style={{ padding: '12px 12px 0' }}>
          <ColumnChart
            categories={wertverlauf.map((r) => monat(r.monat))}
            series={[
              { name: 'Bestandswert', values: wertverlauf.map((r) => Number(r.value_end)) },
            ]}
            unit="€"
          />
        </div>
      </Card>

      <Card title={`Deckungsbeitrag je Variante (${margeVariante.length})`} tight>
        {margeVariante.length === 0 ? (
          <Empty>Noch keine Auslieferung gebucht.</Empty>
        ) : (
          <>
            {(() => {
              const positiv = margeVariante.filter((r) => Number(r.margin) > 0)
              if (positiv.length === 0) {
                return (
                  <div className="notice warn" style={{ margin: 12 }}>
                    Keine Variante trägt derzeit einen positiven Deckungsbeitrag — der
                    Verkaufspreis liegt unter den Herstellkosten.
                  </div>
                )
              }
              const top = positiv.slice(0, 5).map((r) => ({
                label: r.product,
                value: Number(r.margin),
              }))
              const rest = positiv.slice(5).reduce((s, r) => s + Number(r.margin), 0)
              const parts =
                rest > 0 ? [...top, { label: `Übrige (${positiv.length - 5})`, value: rest }] : top
              return (
                <div style={{ padding: 12 }}>
                  <ShareBar parts={parts} format={(v) => money(v)} />
                </div>
              )
            })()}
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Produkt</th>
                    <th className="num">Menge</th>
                    <th className="num">Umsatz</th>
                    <th className="num">Wareneinsatz</th>
                    <th className="num">Deckungsbeitrag</th>
                    <th className="num">Quote</th>
                  </tr>
                </thead>
                <tbody>
                  {margeVariante.map((r) => (
                    <tr key={r.variant_id}>
                      <td>
                        <Link href={`/produkte/variante/${r.variant_id}`}>{r.product}</Link>
                        {r.sku && <span className="muted small mono"> · {r.sku}</span>}
                      </td>
                      <td className="num mono">{qty(r.qty)}</td>
                      <td className="num mono">{money(r.revenue)}</td>
                      <td className="num mono muted">{money(r.cost)}</td>
                      <td className="num mono" style={{ fontWeight: 650 }}>{money(r.margin)}</td>
                      <td className="num mono">
                        {Number(r.margin) < 0 && <span className="led warn" />}{' '}
                        {anteil(Number(r.margin), Number(r.revenue))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </>
        )}
      </Card>

      <Card
        title="Lagerumschlag und Reichweite"
        actions={<span className="mono-label">12 Monate · Verbrauch 90 Tage</span>}
        tight
      >
        {umschlag.length === 0 ? (
          <Empty>Noch kein bewerteter Bestand.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Produkt</th>
                  <th className="num">Bestand</th>
                  <th className="num">Wert</th>
                  <th className="num">Ø Wert (12 M.)</th>
                  <th className="num">Wareneinsatz</th>
                  <th className="num">Umschlag</th>
                  <th className="num">Reichweite</th>
                </tr>
              </thead>
              <tbody>
                {umschlag.map((r) => {
                  const tage = r.days_of_supply === null ? null : Number(r.days_of_supply)
                  // Unter 14 Tagen wird es eng, über 365 liegt Kapital tot.
                  const led = tage === null ? 'off' : tage < 14 ? 'on' : tage > 365 ? 'warn' : 'ok'
                  return (
                    <tr key={r.variant_id}>
                      <td>
                        <Link href={`/produkte/variante/${r.variant_id}`}>{r.product}</Link>
                        {r.sku && <span className="muted small mono"> · {r.sku}</span>}
                      </td>
                      <td className="num mono">{qty(r.on_hand)}</td>
                      <td className="num mono">{money(r.value_now)}</td>
                      <td className="num mono muted">{money(r.avg_value_12m)}</td>
                      <td className="num mono muted">{money(r.cogs_12m)}</td>
                      <td className="num mono">
                        {r.turnover === null ? '—' : `${Number(r.turnover).toFixed(2)}×`}
                      </td>
                      <td className="num nowrap">
                        <span className={`led ${led}`} />{' '}
                        <span className="mono">
                          {tage === null ? 'kein Verbrauch' : `${qty(tage)} Tage`}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Card title={`Lieferantentreue (${lieferanten.length})`} tight>
        {lieferanten.length === 0 ? (
          <Empty>Noch keine bestätigte Bestellung.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Lieferant</th>
                  <th className="num">Positionen</th>
                  <th className="num">Geliefert</th>
                  <th className="num">Pünktlich</th>
                  <th className="num">Überfällig</th>
                  <th className="num">Ø Abweichung</th>
                  <th className="num">Mengentreue</th>
                </tr>
              </thead>
              <tbody>
                {lieferanten.map((l) => {
                  const quote = l.delivered > 0 ? l.on_time / l.delivered : 0
                  return (
                    <tr key={l.vendor_id}>
                      <td>
                        <Link href={`/kontakte/${l.vendor_id}`}>{l.vendor}</Link>
                      </td>
                      <td className="num mono">{l.lines}</td>
                      <td className="num mono">{l.delivered}</td>
                      <td className="num nowrap">
                        <span
                          className={`led ${l.delivered === 0 ? 'off' : quote >= 0.9 ? 'ok' : quote >= 0.7 ? 'warn' : 'on'}`}
                        />{' '}
                        <span className="mono">{anteil(l.on_time, l.delivered)}</span>
                      </td>
                      <td className="num mono">{l.overdue > 0 ? l.overdue : '—'}</td>
                      <td className="num mono muted">
                        {l.avg_delay_days === null
                          ? '—'
                          : `${Number(l.avg_delay_days) > 0 ? '+' : ''}${Number(l.avg_delay_days)} Tage`}
                      </td>
                      <td className="num mono">{anteil(Number(l.qty_received), Number(l.qty_ordered))}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Card title="RMA-Quote" tight>
        {rmaVariante.length === 0 ? (
          <Empty>Keine Reparaturaufträge im Zeitraum — nichts zu beanstanden.</Empty>
        ) : (
          <>
            <div style={{ padding: 12 }}>
              <HBars
                unit="RMA"
                rows={rmaVariante.slice(0, 10).map((r) => ({
                  label: r.product,
                  value: r.rma_count,
                }))}
              />
            </div>
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Produkt</th>
                    <th className="num">RMA</th>
                    <th className="num">davon repariert</th>
                    <th className="num">Geliefert</th>
                    <th className="num">Quote</th>
                  </tr>
                </thead>
                <tbody>
                  {rmaVariante.map((r) => (
                    <tr key={r.variant_id}>
                      <td>{r.product}</td>
                      <td className="num mono">{r.rma_count}</td>
                      <td className="num mono muted">{r.repaired}</td>
                      <td className="num mono muted">{qty(r.qty_delivered)}</td>
                      <td className="num mono">{anteil(r.rma_count, Number(r.qty_delivered))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </>
        )}
      </Card>

      {arbeitszeit.length > 0 && (
        <Card title="Erfasste Arbeitszeit je Monat" tight>
          <div style={{ padding: '12px 12px 0' }}>
            <ColumnChart
              categories={monate}
              series={[
                {
                  name: 'Anwesenheit',
                  values: monate.map((m) =>
                    Number(
                      arbeitszeit.find((r) => monat(r.monat) === m && r.kind === 'attendance')
                        ?.minutes ?? 0,
                    ) / 60,
                  ),
                },
                {
                  name: 'Auftragszeit',
                  values: monate.map((m) =>
                    Number(
                      arbeitszeit.find((r) => monat(r.monat) === m && r.kind === 'production')
                        ?.minutes ?? 0,
                    ) / 60,
                  ),
                },
              ]}
              unit="h"
            />
          </div>
        </Card>
      )}
    </>
  )
}
