import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { date, money } from '@/modules/shared/format'
import { createPurchaseOrder } from './actions'

export const dynamic = 'force-dynamic'

export default async function EinkaufPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>
}) {
  const { filter } = await searchParams

  const rows = await sql<
    {
      id: string
      number: string
      state: string
      vendor: string
      order_deadline: string | null
      expected_arrival: string | null
      billing_status: string
      gross: number
      late: boolean
    }[]
  >`
    select po.id, po.number, po.state, p.name as vendor, po.order_deadline, po.expected_arrival,
           po.billing_status, t.gross,
           (po.order_deadline is not null and po.order_deadline < now()
            and po.state in ('draft','sent')) as late
    from purchase_orders po
    join partners p on p.id = po.vendor_id
    cross join lateral purchase_order_total(po.id) t
    order by po.created_at desc
    limit 200`

  const filtered =
    filter === 'to_send'
      ? rows.filter((r) => r.state === 'draft')
      : filter === 'waiting'
        ? rows.filter((r) => r.state === 'sent')
        : filter === 'late'
          ? rows.filter((r) => r.late)
          : rows

  const vendors = await sql<{ id: string; name: string }[]>`
    select id, name from partners where is_vendor and active order by name limit 500`

  const filters = [
    { key: undefined, label: 'Alle' },
    { key: 'to_send', label: `Zu senden (${rows.filter((r) => r.state === 'draft').length})` },
    { key: 'waiting', label: `Wartend (${rows.filter((r) => r.state === 'sent').length})` },
    { key: 'late', label: `Verspätet (${rows.filter((r) => r.late).length})` },
  ]

  return (
    <>
      <PageHeader
        title="Bestellungen"
        subtitle="Angebotsanfragen und Bestellungen bei Lieferanten"
        actions={<Link className="btn" href="/einkauf/rechnungen">Rechnungen</Link>}
      />

      <Card title="Neue Bestellung">
        <ActionForm action={createPurchaseOrder}>
          <div className="row">
            <label className="field" style={{ flex: 3 }}>
              <span>Lieferant</span>
              <select name="vendor_id" required defaultValue="">
                <option value="" disabled>— auswählen —</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </label>
            <div className="shrink field">
              <button className="primary" type="submit">Anlegen</button>
            </div>
          </div>
        </ActionForm>
        {vendors.length === 0 && (
          <div className="notice warn" style={{ marginBottom: 0 }}>
            Noch keine Lieferanten. Lege einen unter <Link href="/kontakte">Kontakte</Link> an.
          </div>
        )}
      </Card>

      <Card tight>
        <div style={{ padding: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {filters.map((f) => (
            <Link
              key={f.label}
              href={f.key ? `/einkauf?filter=${f.key}` : '/einkauf'}
              className={`btn small${filter === f.key ? ' primary' : ''}`}
            >
              {f.label}
            </Link>
          ))}
        </div>

        {filtered.length === 0 ? (
          <Empty>Keine Bestellungen.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nummer</th>
                  <th>Lieferant</th>
                  <th>Status</th>
                  <th>Abrechnung</th>
                  <th>Erwartet</th>
                  <th className="num">Summe</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">
                      <Link href={`/einkauf/${r.id}`}>{r.number}</Link>
                      {r.late && <span className="badge danger" style={{ marginLeft: 6 }}>verspätet</span>}
                    </td>
                    <td>{r.vendor}</td>
                    <td><Badge state={r.state} kind="purchase" /></td>
                    <td><Badge state={r.billing_status} kind="billing" /></td>
                    <td className="nowrap">{date(r.expected_arrival)}</td>
                    <td className="num nowrap">{money(r.gross)}</td>
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
