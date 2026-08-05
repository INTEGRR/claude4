import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { AuditLog, Badge, Card, type LogEntry, PageHeader, TableWrap } from '@/components/ui'
import { date, qty } from '@/modules/shared/format'
import { cancelPicking, checkAvailability, confirmPicking, returnPicking, validatePicking } from '../actions'

export const dynamic = 'force-dynamic'

export default async function PickingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const [picking] = await sql<
    {
      id: string
      number: string
      kind: string
      type_name: string
      state: string
      partner: string | null
      origin_model: string | null
      origin_id: string | null
      origin_label: string | null
      scheduled_date: string
      date_done: string | null
      backorder_of: string | null
      return_of: string | null
      note: string | null
    }[]
  >`
    select p.id, p.number, ot.kind, ot.name as type_name, p.state, part.name as partner,
           p.origin_model, p.origin_id, p.origin_label, p.scheduled_date, p.date_done,
           bo.number as backorder_of, ro.number as return_of, p.note
    from stock_pickings p
    join operation_types ot on ot.id = p.operation_type_id
    left join partners part on part.id = p.partner_id
    left join stock_pickings bo on bo.id = p.backorder_of_id
    left join stock_pickings ro on ro.id = p.return_of_id
    where p.id = ${id}`

  if (!picking) notFound()

  const moves = await sql<
    {
      id: string
      product: string
      sku: string | null
      qty: number
      qty_done: number
      reserved_qty: number
      uom: string
      state: string
      src: string
      dest: string
    }[]
  >`
    select m.id, variant_display_name(m.variant_id) as product, pv.sku, m.qty, m.qty_done,
           m.reserved_qty, u.name as uom, m.state, src.full_path as src, dst.full_path as dest
    from stock_moves m
    join product_variants pv on pv.id = m.variant_id
    join uoms u on u.id = m.uom_id
    join stock_locations src on src.id = m.src_location_id
    join stock_locations dst on dst.id = m.dest_location_id
    where m.picking_id = ${id}
    order by m.created_at`

  const shipments = await sql<
    { id: string; shipment_number: string; state: string; tracking_url: string }[]
  >`select id, shipment_number, state, tracking_url from shipments where picking_id = ${id}`

  const log = await sql<LogEntry[]>`
    select id, kind, message, actor, created_at from audit_log
    where model = 'stock_picking' and record_id = ${id} order by created_at desc limit 30`

  const open = picking.state !== 'done' && picking.state !== 'cancel'
  const originHref =
    picking.origin_model === 'sales_order'
      ? `/verkauf/${picking.origin_id}`
      : picking.origin_model === 'purchase_order'
        ? `/einkauf/${picking.origin_id}`
        : picking.origin_model === 'repair_order'
          ? `/reparatur/${picking.origin_id}`
          : null

  return (
    <>
      <PageHeader
        title={picking.number}
        subtitle={
          <>
            {picking.type_name}
            {picking.partner && <> · {picking.partner}</>}
            {picking.origin_label && (
              <>
                {' '}· Quellbeleg{' '}
                {originHref ? <Link href={originHref}>{picking.origin_label}</Link> : picking.origin_label}
              </>
            )}
            {picking.backorder_of && <> · Rückstand zu {picking.backorder_of}</>}
            {picking.return_of && <> · Retoure zu {picking.return_of}</>}
          </>
        }
        actions={
          <>
            <Badge state={picking.state} kind="picking" />
            {picking.state === 'draft' && (
              <ActionButton className="primary" action={confirmPicking.bind(null, id)}>
                Bestätigen
              </ActionButton>
            )}
            {open && picking.state !== 'draft' && (
              <ActionButton action={checkAvailability.bind(null, id)}>Verfügbarkeit prüfen</ActionButton>
            )}
            {picking.state === 'done' && (
              <ActionButton
                action={returnPicking.bind(null, id)}
                confirm="Retoure zu diesem Transfer anlegen?"
              >
                Retoure
              </ActionButton>
            )}
            {open && (
              <ActionButton className="danger" action={cancelPicking.bind(null, id)} confirm="Transfer stornieren?">
                Stornieren
              </ActionButton>
            )}
          </>
        }
      />

      {picking.state === 'done' && (
        <div className="notice success">
          Validiert am {date(picking.date_done)}. Erledigte Transfers sind unveränderlich — Korrekturen
          laufen über eine Retoure.
        </div>
      )}

      <Card title="Positionen" tight>
        {open ? (
          <ActionForm action={validatePicking.bind(null, id)}>
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Produkt</th>
                    <th>Von → Nach</th>
                    <th className="num">Bedarf</th>
                    <th className="num">Reserviert</th>
                    <th className="num" style={{ width: 150 }}>Erledigt</th>
                    <th>Einheit</th>
                  </tr>
                </thead>
                <tbody>
                  {moves.map((m) => (
                    <tr key={m.id}>
                      <td>
                        {m.product}
                        {m.sku && <span className="muted small"> · {m.sku}</span>}
                      </td>
                      <td className="small muted nowrap">{m.src} → {m.dest}</td>
                      <td className="num">{qty(m.qty)}</td>
                      <td className="num">
                        {Number(m.reserved_qty) >= Number(m.qty) ? (
                          <span className="badge success">{qty(m.reserved_qty)}</span>
                        ) : (
                          <span className="badge warn">{qty(m.reserved_qty)}</span>
                        )}
                      </td>
                      <td>
                        <input
                          type="number"
                          name={`done_${m.id}`}
                          step="0.001"
                          min="0"
                          max={m.qty}
                          defaultValue={m.qty}
                          required
                        />
                      </td>
                      <td>{m.uom}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>

            <div style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
              <div className="row">
                <label className="field" style={{ maxWidth: 340 }}>
                  <span>Bei Teilmenge</span>
                  <select name="backorder" defaultValue="yes">
                    <option value="yes">Rückstand für die Restmenge anlegen</option>
                    <option value="no">Restmenge aufgeben</option>
                  </select>
                </label>
                <div className="shrink field">
                  <button className="primary" type="submit">Validieren</button>
                </div>
              </div>
            </div>
          </ActionForm>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Produkt</th>
                  <th>Von → Nach</th>
                  <th className="num">Bedarf</th>
                  <th className="num">Gebucht</th>
                  <th>Einheit</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {moves.map((m) => (
                  <tr key={m.id}>
                    <td>{m.product}</td>
                    <td className="small muted nowrap">{m.src} → {m.dest}</td>
                    <td className="num">{qty(m.qty)}</td>
                    <td className="num">{qty(m.qty_done)}</td>
                    <td>{m.uom}</td>
                    <td><Badge state={m.state} kind="picking" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

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
        <AuditLog entries={log} />
      </Card>
    </>
  )
}
