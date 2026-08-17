import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionButton, ActionForm } from '@/components/action-button'
import { MengenWahl } from '@/components/mengen-wahl'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { date, qty, money } from '@/modules/shared/format'
import Link from 'next/link'
import {
  createOrderpoint,
  deleteOrderpoint,
  executeOrderpoint,
  snoozeOrderpoint,
  wakeOrderpoint,
} from '../actions'

export const dynamic = 'force-dynamic'

/**
 * Beschaffung (Odoo: Replenishment / Reordering Rules): Min/Max-Regeln je
 * Variante und die daraus entstehenden Vorschläge — ausführbar als
 * Entwurfs-Bestellung oder Fertigungsauftrag.
 */

export default async function BeschaffungPage() {
  await requireArea('lager')

  const vorschlaege = await sql<
    {
      orderpoint_id: string
      product: string
      location: string
      qty_on_hand: number
      qty_forecast: number
      min_qty: number
      max_qty: number
      qty_to_order: number
      route: string | null
      vendor_name: string | null
      moq: number | null
      qty_empfohlen: number
      unit_price: number | null
      staffeln: { min_qty: number; netto: number }[]
    }[]
  >`
    select s.*,
           coalesce((select json_agg(json_build_object('min_qty', st.min_qty, 'netto', st.netto)
                                     order by st.min_qty)
                     from vendor_staffeln(s.variant_id, s.vendor_id) st), '[]'::json)
             as staffeln
    from orderpoint_suggestions() s`

  // Was aus früheren Klicks schon offen ist. Der offene Zulauf zählt seit
  // 0053 in die Vorschlagsrechnung (ausgeführte Vorschläge verschwinden) —
  // die Spalte zeigt, WOHIN der Bedarf gewandert ist, solange der Beleg lebt.
  const offen = await sql<
    { orderpoint_id: string; beleg: string; art: string; ziel: string; menge: number }[]
  >`
    select op.id as orderpoint_id, po.number as beleg, 'Bestellung' as art,
           po.id::text as ziel, sum(pol.qty) as menge
    from stock_orderpoints op
    join purchase_order_lines pol on pol.variant_id = op.variant_id
    join purchase_orders po on po.id = pol.order_id and po.state in ('draft', 'sent')
    group by 1, 2, 3, 4
    union all
    select mo.orderpoint_id, mo.number, 'Fertigungsauftrag', mo.id::text, mo.qty_to_produce
    from manufacturing_orders mo
    where mo.orderpoint_id is not null and mo.state not in ('done', 'cancel')`

  const regeln = await sql<
    {
      id: string
      product: string
      location: string
      min_qty: number
      max_qty: number
      qty_multiple: number
      route: string | null
      snoozed_until: string | null
      active: boolean
    }[]
  >`
    select op.id, variant_display_name(op.variant_id) as product,
           loc.full_path as location, op.min_qty, op.max_qty, op.qty_multiple,
           op.route, op.snoozed_until::text, op.active
    from stock_orderpoints op
    join stock_locations loc on loc.id = op.location_id
    order by product`

  const variants = await sql<{ id: string; label: string }[]>`
    select pv.id, coalesce(pv.display_name, pt.name) || coalesce(' · ' || pv.sku, '') as label
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.active and pt.active and pt.type = 'goods'
    order by label limit 500`

  return (
    <>
      <PageHeader
        title="Beschaffung"
        subtitle="Meldebestände: Vorschläge entstehen, sobald die Prognose unter den Mindestbestand fällt"
      />

      {regeln.some((r) => r.snoozed_until && r.snoozed_until >= new Date().toISOString().slice(0, 10)) && (
        <div className="notice info">
          {regeln.filter((r) => r.snoozed_until && r.snoozed_until >= new Date().toISOString().slice(0, 10)).length}{' '}
          Regel(n) schlummern und erscheinen deshalb nicht in den Vorschlägen. Sie stehen unten
          in der Regelliste und lassen sich dort wieder aufwecken.
        </div>
      )}

      <Card title={`Beschaffungsvorschläge (${vorschlaege.length})`} tight>
        {vorschlaege.length === 0 ? (
          <Empty>Kein Bedarf — alle Prognosen liegen über dem Mindestbestand.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Produkt</th>
                  <th className="num">Bestand</th>
                  <th className="num">Prognose</th>
                  <th className="num">Min / Max</th>
                  <th className="num">Vorschlag</th>
                  <th>Weg</th>
                  <th>Lieferant</th>
                  <th>Bereits veranlasst</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {vorschlaege.map((v) => (
                  <tr key={v.orderpoint_id}>
                    <td>{v.product}</td>
                    <td className="num">{qty(v.qty_on_hand)}</td>
                    <td className="num">
                      {qty(v.qty_forecast)}
                      <div className="small muted nowrap">
                        <span className="led warn" /> unter Minimum
                      </div>
                    </td>
                    <td className="num small muted">
                      {qty(v.min_qty)} / {qty(v.max_qty)}
                    </td>
                    <td className="num">
                      <span className="mono">{qty(v.qty_to_order)}</span>
                      {/* MOQ hebt nur die EMPFEHLUNG an — der rechnerische
                          Bedarf bleibt sichtbar, entschieden wird rechts. */}
                      {v.moq != null && v.qty_empfohlen > v.qty_to_order && (
                        <div className="small muted nowrap">
                          MOQ {qty(v.moq)} → empfohlen {qty(v.qty_empfohlen)}
                        </div>
                      )}
                    </td>
                    <td>
                      <span className="badge neutral">
                        {v.route === 'manufacture' ? 'Fertigen' : 'Einkaufen'}
                      </span>
                    </td>
                    <td className="small">
                      {v.vendor_name ?? '—'}
                      {v.unit_price != null && (
                        <> · <span className="mono nowrap">{money(v.unit_price)}</span></>
                      )}
                    </td>
                    <td className="small">
                      {offen
                        .filter((o) => o.orderpoint_id === v.orderpoint_id)
                        .map((o) => (
                          <div key={o.beleg} className="nowrap">
                            <span className="led ok" />{' '}
                            <Link
                              className="mono"
                              href={o.art === 'Bestellung' ? `/einkauf/${o.ziel}` : `/fertigung/${o.ziel}`}
                            >
                              {o.beleg}
                            </Link>{' '}
                            <span className="muted">· {qty(o.menge)}</span>
                          </div>
                        ))}
                      {offen.every((o) => o.orderpoint_id !== v.orderpoint_id) && (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num">
                      {/* Menge wird ABGEFRAGT, nicht stumm angehoben: das Feld
                          trägt die Empfehlung, die Chips begründen Alternativen
                          (günstigere Staffelgrenzen), entschieden wird hier. */}
                      <ActionForm action={executeOrderpoint.bind(null, v.orderpoint_id)}>
                        <div className="row" style={{ alignItems: 'flex-start', gap: 6, flexWrap: 'nowrap' }}>
                          <MengenWahl
                            vorgabe={Number(v.qty_empfohlen)}
                            optionen={(v.staffeln ?? [])
                              .filter(
                                (st) =>
                                  Number(st.min_qty) > Number(v.qty_empfohlen) &&
                                  v.unit_price != null &&
                                  Number(st.netto) < Number(v.unit_price),
                              )
                              .map((st) => ({
                                menge: Number(st.min_qty),
                                label: `ab ${qty(Number(st.min_qty))}: ${money(Number(st.netto))}`,
                                hinweis: `Staffelpreis — spart ${Math.round((1 - Number(st.netto) / Number(v.unit_price!)) * 100)} % je Stück`,
                              }))}
                          />
                          <div className="shrink">
                            <button className="small primary" type="submit">
                              {v.route === 'manufacture' ? 'Fertigungsauftrag' : 'Bestellen'}
                            </button>
                          </div>
                        </div>
                      </ActionForm>
                      <div className="actions" style={{ marginTop: 6, justifyContent: 'flex-end' }}>
                        <ActionButton
                          className="small"
                          action={snoozeOrderpoint.bind(null, v.orderpoint_id, 7)}
                        >
                          7 Tage schlummern
                        </ActionButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Card title={`Meldebestand-Regeln (${regeln.length})`} tight>
        {regeln.length > 0 && (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Produkt</th>
                  <th>Lagerort</th>
                  <th className="num">Min</th>
                  <th className="num">Max</th>
                  <th className="num">Vielfaches</th>
                  <th>Weg</th>
                  <th>Schlummert bis</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {regeln.map((r) => (
                  <tr key={r.id}>
                    <td>{r.product}</td>
                    <td className="small muted mono">{r.location}</td>
                    <td className="num">{qty(r.min_qty)}</td>
                    <td className="num">{qty(r.max_qty)}</td>
                    <td className="num">{qty(r.qty_multiple)}</td>
                    <td className="small">
                      {r.route === 'manufacture' ? 'Fertigen' : r.route === 'buy' ? 'Einkaufen' : 'aus Produktrouten'}
                    </td>
                    <td className="small nowrap">
                      {r.snoozed_until && r.snoozed_until >= new Date().toISOString().slice(0, 10) ? (
                        <>
                          <span className="led off" />{' '}
                          <span className="mono muted">schlummert bis {date(r.snoozed_until)}</span>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num">
                      <div className="actions" style={{ justifyContent: 'flex-end' }}>
                        {r.snoozed_until && r.snoozed_until >= new Date().toISOString().slice(0, 10) && (
                          <ActionButton className="small" action={wakeOrderpoint.bind(null, r.id)}>
                            Aufwecken
                          </ActionButton>
                        )}
                        <ActionButton
                          className="small danger"
                          action={deleteOrderpoint.bind(null, r.id)}
                          confirm="Meldebestand-Regel löschen?"
                        >
                          Löschen
                        </ActionButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <div style={{ padding: 12 }}>
          <ActionForm action={createOrderpoint}>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <label className="field" style={{ flex: 3 }}>
                <span>Produkt</span>
                <select name="variant_id" required defaultValue="">
                  <option value="" disabled>— auswählen —</option>
                  {variants.map((v) => (
                    <option key={v.id} value={v.id}>{v.label}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Mindestbestand</span>
                <input type="number" name="min_qty" step="0.001" min="0" required />
              </label>
              <label className="field">
                <span>Maximalbestand</span>
                <input type="number" name="max_qty" step="0.001" min="0" required />
              </label>
              <label className="field">
                <span>Vielfaches</span>
                <input type="number" name="qty_multiple" step="0.001" min="0.001" defaultValue={1} />
              </label>
              <label className="field">
                <span>Weg</span>
                <select name="route" defaultValue="">
                  <option value="">aus Produktrouten</option>
                  <option value="buy">Einkaufen</option>
                  <option value="manufacture">Fertigen</option>
                </select>
              </label>
              <div className="shrink field">
                <button className="primary" type="submit">Regel anlegen</button>
              </div>
            </div>
          </ActionForm>
        </div>
      </Card>
    </>
  )
}
