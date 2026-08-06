import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { qty } from '@/modules/shared/format'
import { scrapProduct } from '../actions'

export const dynamic = 'force-dynamic'

export default async function BestandPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; filter?: string }>
}) {
  await requireArea('lager')
  const { q, filter } = await searchParams

  const rows = await sql<
    {
      id: string
      product: string
      sku: string | null
      uom: string
      on_hand: number
      free: number
      incoming: number
      outgoing: number
      forecasted: number
    }[]
  >`
    select pv.id, coalesce(pv.display_name, pt.name) as product, pv.sku, u.name as uom,
           on_hand_qty(pv.id) as on_hand,
           free_to_use(pv.id) as free,
           incoming_qty(pv.id) as incoming,
           outgoing_qty(pv.id) as outgoing,
           forecasted_qty(pv.id) as forecasted
    from product_variants pv
    join product_templates pt on pt.id = pv.template_id
    join uoms u on u.id = pt.uom_id
    where pv.active and pt.active and pt.type = 'goods'
      and (${q ?? null}::text is null
           or coalesce(pv.display_name, pt.name) ilike ${'%' + (q ?? '') + '%'}
           or coalesce(pv.sku, '') ilike ${'%' + (q ?? '') + '%'})
    order by product
    limit 500`

  const shown = filter === 'unterdeckung' ? rows.filter((r) => Number(r.forecasted) < 0) : rows

  const variants = await sql<{ id: string; label: string }[]>`
    select pv.id, coalesce(pv.display_name, pt.name) as label
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.active and pt.type = 'goods' order by label limit 500`

  const under = rows.filter((r) => Number(r.forecasted) < 0).length

  return (
    <>
      <PageHeader
        title="Bestand"
        subtitle="Prognose = Bestand + erwartete Eingänge − geplante Abgänge"
        actions={<Link className="btn" href="/lager/inventur">Inventur</Link>}
      />

      {under > 0 && filter !== 'unterdeckung' && (
        <div className="notice warn">
          {under} Produkt(e) laufen in eine Unterdeckung.{' '}
          <Link href="/lager/bestand?filter=unterdeckung">Nur diese anzeigen</Link>
        </div>
      )}

      <Card tight>
        <div style={{ padding: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
          <form style={{ flex: 1, display: 'flex', gap: 8 }}>
            <input type="search" name="q" placeholder="Produkt oder Artikelnummer" defaultValue={q ?? ''} />
            <button type="submit">Suchen</button>
          </form>
          {filter === 'unterdeckung' && (
            <Link className="btn small" href="/lager/bestand">Filter aufheben</Link>
          )}
        </div>

        {shown.length === 0 ? (
          <Empty>Keine Produkte gefunden.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Produkt</th>
                  <th>Artikelnr.</th>
                  <th className="num">Bestand</th>
                  <th className="num">Frei</th>
                  <th className="num">Eingehend</th>
                  <th className="num">Ausgehend</th>
                  <th className="num">Prognose</th>
                  <th>Einheit</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td><Link href={`/produkte/variante/${r.id}`}>{r.product}</Link></td>
                    <td className="mono small">{r.sku ?? '—'}</td>
                    <td className="num">{qty(r.on_hand)}</td>
                    <td className="num">{qty(r.free)}</td>
                    <td className="num muted">{qty(r.incoming)}</td>
                    <td className="num muted">{qty(r.outgoing)}</td>
                    <td className="num">
                      {Number(r.forecasted) < 0 ? (
                        <span className="badge danger">{qty(r.forecasted)}</span>
                      ) : (
                        qty(r.forecasted)
                      )}
                    </td>
                    <td>{r.uom}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Card title="Ausschuss buchen">
        <ActionForm action={scrapProduct}>
          <div className="row">
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
              <span>Menge</span>
              <input type="number" name="qty" step="0.001" min="0.001" required />
            </label>
            <label className="field" style={{ flex: 2 }}>
              <span>Grund</span>
              <input name="reason" placeholder="z. B. Transportschaden" />
            </label>
            <div className="shrink field">
              <button type="submit">Ausbuchen</button>
            </div>
          </div>
        </ActionForm>
      </Card>
    </>
  )
}
