import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { dateTime, qty } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

/** Rückverfolgung eines Loses: alle Bewegungen, Bestand je Ort. */
export default async function LosPage({ params }: { params: Promise<{ id: string }> }) {
  await requireArea('lager')
  const { id } = await params

  const [los] = await sql<
    { id: string; name: string; product: string; ref: string | null; note: string | null; created_at: string }[]
  >`
    select sl.id, sl.name, variant_display_name(sl.variant_id) as product,
           sl.ref, sl.note, sl.created_at
    from stock_lots sl where sl.id = ${id}`
  if (!los) notFound()

  const bestand = await sql<{ location: string; on_hand: number }[]>`
    select loc.full_path as location, lq.on_hand
    from stock_lot_quants lq
    join stock_locations loc on loc.id = lq.location_id
    where lq.lot_id = ${id} and lq.on_hand <> 0
    order by loc.full_path`

  const bewegungen = await sql<
    {
      move_id: string
      qty: number
      src: string
      dest: string
      state: string
      reference: string | null
      date_done: string | null
      beleg: string | null
      beleg_link: string | null
    }[]
  >`
    select m.id as move_id, a.qty, src.full_path as src, dst.full_path as dest,
           m.state, m.reference, m.date_done,
           coalesce(p.number, mo.number) as beleg,
           case
             when p.id is not null then '/lager/' || p.id
             when mo.id is not null then '/fertigung/' || mo.id
           end as beleg_link
    from move_lot_assignments a
    join stock_moves m on m.id = a.move_id
    join stock_locations src on src.id = m.src_location_id
    join stock_locations dst on dst.id = m.dest_location_id
    left join stock_pickings p on p.id = m.picking_id
    left join manufacturing_orders mo on mo.id = m.production_id
    where a.lot_id = ${id}
    order by coalesce(m.date_done, m.created_at)`

  return (
    <>
      <PageHeader
        title={los.name}
        subtitle={
          <>
            {los.product} · angelegt {dateTime(los.created_at)}
            {los.ref && <> · Referenz {los.ref}</>}
          </>
        }
      />

      <div className="grid-2">
        <Card title="Bestand je Ort" tight>
          {bestand.length === 0 ? (
            <Empty>Kein Bestand mehr unter dieser Nummer.</Empty>
          ) : (
            <TableWrap>
              <table>
                <tbody>
                  {bestand.map((b) => (
                    <tr key={b.location}>
                      <td>{b.location}</td>
                      <td className="num">{qty(b.on_hand)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title="Rückverfolgung" tight>
          {bewegungen.length === 0 ? (
            <Empty>Noch keine Bewegungen.</Empty>
          ) : (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Wann</th>
                    <th>Beleg</th>
                    <th>Weg</th>
                    <th className="num">Menge</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {bewegungen.map((b) => (
                    <tr key={b.move_id}>
                      <td className="nowrap small">{b.date_done ? dateTime(b.date_done) : '—'}</td>
                      <td className="mono small">
                        {b.beleg_link ? <Link href={b.beleg_link}>{b.beleg}</Link> : (b.reference ?? '—')}
                      </td>
                      <td className="small muted">{b.src} → {b.dest}</td>
                      <td className="num">{qty(b.qty)}</td>
                      <td><Badge state={b.state} kind="picking" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>
    </>
  )
}
