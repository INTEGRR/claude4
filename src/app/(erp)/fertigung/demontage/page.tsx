import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { dateTime, qty } from '@/modules/shared/format'
import { applyUnbuild, createUnbuild } from '../actions'

export const dynamic = 'force-dynamic'

export default async function DemontagePage() {
  const orders = await sql<
    {
      id: string
      number: string
      product: string
      qty: number
      state: string
      created_at: string
      on_hand: number
    }[]
  >`
    select u.id, u.number, variant_display_name(u.variant_id) as product, u.qty, u.state,
           u.created_at, on_hand_qty(u.variant_id, u.src_location_id) as on_hand
    from unbuild_orders u order by u.created_at desc limit 60`

  const products = await sql<{ id: string; label: string; on_hand: number }[]>`
    select pv.id, coalesce(pv.display_name, pt.name) as label, on_hand_qty(pv.id) as on_hand
    from product_variants pv
    join product_templates pt on pt.id = pv.template_id
    where pv.active and pt.active and resolve_bom(pv.id) is not null
    order by label limit 300`

  return (
    <>
      <PageHeader
        title="Demontage"
        subtitle="Ein gefertigtes Produkt wieder in seine Komponenten zerlegen — anhand der Stückliste der jeweiligen Variante"
      />

      <Card title="Neuer Demontageauftrag">
        <ActionForm action={createUnbuild}>
          <div className="row">
            <label className="field" style={{ flex: 3 }}>
              <span>Produkt</span>
              <select name="variant_id" required defaultValue="">
                <option value="" disabled>— auswählen —</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} (Bestand: {qty(p.on_hand)})
                  </option>
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
      </Card>

      <Card tight>
        {orders.length === 0 ? (
          <Empty>Noch keine Demontageaufträge.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nummer</th>
                  <th>Produkt</th>
                  <th className="num">Menge</th>
                  <th className="num">Bestand</th>
                  <th>Status</th>
                  <th>Angelegt</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const short = Number(o.on_hand) < Number(o.qty)
                  return (
                    <tr key={o.id}>
                      <td className="mono">{o.number}</td>
                      <td>{o.product}</td>
                      <td className="num">{qty(o.qty)}</td>
                      <td className="num">
                        {o.state === 'done' ? (
                          <span className="muted">{qty(o.on_hand)}</span>
                        ) : short ? (
                          <span className="badge warn">{qty(o.on_hand)}</span>
                        ) : (
                          <span className="badge success">{qty(o.on_hand)}</span>
                        )}
                      </td>
                      <td>
                        <span className={`badge ${o.state === 'done' ? 'success' : 'neutral'}`}>
                          {o.state === 'done' ? 'Demontiert' : 'Entwurf'}
                        </span>
                      </td>
                      <td className="nowrap small">{dateTime(o.created_at)}</td>
                      <td className="num">
                        {o.state !== 'done' && (
                          <div className="actions" style={{ justifyContent: 'flex-end' }}>
                            <ActionButton
                              className="small primary"
                              action={applyUnbuild.bind(null, o.id, false)}
                            >
                              Demontieren
                            </ActionButton>
                            {short && (
                              <ActionButton
                                className="small danger"
                                action={applyUnbuild.bind(null, o.id, true)}
                                confirm="Der Bestand reicht nicht aus. Trotzdem demontieren? Das führt zu einem negativen Bestand."
                              >
                                Trotzdem
                              </ActionButton>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  )
}
