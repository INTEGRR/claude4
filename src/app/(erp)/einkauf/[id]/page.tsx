import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { AuditLog, Badge, Card, Empty, type LogEntry, PageHeader, TableWrap } from '@/components/ui'
import { date, money, qty } from '@/modules/shared/format'
import {
  addPoLine,
  cancelPo,
  confirmPo,
  createBill,
  lockPo,
  removePoLine,
  sendPoEmail,
} from '../actions'

export const dynamic = 'force-dynamic'

export default async function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const [order] = await sql<
    {
      id: string
      number: string
      state: string
      vendor_id: string
      vendor: string
      vendor_email: string | null
      vendor_reference: string | null
      expected_arrival: string | null
      billing_status: string
      currency: string
      net: number
      tax: number
      gross: number
    }[]
  >`
    select po.*, p.name as vendor, p.email as vendor_email, t.net, t.tax, t.gross
    from purchase_orders po
    join partners p on p.id = po.vendor_id
    cross join lateral purchase_order_total(po.id) t
    where po.id = ${id}`

  if (!order) notFound()

  const lines = await sql<
    {
      id: string
      name: string
      qty: number
      uom: string
      price_unit: number
      qty_received: number
      qty_billed: number
      tax_rate: number
    }[]
  >`
    select l.id, l.name, l.qty, u.name as uom, l.price_unit, l.qty_received, l.qty_billed, l.tax_rate
    from purchase_order_lines l join uoms u on u.id = l.uom_id
    where l.order_id = ${id} order by l.sequence`

  const receipts = await sql<{ id: string; number: string; state: string; date_done: string | null }[]>`
    select id, number, state, date_done from stock_pickings
    where origin_model = 'purchase_order' and origin_id = ${id} order by created_at`

  const bills = await sql<{ id: string; number: string; state: string; bill_date: string | null }[]>`
    select id, number, state, bill_date from vendor_bills
    where purchase_order_id = ${id} order by created_at`

  const log = await sql<LogEntry[]>`
    select id, kind, message, actor, created_at from audit_log
    where model = 'purchase_order' and record_id = ${id} order by created_at desc limit 30`

  const products = await sql<{ id: string; label: string }[]>`
    select pv.id, coalesce(pv.display_name, pt.name) || coalesce(' · ' || pv.sku, '') as label
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.active and pt.active and pt.can_be_purchased
    order by label limit 500`

  const editable = order.state === 'draft' || order.state === 'sent'

  return (
    <>
      <PageHeader
        title={order.number}
        subtitle={
          <>
            {order.vendor}
            {order.vendor_reference && <> · Referenz {order.vendor_reference}</>}
            {order.expected_arrival && <> · erwartet {date(order.expected_arrival)}</>}
          </>
        }
        actions={
          <>
            <Badge state={order.state} kind="purchase" />
            {editable && (
              <ActionButton action={sendPoEmail.bind(null, id)} title={order.vendor_email ?? undefined}>
                Per E-Mail senden
              </ActionButton>
            )}
            {editable && (
              <ActionButton className="primary" action={confirmPo.bind(null, id)}>
                Bestellung bestätigen
              </ActionButton>
            )}
            {order.state === 'purchase' && (
              <ActionButton action={lockPo.bind(null, id, true)}>Sperren</ActionButton>
            )}
            {order.state === 'done' && (
              <ActionButton action={lockPo.bind(null, id, false)}>Entsperren</ActionButton>
            )}
            {(order.state === 'purchase' || order.state === 'done') && (
              <ActionButton action={createBill.bind(null, id)}>Rechnung erstellen</ActionButton>
            )}
            {order.state !== 'cancel' && (
              <ActionButton className="danger" action={cancelPo.bind(null, id)} confirm="Bestellung stornieren?">
                Stornieren
              </ActionButton>
            )}
          </>
        }
      />

      {order.state === 'done' && (
        <div className="notice info">Die Bestellung ist gesperrt. Zum Bearbeiten bitte entsperren.</div>
      )}

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
                  <th className="num">Erhalten</th>
                  <th className="num">Abgerechnet</th>
                  <th className="num">Preis</th>
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
                      {Number(l.qty_received) >= Number(l.qty) ? (
                        <span className="badge success">{qty(l.qty_received)}</span>
                      ) : Number(l.qty_received) > 0 ? (
                        <span className="badge warn">{qty(l.qty_received)}</span>
                      ) : (
                        <span className="muted">0</span>
                      )}
                    </td>
                    <td className="num">
                      {Number(l.qty_billed) >= Number(l.qty) ? (
                        <span className="badge success">{qty(l.qty_billed)}</span>
                      ) : (
                        qty(l.qty_billed)
                      )}
                    </td>
                    <td className="num">{money(l.price_unit, order.currency)}</td>
                    <td className="num">{money(Number(l.qty) * Number(l.price_unit), order.currency)}</td>
                    {editable && (
                      <td className="num">
                        <ActionButton className="small danger" action={removePoLine.bind(null, id, l.id)}>
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
                  <td colSpan={6} className="num" style={{ fontWeight: 650 }}>Gesamt (brutto)</td>
                  <td className="num" style={{ fontWeight: 650 }}>{money(order.gross, order.currency)}</td>
                  {editable && <td />}
                </tr>
              </tfoot>
            </table>
          </TableWrap>
        )}

        {editable && (
          <div style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
            <ActionForm action={addPoLine.bind(null, id)}>
              <div className="row">
                <label className="field" style={{ flex: 3 }}>
                  <span>Produkt</span>
                  <select name="variant_id" required defaultValue="">
                    <option value="" disabled>— auswählen —</option>
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
                  <input type="number" name="price_unit" step="0.01" placeholder="aus Preisliste" />
                </label>
                <div className="shrink field">
                  <button className="primary" type="submit">Hinzufügen</button>
                </div>
              </div>
            </ActionForm>
          </div>
        )}
      </Card>

      <div className="grid-2">
        <Card title={`Wareneingänge (${receipts.length})`} tight>
          {receipts.length === 0 ? (
            <Empty>Entsteht beim Bestätigen der Bestellung.</Empty>
          ) : (
            <TableWrap>
              <table>
                <tbody>
                  {receipts.map((r) => (
                    <tr key={r.id}>
                      <td className="mono"><Link href={`/lager/${r.id}`}>{r.number}</Link></td>
                      <td><Badge state={r.state} kind="picking" /></td>
                      <td className="nowrap">{date(r.date_done)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title={`Rechnungen (${bills.length})`} tight>
          {bills.length === 0 ? (
            <Empty>Noch keine Rechnung.</Empty>
          ) : (
            <TableWrap>
              <table>
                <tbody>
                  {bills.map((b) => (
                    <tr key={b.id}>
                      <td className="mono">
                        <Link href={`/einkauf/rechnungen/${b.id}`}>{b.number}</Link>
                      </td>
                      <td><Badge state={b.state} kind="bill" /></td>
                      <td className="nowrap">{date(b.bill_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>

      <Card title="Verlauf">
        <AuditLog entries={log} />
      </Card>
    </>
  )
}
