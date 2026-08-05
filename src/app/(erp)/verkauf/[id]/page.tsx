import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { AuditLog, Badge, Card, Empty, type LogEntry, PageHeader, TableWrap } from '@/components/ui'
import { date, money, qty } from '@/modules/shared/format'
import {
  addLine,
  addNote,
  cancelOrder,
  confirmOrder,
  removeLine,
  resetToDraft,
  setLocked,
} from '../actions'

export const dynamic = 'force-dynamic'

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const [order] = await sql<
    {
      id: string
      number: string
      state: string
      locked: boolean
      delivery_status: string
      invoice_status: string
      source: string
      shopify_order_id: string | null
      shopify_order_name: string | null
      order_date: string
      currency: string
      note: string | null
      partner_id: string
      partner_name: string
      ship_name: string | null
      ship_street: string | null
      ship_house_number: string | null
      ship_zip: string | null
      ship_city: string | null
      ship_country_code: string | null
      net: number
      tax: number
      gross: number
    }[]
  >`
    select so.*, p.name as partner_name,
           t.net, t.tax, t.gross
    from sales_orders so
    join partners p on p.id = so.partner_id
    cross join lateral sales_order_total(so.id) t
    where so.id = ${id}`

  if (!order) notFound()

  const lines = await sql<
    {
      id: string
      name: string
      qty: number
      uom: string
      price_unit: number
      discount: number
      tax_rate: number
      qty_delivered: number
      subtotal: number
      variant_id: string | null
    }[]
  >`
    select l.id, l.name, l.qty, u.name as uom, l.price_unit, l.discount, l.tax_rate,
           l.qty_delivered, sale_line_subtotal(l) as subtotal, l.variant_id
    from sales_order_lines l
    left join uoms u on u.id = l.uom_id
    where l.order_id = ${id} and l.display_type is null
    order by l.sequence`

  const pickings = await sql<
    { id: string; number: string; state: string; date_done: string | null }[]
  >`
    select id, number, state, date_done from stock_pickings
    where origin_model = 'sales_order' and origin_id = ${id} order by created_at`

  const mos = await sql<
    { id: string; number: string; state: string; qty_to_produce: number; product: string }[]
  >`
    select mo.id, mo.number, mo.state, mo.qty_to_produce,
           variant_display_name(mo.variant_id) as product
    from manufacturing_orders mo where mo.sales_order_id = ${id} order by mo.created_at`

  const shipments = await sql<
    { id: string; shipment_number: string; state: string; tracking_url: string }[]
  >`
    select s.id, s.shipment_number, s.state, s.tracking_url
    from shipments s where s.sales_order_id = ${id} order by s.created_at`

  const log = await sql<LogEntry[]>`
    select id, kind, message, actor, created_at from audit_log
    where model = 'sales_order' and record_id = ${id} order by created_at desc limit 40`

  const products = await sql<{ id: string; label: string }[]>`
    select pv.id, coalesce(pv.display_name, pt.name) ||
           coalesce(' · ' || pv.sku, '') as label
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.active and pt.can_be_sold and pt.active
    order by label limit 500`

  const editable = order.state !== 'cancel' && !order.locked

  return (
    <>
      <PageHeader
        title={
          <>
            {order.number}
            {order.shopify_order_name && (
              <span className="muted" style={{ fontWeight: 400 }}> · {order.shopify_order_name}</span>
            )}
          </>
        }
        subtitle={
          <>
            {order.partner_name} · {date(order.order_date)}
            {order.source === 'shopify' && <> · aus Shopify importiert</>}
          </>
        }
        actions={
          <>
            <Badge state={order.state} kind="sale" />
            {order.locked && <span className="badge neutral">Gesperrt</span>}
            {(order.state === 'draft' || order.state === 'sent') && (
              <ActionButton className="primary" action={confirmOrder.bind(null, id)}>
                Bestätigen
              </ActionButton>
            )}
            {order.state === 'sale' &&
              (order.locked ? (
                <ActionButton action={setLocked.bind(null, id, false)}>Entsperren</ActionButton>
              ) : (
                <ActionButton action={setLocked.bind(null, id, true)}>Sperren</ActionButton>
              ))}
            {order.state !== 'cancel' && (
              <ActionButton
                className="danger"
                action={cancelOrder.bind(null, id)}
                confirm="Auftrag wirklich stornieren? Offene Lieferungen werden abgebrochen."
              >
                Stornieren
              </ActionButton>
            )}
            {(order.state === 'cancel' || order.state === 'sent') && (
              <ActionButton action={resetToDraft.bind(null, id)}>Auf Angebot zurücksetzen</ActionButton>
            )}
          </>
        }
      />

      {order.locked && (
        <div className="notice info">
          Der Auftrag ist gesperrt und kann nicht geändert werden. Zum Bearbeiten bitte entsperren.
        </div>
      )}

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <Card title="Lieferstatus">
          <Badge state={order.delivery_status} kind="delivery" />
        </Card>
        <Card title="Abrechnung">
          <Badge state={order.invoice_status} kind="invoice" />
        </Card>
        <Card title="Lieferadresse">
          <div className="small">
            {order.ship_name ?? order.partner_name}
            <br />
            {order.ship_street} {order.ship_house_number}
            <br />
            {order.ship_zip} {order.ship_city} {order.ship_country_code}
          </div>
        </Card>
      </div>

      <Card title="Positionen" tight>
        {lines.length === 0 ? (
          <Empty>Noch keine Positionen.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Produkt</th>
                  <th className="num">Menge</th>
                  <th>Einheit</th>
                  <th className="num">Geliefert</th>
                  <th className="num">Einzelpreis</th>
                  <th className="num">MwSt.</th>
                  <th className="num">Netto</th>
                  {editable && <th />}
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.name}</td>
                    <td className="num">{qty(l.qty)}</td>
                    <td>{l.uom}</td>
                    <td className="num">
                      {Number(l.qty_delivered) >= Number(l.qty) ? (
                        <span className="badge success">{qty(l.qty_delivered)}</span>
                      ) : (
                        qty(l.qty_delivered)
                      )}
                    </td>
                    <td className="num">{money(l.price_unit, order.currency)}</td>
                    <td className="num">{qty(l.tax_rate)} %</td>
                    <td className="num">{money(l.subtotal, order.currency)}</td>
                    {editable && (
                      <td className="num">
                        <ActionButton className="small danger" action={removeLine.bind(null, id, l.id)}>
                          Entfernen
                        </ActionButton>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={6} className="num muted">Netto</td>
                  <td className="num">{money(order.net, order.currency)}</td>
                  {editable && <td />}
                </tr>
                <tr>
                  <td colSpan={6} className="num muted">MwSt.</td>
                  <td className="num">{money(order.tax, order.currency)}</td>
                  {editable && <td />}
                </tr>
                <tr>
                  <td colSpan={6} className="num" style={{ fontWeight: 650 }}>Gesamt</td>
                  <td className="num" style={{ fontWeight: 650 }}>{money(order.gross, order.currency)}</td>
                  {editable && <td />}
                </tr>
              </tfoot>
            </table>
          </TableWrap>
        )}

        {editable && (
          <div style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
            <ActionForm action={addLine.bind(null, id)}>
              <div className="row">
                <label className="field" style={{ flex: 3 }}>
                  <span>Produkt</span>
                  <select name="variant_id" required>
                    <option value="">— auswählen —</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Menge</span>
                  <input type="number" name="qty" step="0.001" min="0.001" defaultValue={1} required />
                </label>
                <label className="field">
                  <span>Preis (optional)</span>
                  <input type="number" name="price_unit" step="0.01" placeholder="aus Produkt" />
                </label>
                <div className="shrink field">
                  <button className="primary" type="submit">Position hinzufügen</button>
                </div>
              </div>
            </ActionForm>
          </div>
        )}
      </Card>

      <div className="grid-2">
        <Card title={`Lieferungen (${pickings.length})`} tight>
          {pickings.length === 0 ? (
            <Empty>Noch keine Lieferung. Sie entsteht beim Bestätigen.</Empty>
          ) : (
            <TableWrap>
              <table>
                <tbody>
                  {pickings.map((p) => (
                    <tr key={p.id}>
                      <td className="mono"><Link href={`/lager/${p.id}`}>{p.number}</Link></td>
                      <td><Badge state={p.state} kind="picking" /></td>
                      <td className="nowrap">{date(p.date_done)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title={`Fertigungsaufträge (${mos.length})`} tight>
          {mos.length === 0 ? (
            <Empty>Keine Fertigung nötig.</Empty>
          ) : (
            <TableWrap>
              <table>
                <tbody>
                  {mos.map((m) => (
                    <tr key={m.id}>
                      <td className="mono"><Link href={`/fertigung/${m.id}`}>{m.number}</Link></td>
                      <td>{m.product}</td>
                      <td className="num">{qty(m.qty_to_produce)}</td>
                      <td><Badge state={m.state} kind="mo" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>

      {shipments.length > 0 && (
        <Card title="Sendungen" tight>
          <TableWrap>
            <table>
              <tbody>
                {shipments.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">
                      <a href={s.tracking_url} target="_blank" rel="noreferrer">{s.shipment_number}</a>
                    </td>
                    <td><Badge state={s.state} kind="shipment" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}

      <Card title="Verlauf">
        <ActionForm action={addNote.bind(null, id)} style={{ marginBottom: 12 }}>
          <div className="row">
            <input name="note" placeholder="Notiz hinzufügen…" />
            <div className="shrink">
              <button type="submit">Speichern</button>
            </div>
          </div>
        </ActionForm>
        <AuditLog entries={log} />
      </Card>
    </>
  )
}
