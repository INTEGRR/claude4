import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { date, qty, money } from '@/modules/shared/format'
import {
  createOrderpoint,
  deleteOrderpoint,
  executeOrderpoint,
  snoozeOrderpoint,
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
      unit_price: number | null
    }[]
  >`select * from orderpoint_suggestions()`

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
                    <td className="num mono">{qty(v.qty_to_order)}</td>
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
                    <td className="num">
                      <div className="actions">
                        <ActionButton
                          className="small primary"
                          action={executeOrderpoint.bind(null, v.orderpoint_id)}
                        >
                          {v.route === 'manufacture' ? 'Fertigungsauftrag' : 'Bestellen'}
                        </ActionButton>
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
                    <td className="small muted mono nowrap">{r.snoozed_until ? date(r.snoozed_until) : '—'}</td>
                    <td className="num">
                      <ActionButton
                        className="small danger"
                        action={deleteOrderpoint.bind(null, r.id)}
                        confirm="Meldebestand-Regel löschen?"
                      >
                        Löschen
                      </ActionButton>
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
