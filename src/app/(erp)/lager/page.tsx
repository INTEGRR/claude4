import Link from 'next/link'
import { sql } from '@/db/client'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { date } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

const KINDS = [
  { key: undefined, label: 'Alle' },
  { key: 'receipt', label: 'Wareneingänge' },
  { key: 'delivery', label: 'Warenausgänge' },
  { key: 'internal', label: 'Interne Transfers' },
]

export default async function LagerPage({
  searchParams,
}: {
  searchParams: Promise<{ art?: string; offen?: string }>
}) {
  const { art, offen } = await searchParams
  const onlyOpen = offen !== '0'

  const rows = await sql<
    {
      id: string
      number: string
      kind: string
      type_name: string
      state: string
      partner: string | null
      origin_label: string | null
      scheduled_date: string
      lines: number
    }[]
  >`
    select p.id, p.number, ot.kind, ot.name as type_name, p.state,
           part.name as partner, p.origin_label, p.scheduled_date,
           (select count(*) from stock_moves m where m.picking_id = p.id)::int as lines
    from stock_pickings p
    join operation_types ot on ot.id = p.operation_type_id
    left join partners part on part.id = p.partner_id
    where (${art ?? null}::text is null or ot.kind = ${art ?? null}::picking_kind)
      and (${onlyOpen} = false or p.state not in ('done', 'cancel'))
    order by p.scheduled_date desc, p.number desc
    limit 200`

  return (
    <>
      <PageHeader
        title="Transfers"
        subtitle="Wareneingänge, Warenausgänge und interne Umlagerungen"
        actions={
          <>
            <Link className="btn" href="/lager/bestand">Bestand</Link>
            <Link className="btn" href="/lager/inventur">Inventur</Link>
          </>
        }
      />

      <Card tight>
        <div style={{ padding: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {KINDS.map((k) => (
            <Link
              key={k.label}
              href={k.key ? `/lager?art=${k.key}${onlyOpen ? '' : '&offen=0'}` : `/lager${onlyOpen ? '' : '?offen=0'}`}
              className={`btn small${art === k.key ? ' primary' : ''}`}
            >
              {k.label}
            </Link>
          ))}
          <Link
            href={`/lager?${art ? `art=${art}&` : ''}offen=${onlyOpen ? '0' : '1'}`}
            className="btn small"
            style={{ marginLeft: 'auto' }}
          >
            {onlyOpen ? 'Auch erledigte zeigen' : 'Nur offene zeigen'}
          </Link>
        </div>

        {rows.length === 0 ? (
          <Empty>Keine Transfers.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nummer</th>
                  <th>Art</th>
                  <th>Partner</th>
                  <th>Quellbeleg</th>
                  <th className="num">Positionen</th>
                  <th>Status</th>
                  <th>Termin</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono"><Link href={`/lager/${r.id}`}>{r.number}</Link></td>
                    <td>{r.type_name}</td>
                    <td>{r.partner ?? <span className="muted">—</span>}</td>
                    <td className="mono small">{r.origin_label ?? '—'}</td>
                    <td className="num">{r.lines}</td>
                    <td><Badge state={r.state} kind="picking" /></td>
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
