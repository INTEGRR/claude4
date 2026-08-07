import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { money, qty } from '@/modules/shared/format'
import { createProduct } from './actions'

export const dynamic = 'force-dynamic'

export default async function ProduktePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  await requireArea('produkte')
  const { q } = await searchParams

  const rows = await sql<
    {
      id: string
      name: string
      uom: string
      list_price: number
      variants: number
      on_hand: number
      has_bom: boolean
      route_manufacture: boolean
      route_buy: boolean
    }[]
  >`
    select pt.id, pt.name, u.name as uom, pt.list_price,
           (select count(*) from product_variants pv where pv.template_id = pt.id and pv.active)::int as variants,
           coalesce((select sum(on_hand_qty(pv.id)) from product_variants pv
                      where pv.template_id = pt.id and pv.active), 0) as on_hand,
           exists (select 1 from boms b where b.template_id = pt.id and b.active) as has_bom,
           pt.route_manufacture, pt.route_buy
    from product_templates pt
    join uoms u on u.id = pt.uom_id
    where pt.active
      and (${q ?? null}::text is null or pt.name ilike ${'%' + (q ?? '') + '%'})
    order by pt.name limit 300`

  const uoms = await sql<{ id: string; name: string; category: string }[]>`
    select u.id, u.name, c.name as category from uoms u
    join uom_categories c on c.id = u.category_id
    where u.active order by c.name, u.ratio`

  return (
    <>
      <PageHeader
        title="Produkte"
        subtitle="Produktvorlagen mit Attributen und Varianten"
        actions={
          <>
            <Link className="btn" href="/produkte/attribute">Attribute</Link>
            <Link className="btn" href="/produkte/konfiguration">Konfiguration</Link>
          </>
        }
      />

      <Card title="Neues Produkt">
        <ActionForm action={createProduct}>
          <div className="row">
            <label className="field" style={{ flex: 3 }}>
              <span>Name</span>
              <input name="name" required placeholder="z. B. Tastatur" />
            </label>
            <label className="field">
              <span>Artikelnummer</span>
              <input name="sku" placeholder="optional" />
            </label>
            <label className="field">
              <span>Einheit</span>
              <select name="uom_id" required defaultValue={uoms.find((u) => u.name === 'Stück')?.id}>
                {uoms.map((u) => (
                  <option key={u.id} value={u.id}>{u.name} ({u.category})</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Verkaufspreis</span>
              <input type="number" name="list_price" step="0.01" defaultValue={0} />
            </label>
            <label className="field">
              <span>Gewicht (g)</span>
              <input type="number" name="weight_g" step="1" defaultValue={0} />
            </label>
          </div>
          <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
            <label className="shrink"><input type="checkbox" name="can_be_sold" defaultChecked /> Verkaufbar</label>
            <label className="shrink"><input type="checkbox" name="can_be_purchased" /> Einkaufbar</label>
            <label className="shrink"><input type="checkbox" name="route_buy" /> Route: Einkaufen</label>
            <label className="shrink"><input type="checkbox" name="route_manufacture" /> Route: Fertigen</label>
            <label className="shrink"><input type="checkbox" name="route_mto" /> Route: Auf Bestellung (MTO)</label>
          </div>
          <button className="primary" type="submit">Produkt anlegen</button>
        </ActionForm>
      </Card>

      <Card tight>
        <div style={{ padding: 12 }}>
          <form style={{ display: 'flex', gap: 8, maxWidth: 420 }}>
            <input type="search" name="q" placeholder="Produkt suchen" defaultValue={q ?? ''} />
            <button type="submit">Suchen</button>
          </form>
        </div>

        {rows.length === 0 ? (
          <Empty>Keine Produkte gefunden.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Varianten</th>
                  <th className="num">Bestand</th>
                  <th>Einheit</th>
                  <th className="num">Preis</th>
                  <th>Beschaffung</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><Link href={`/produkte/${r.id}`}>{r.name}</Link></td>
                    <td className="num">{r.variants}</td>
                    <td className="num">{qty(r.on_hand)}</td>
                    <td>{r.uom}</td>
                    <td className="num">{money(r.list_price)}</td>
                    <td>
                      {r.route_manufacture && (
                        <span className={`badge ${r.has_bom ? 'info' : 'warn'}`}>
                          {r.has_bom ? 'Fertigung' : 'Fertigung ohne Stückliste'}
                        </span>
                      )}{' '}
                      {r.route_buy && <span className="badge neutral">Einkauf</span>}
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
