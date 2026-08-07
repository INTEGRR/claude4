import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { sql } from '@/db/client'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { date, money } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

export default async function BillsPage() {
  await requireArea('einkauf')
  const bills = await sql<
    {
      id: string
      number: string
      state: string
      vendor: string
      bill_date: string | null
      is_credit_note: boolean
      po_number: string | null
      gross: number
    }[]
  >`
    select b.id, b.number, b.state, p.name as vendor, b.bill_date, b.is_credit_note,
           po.number as po_number, t.gross
    from vendor_bills b
    join partners p on p.id = b.vendor_id
    left join purchase_orders po on po.id = b.purchase_order_id
    cross join lateral vendor_bill_total(b.id) t
    order by b.created_at desc limit 200`

  return (
    <>
      <PageHeader
        title="Lieferantenrechnungen"
        subtitle="Rechnungen entstehen aus der Bestellung"
        actions={<Link className="btn" href="/einkauf">Bestellungen</Link>}
      />

      <Card tight>
        {bills.length === 0 ? (
          <Empty>Noch keine Rechnungen.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nummer</th>
                  <th>Lieferant</th>
                  <th>Bestellung</th>
                  <th>Datum</th>
                  <th>Status</th>
                  <th className="num">Betrag</th>
                </tr>
              </thead>
              <tbody>
                {bills.map((b) => (
                  <tr key={b.id}>
                    <td className="mono">
                      <span className="actions" style={{ gap: 6 }}>
                        <Link href={`/einkauf/rechnungen/${b.id}`}>{b.number}</Link>
                        {b.is_credit_note && <span className="badge info">Gutschrift</span>}
                      </span>
                    </td>
                    <td>{b.vendor}</td>
                    <td className="mono small">{b.po_number ?? '—'}</td>
                    <td className="mono nowrap">{date(b.bill_date)}</td>
                    <td><Badge state={b.state} kind="bill" /></td>
                    <td className="num nowrap">
                      {b.is_credit_note ? `− ${money(b.gross)}` : money(b.gross)}
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
