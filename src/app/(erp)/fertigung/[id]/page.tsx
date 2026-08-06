import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Badge, Card, PageHeader, TableWrap } from '@/components/ui'
import { RecordComments } from '@/components/record-comments'
import { date, qty } from '@/modules/shared/format'
import { cancelMo, checkAvailability, confirmMo, produceMo, startMo } from '../actions'

export const dynamic = 'force-dynamic'

export default async function MoPage({ params }: { params: Promise<{ id: string }> }) {
  await requireArea('fertigung')
  const { id } = await params

  const [mo] = await sql<
    {
      id: string
      number: string
      product: string
      variant_id: string
      qty_to_produce: number
      qty_produced: number
      state: string
      scheduled_date: string
      date_done: string | null
      sales_order_id: string | null
      sales_order_number: string | null
      backorder_of_number: string | null
      uom: string
      consumption: string
    }[]
  >`
    select mo.id, mo.number, variant_display_name(mo.variant_id) as product, mo.variant_id,
           mo.qty_to_produce, mo.qty_produced, mo.state, mo.scheduled_date, mo.date_done,
           mo.sales_order_id, so.number as sales_order_number,
           bo.number as backorder_of_number, u.name as uom, b.consumption
    from manufacturing_orders mo
    left join sales_orders so on so.id = mo.sales_order_id
    left join manufacturing_orders bo on bo.id = mo.backorder_of_id
    left join uoms u on u.id = mo.uom_id
    left join boms b on b.id = mo.bom_id
    where mo.id = ${id}`

  if (!mo) notFound()

  const components = await sql<
    {
      id: string
      product: string
      qty: number
      qty_done: number
      reserved_qty: number
      uom: string
      state: string
      available: number
    }[]
  >`
    select m.id, variant_display_name(m.variant_id) as product, m.qty, m.qty_done,
           m.reserved_qty, u.name as uom, m.state,
           free_to_use(m.variant_id) + m.reserved_qty as available
    from stock_moves m
    join uoms u on u.id = m.uom_id
    where m.production_id = ${id} and m.reference = 'Komponentenverbrauch'
    order by m.created_at`


  const open = mo.state !== 'done' && mo.state !== 'cancel'
  const remaining = Number(mo.qty_to_produce) - Number(mo.qty_produced)

  return (
    <>
      <PageHeader
        title={mo.number}
        subtitle={
          <>
            {mo.product} · {qty(mo.qty_to_produce)} {mo.uom} · Termin {date(mo.scheduled_date)}
            {mo.sales_order_id && (
              <>
                {' '}· Auftrag <Link href={`/verkauf/${mo.sales_order_id}`}>{mo.sales_order_number}</Link>
              </>
            )}
            {mo.backorder_of_number && <> · Rückstand zu {mo.backorder_of_number}</>}
          </>
        }
        actions={
          <>
            <Badge state={mo.state} kind="mo" />
            <Link className="btn" href={`/fertigung/${id}/druck`} target="_blank">
              Drucken
            </Link>
            {mo.state === 'draft' && (
              <ActionButton className="primary" action={confirmMo.bind(null, id)}>Bestätigen</ActionButton>
            )}
            {open && mo.state !== 'draft' && (
              <ActionButton action={checkAvailability.bind(null, id)}>Verfügbarkeit prüfen</ActionButton>
            )}
            {mo.state === 'confirmed' && (
              <ActionButton action={startMo.bind(null, id)}>Fertigung starten</ActionButton>
            )}
            {open && (
              <ActionButton
                className="danger"
                action={cancelMo.bind(null, id)}
                confirm="Fertigungsauftrag stornieren? Reservierungen werden freigegeben."
              >
                Stornieren
              </ActionButton>
            )}
          </>
        }
      />

      {mo.state === 'done' && (
        <div className="notice success">
          Fertig gemeldet: {qty(mo.qty_produced)} {mo.uom} am {date(mo.date_done)}.
        </div>
      )}

      <Card
        title="Komponenten"
        actions={
          <span className="muted small">
            Verbrauchsregel:{' '}
            {mo.consumption === 'blocked'
              ? 'Abweichung gesperrt'
              : mo.consumption === 'allowed'
                ? 'Abweichung erlaubt'
                : 'Abweichung mit Warnung'}
          </span>
        }
        tight
      >
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Komponente</th>
                <th className="num">Bedarf</th>
                <th>Einheit</th>
                <th className="num">Reserviert</th>
                <th className="num">Verfügbar</th>
                <th className="num">Verbraucht</th>
              </tr>
            </thead>
            <tbody>
              {components.map((c) => {
                const short = Number(c.reserved_qty) < Number(c.qty) && c.state !== 'done'
                return (
                  <tr key={c.id}>
                    <td>{c.product}</td>
                    <td className="num">{qty(c.qty)}</td>
                    <td>{c.uom}</td>
                    <td className="num">
                      {short ? (
                        <span className="badge warn">{qty(c.reserved_qty)}</span>
                      ) : (
                        <span className="badge success">{qty(c.reserved_qty)}</span>
                      )}
                    </td>
                    <td className="num muted">{qty(c.available)}</td>
                    <td className="num">{c.state === 'done' ? qty(c.qty_done) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      {open && (
        <Card title="Fertig melden">
          <ActionForm action={produceMo.bind(null, id)}>
            <div className="row" style={{ marginBottom: 12 }}>
              <label className="field">
                <span>Produzierte Menge</span>
                <input
                  type="number"
                  name="qty"
                  step="0.001"
                  min="0.001"
                  max={remaining}
                  defaultValue={remaining}
                  required
                />
              </label>
              <label className="field">
                <span>Bei Teilmenge</span>
                <select name="backorder" defaultValue="yes">
                  <option value="yes">Rückstand für die Restmenge anlegen</option>
                  <option value="no">Restmenge verwerfen</option>
                </select>
              </label>
            </div>

            <details>
              <summary className="muted small" style={{ cursor: 'pointer', marginBottom: 8 }}>
                Ist-Verbrauch anpassen (z. B. Ausschuss beim Einbau)
              </summary>
              <TableWrap>
                <table>
                  <thead>
                    <tr>
                      <th>Komponente</th>
                      <th className="num">Soll</th>
                      <th className="num" style={{ width: 160 }}>Ist</th>
                    </tr>
                  </thead>
                  <tbody>
                    {components
                      .filter((c) => c.state !== 'done' && c.state !== 'cancel')
                      .map((c) => (
                        <tr key={c.id}>
                          <td>{c.product}</td>
                          <td className="num">{qty(c.qty)} {c.uom}</td>
                          <td>
                            <input
                              type="number"
                              name={`consumed_${c.id}`}
                              step="0.001"
                              min="0"
                              placeholder={String(c.qty)}
                            />
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </TableWrap>
            </details>

            <div style={{ marginTop: 12 }}>
              <button className="primary" type="submit">Fertig melden</button>
            </div>
          </ActionForm>
        </Card>
      )}

      <RecordComments model="manufacturing_order" recordId={id} path={`/fertigung/${id}`} />
    </>
  )
}
