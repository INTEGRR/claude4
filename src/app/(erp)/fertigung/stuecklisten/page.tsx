import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { qty } from '@/modules/shared/format'
import { createBom } from '../actions'

export const dynamic = 'force-dynamic'

export default async function BomListPage() {
  await requireArea('fertigung')
  const boms = await sql<
    {
      id: string
      product: string
      variant: string | null
      qty: number
      uom: string
      lines: number
      filtered: number
      active: boolean
    }[]
  >`
    select b.id, pt.name as product,
           case when b.variant_id is not null then variant_display_name(b.variant_id) end as variant,
           b.qty, u.name as uom, b.active,
           (select count(*) from bom_lines l where l.bom_id = b.id)::int as lines,
           (select count(distinct l.id) from bom_lines l
             join bom_line_variant_filters f on f.bom_line_id = l.id
            where l.bom_id = b.id)::int as filtered
    from boms b
    join product_templates pt on pt.id = b.template_id
    join uoms u on u.id = b.uom_id
    order by pt.name`

  const templates = await sql<{ id: string; name: string }[]>`
    select id, name from product_templates where active and type = 'goods' order by name limit 300`

  return (
    <>
      <PageHeader
        title="Stücklisten"
        subtitle="Eine Stückliste je Produkt — einzelne Positionen lassen sich auf Varianten einschränken"
      />

      <Card title="Neue Stückliste">
        <ActionForm action={createBom}>
          <div className="row">
            <label className="field" style={{ flex: 3 }}>
              <span>Produkt</span>
              <select name="template_id" required defaultValue="">
                <option value="" disabled>— auswählen —</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Referenzmenge</span>
              <input type="number" name="qty" step="0.001" min="0.001" defaultValue={1} required />
            </label>
            <div className="shrink field">
              <button className="primary" type="submit">Anlegen</button>
            </div>
          </div>
        </ActionForm>
      </Card>

      <Card tight>
        {boms.length === 0 ? (
          <Empty>Noch keine Stücklisten.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Produkt</th>
                  <th>Gilt für</th>
                  <th className="num">Referenzmenge</th>
                  <th className="num">Positionen</th>
                  <th>Variantenabhängig</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {boms.map((b) => (
                  <tr key={b.id}>
                    <td><Link href={`/fertigung/stuecklisten/${b.id}`}>{b.product}</Link></td>
                    <td>{b.variant ?? <span className="muted">alle Varianten</span>}</td>
                    <td className="num">{qty(b.qty)} {b.uom}</td>
                    <td className="num">{b.lines}</td>
                    <td>
                      {b.filtered > 0 ? (
                        <span className="badge info">{b.filtered} gefiltert</span>
                      ) : (
                        <span className="muted small">—</span>
                      )}
                    </td>
                    {/* Inaktive Stücklisten sahen bisher aus wie aktive. */}
                    <td className="nowrap">
                      <span className={`led ${b.active ? 'ok' : 'off'}`} />{' '}
                      {b.active ? 'aktiv' : 'inaktiv'}
                    </td>
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
