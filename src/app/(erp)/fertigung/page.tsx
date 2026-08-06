import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { date, qty } from '@/modules/shared/format'
import { createMo } from './actions'

export const dynamic = 'force-dynamic'

export default async function FertigungPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  await requireArea('fertigung')
  const { status } = await searchParams

  const rows = await sql<
    {
      id: string
      number: string
      product: string
      qty_to_produce: number
      qty_produced: number
      state: string
      scheduled_date: string
      sales_order_number: string | null
      sales_order_id: string | null
      missing: number
    }[]
  >`
    select mo.id, mo.number, variant_display_name(mo.variant_id) as product,
           mo.qty_to_produce, mo.qty_produced, mo.state, mo.scheduled_date,
           so.number as sales_order_number, so.id as sales_order_id,
           (select count(*) from stock_moves m
             where m.production_id = mo.id and m.state not in ('done','cancel')
               and m.reserved_qty < m.qty)::int as missing
    from manufacturing_orders mo
    left join sales_orders so on so.id = mo.sales_order_id
    where (${status ?? null}::text is null or mo.state = ${status ?? null}::mo_state)
    order by
      case mo.state when 'progress' then 0 when 'confirmed' then 1 when 'draft' then 2 else 3 end,
      mo.scheduled_date
    limit 200`

  const products = await sql<{ id: string; label: string }[]>`
    select distinct pv.id, coalesce(pv.display_name, pt.name) as label
    from product_variants pv
    join product_templates pt on pt.id = pv.template_id
    where pv.active and pt.active and resolve_bom(pv.id) is not null
    order by label limit 300`

  const filters = [
    { key: undefined, label: 'Alle' },
    { key: 'confirmed', label: 'Bestätigt' },
    { key: 'progress', label: 'In Bearbeitung' },
    { key: 'done', label: 'Erledigt' },
  ]

  return (
    <>
      <PageHeader
        title="Fertigungsaufträge"
        subtitle="Aufträge aus dem Verkauf (MTO) und manuell angelegte Aufträge"
        actions={<Link className="btn" href="/fertigung/demontage">Demontage</Link>}
      />

      <Card title="Neuer Fertigungsauftrag">
        <ActionForm action={createMo}>
          <div className="row">
            <label className="field" style={{ flex: 3 }}>
              <span>Produkt (nur Produkte mit Stückliste)</span>
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
            <div className="shrink field">
              <button className="primary" type="submit">Anlegen</button>
            </div>
          </div>
        </ActionForm>
        {products.length === 0 && (
          <div className="notice warn" style={{ marginBottom: 0 }}>
            Es gibt noch kein Produkt mit Stückliste. Lege zuerst eine unter{' '}
            <Link href="/fertigung/stuecklisten">Stücklisten</Link> an.
          </div>
        )}
      </Card>

      <Card tight>
        <div style={{ padding: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {filters.map((f) => (
            <Link
              key={f.label}
              href={f.key ? `/fertigung?status=${f.key}` : '/fertigung'}
              className={`btn small${status === f.key ? ' primary' : ''}`}
            >
              {f.label}
            </Link>
          ))}
        </div>

        {rows.length === 0 ? (
          <Empty>Keine Fertigungsaufträge.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nummer</th>
                  <th>Produkt</th>
                  <th className="num">Menge</th>
                  <th>Status</th>
                  <th>Material</th>
                  <th>Auftrag</th>
                  <th>Termin</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono"><Link href={`/fertigung/${r.id}`}>{r.number}</Link></td>
                    <td>{r.product}</td>
                    <td className="num">
                      {qty(r.qty_produced)} / {qty(r.qty_to_produce)}
                    </td>
                    <td><Badge state={r.state} kind="mo" /></td>
                    <td>
                      {r.state === 'done' || r.state === 'cancel' ? (
                        <span className="muted small">—</span>
                      ) : r.missing > 0 ? (
                        <span className="badge warn">{r.missing} fehlt</span>
                      ) : (
                        <span className="badge success">vollständig</span>
                      )}
                    </td>
                    <td className="mono">
                      {r.sales_order_id ? (
                        <Link href={`/verkauf/${r.sales_order_id}`}>{r.sales_order_number}</Link>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="nowrap">{date(r.scheduled_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  )
}
