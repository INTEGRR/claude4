import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { dateTime, qty } from '@/modules/shared/format'
import { applyCount, createCount, deleteCount } from '../actions'

export const dynamic = 'force-dynamic'

export default async function InventurPage() {
  const counts = await sql<
    {
      id: string
      product: string
      location: string
      counted_qty: number
      book_qty: number
      current_qty: number
      applied_at: string | null
      applied_by: string | null
    }[]
  >`
    select c.id, variant_display_name(c.variant_id) as product, l.full_path as location,
           c.counted_qty, c.book_qty, c.applied_at, c.applied_by,
           coalesce((select on_hand from stock_quants q
                      where q.location_id = c.location_id and q.variant_id = c.variant_id), 0) as current_qty
    from inventory_counts c
    join stock_locations l on l.id = c.location_id
    order by c.applied_at nulls first, c.created_at desc
    limit 100`

  const variants = await sql<{ id: string; label: string; on_hand: number }[]>`
    select pv.id, coalesce(pv.display_name, pt.name) as label, on_hand_qty(pv.id) as on_hand
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.active and pt.active and pt.type = 'goods'
    order by label limit 500`

  const open = counts.filter((c) => !c.applied_at)
  const applied = counts.filter((c) => c.applied_at)

  return (
    <>
      <PageHeader
        title="Inventur"
        subtitle="Gezählte Mengen erfassen und buchen — die Differenz läuft gegen den Inventurdifferenz-Ort"
      />

      <Card title="Zählung erfassen">
        <ActionForm action={createCount}>
          <div className="row">
            <label className="field" style={{ flex: 3 }}>
              <span>Produkt</span>
              <select name="variant_id" required defaultValue="">
                <option value="" disabled>— auswählen —</option>
                {variants.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label} (Bestand: {qty(v.on_hand)})
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Gezählte Menge</span>
              <input type="number" name="counted_qty" step="0.001" min="0" required />
            </label>
            <div className="shrink field">
              <button className="primary" type="submit">Erfassen</button>
            </div>
          </div>
        </ActionForm>
      </Card>

      <Card title={`Offene Zählungen (${open.length})`} tight>
        {open.length === 0 ? (
          <Empty>Keine offenen Zählungen.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Produkt</th>
                  <th>Lagerort</th>
                  <th className="num">Buchbestand</th>
                  <th className="num">Gezählt</th>
                  <th className="num">Differenz</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {open.map((c) => {
                  const diff = Number(c.counted_qty) - Number(c.book_qty)
                  const changed = Number(c.current_qty) !== Number(c.book_qty)
                  return (
                    <tr key={c.id}>
                      <td>{c.product}</td>
                      <td className="small muted">{c.location}</td>
                      <td className="num">{qty(c.book_qty)}</td>
                      <td className="num">{qty(c.counted_qty)}</td>
                      <td className="num">
                        <span className={`badge ${diff === 0 ? 'neutral' : diff > 0 ? 'success' : 'warn'}`}>
                          {diff > 0 ? '+' : ''}
                          {qty(diff)}
                        </span>
                      </td>
                      <td className="num">
                        <div className="actions" style={{ justifyContent: 'flex-end' }}>
                          {changed && (
                            <span className="badge danger" title="Bestand hat sich seit der Zählung geändert">
                              jetzt {qty(c.current_qty)}
                            </span>
                          )}
                          <ActionButton className="small primary" action={applyCount.bind(null, c.id)}>
                            Buchen
                          </ActionButton>
                          <ActionButton className="small" action={deleteCount.bind(null, c.id)}>
                            Verwerfen
                          </ActionButton>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {applied.length > 0 && (
        <Card title="Gebuchte Zählungen" tight>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Produkt</th>
                  <th className="num">Vorher</th>
                  <th className="num">Gezählt</th>
                  <th>Gebucht</th>
                  <th>Von</th>
                </tr>
              </thead>
              <tbody>
                {applied.slice(0, 30).map((c) => (
                  <tr key={c.id}>
                    <td>{c.product}</td>
                    <td className="num muted">{qty(c.book_qty)}</td>
                    <td className="num">{qty(c.counted_qty)}</td>
                    <td className="nowrap small">{dateTime(c.applied_at)}</td>
                    <td className="small">{c.applied_by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}
    </>
  )
}
