import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { dateTime, qty } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

/** Los-/Seriennummernübersicht (stock.lot) mit Bestand je Los. */
export default async function LosePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  await requireArea('lager')
  const { q } = await searchParams

  const lose = await sql<
    {
      id: string
      name: string
      product: string
      tracking: string
      on_hand: number
      created_at: string
    }[]
  >`
    select sl.id, sl.name, variant_display_name(sl.variant_id) as product,
           pt.tracking,
           coalesce((select sum(lq.on_hand) from stock_lot_quants lq
                     join stock_locations loc on loc.id = lq.location_id
                     where lq.lot_id = sl.id and loc.type = 'internal'), 0) as on_hand,
           sl.created_at
    from stock_lots sl
    join product_variants pv on pv.id = sl.variant_id
    join product_templates pt on pt.id = pv.template_id
    where (${q ?? null}::text is null
           or sl.name ilike ${'%' + (q ?? '') + '%'}
           or variant_display_name(sl.variant_id) ilike ${'%' + (q ?? '') + '%'})
    order by sl.created_at desc
    limit 200`

  return (
    <>
      <PageHeader
        title="Lose & Seriennummern"
        subtitle="Rückverfolgung: welches Los steckt wo — vom Wareneingang bis zur Auslieferung"
      />

      <Card tight>
        <div style={{ padding: 12 }}>
          <form>
            <label className="field" style={{ maxWidth: 340, marginBottom: 0 }}>
              <span>Suche</span>
              <input
                type="search"
                name="q"
                placeholder="Los-/Seriennummer oder Produkt suchen"
                defaultValue={q ?? ''}
              />
            </label>
          </form>
        </div>
        {lose.length === 0 ? (
          <Empty>
            Noch keine Lose. Sie entstehen automatisch, sobald ein Produkt auf
            Los- oder Serienverfolgung steht (Produkt → Rückverfolgung).
          </Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nummer</th>
                  <th>Produkt</th>
                  <th>Art</th>
                  <th className="num">Bestand</th>
                  <th>Angelegt</th>
                </tr>
              </thead>
              <tbody>
                {lose.map((l) => (
                  <tr key={l.id}>
                    <td className="mono">
                      <Link href={`/lager/lose/${l.id}`}>{l.name}</Link>
                    </td>
                    <td>{l.product}</td>
                    <td>
                      <span className="badge neutral">
                        {l.tracking === 'serial' ? 'Seriennummer' : 'Los'}
                      </span>
                    </td>
                    <td className="num">
                      {qty(l.on_hand)}
                      <div className="small muted nowrap">
                        <span className={Number(l.on_hand) > 0 ? 'led ok' : 'led off'} />{' '}
                        {Number(l.on_hand) > 0 ? 'auf Lager' : 'leer'}
                      </div>
                    </td>
                    <td className="nowrap small muted mono">{dateTime(l.created_at)}</td>
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
