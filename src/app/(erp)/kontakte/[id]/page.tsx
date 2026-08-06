import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { RecordComments } from '@/components/record-comments'
import { date } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

export default async function KontaktPage({ params }: { params: Promise<{ id: string }> }) {
  await requireArea('kontakte')
  const { id } = await params

  const [partner] = await sql<
    {
      id: string
      name: string
      is_company: boolean
      is_customer: boolean
      is_vendor: boolean
      email: string | null
      phone: string | null
      street: string | null
      house_number: string | null
      street2: string | null
      zip: string | null
      city: string | null
      country_code: string
      vat: string | null
    }[]
  >`select * from partners where id = ${id}`
  if (!partner) notFound()

  const orders = await sql<{ id: string; number: string; state: string; order_date: string }[]>`
    select id, number, state, order_date from sales_orders
    where partner_id = ${id} order by order_date desc limit 10`

  const purchases = await sql<{ id: string; number: string; state: string; order_date: string }[]>`
    select id, number, state, created_at as order_date from purchase_orders
    where vendor_id = ${id} order by created_at desc limit 10`

  return (
    <>
      <PageHeader
        title={partner.name}
        subtitle={
          <>
            {partner.is_customer && 'Kunde'}
            {partner.is_customer && partner.is_vendor && ' · '}
            {partner.is_vendor && 'Lieferant'}
            {partner.is_company ? ' · Firma' : ''}
          </>
        }
      />

      <div className="grid-2" style={{ marginBottom: 16 }}>
        <Card title="Anschrift">
          <div className="small">
            {partner.street} {partner.house_number}
            {partner.street2 && (
              <>
                <br />
                {partner.street2}
              </>
            )}
            <br />
            {partner.zip} {partner.city} {partner.country_code}
          </div>
        </Card>
        <Card title="Kontakt">
          <div className="small">
            {partner.email ?? <span className="muted">keine E-Mail</span>}
            <br />
            {partner.phone ?? <span className="muted">kein Telefon</span>}
            {partner.vat && (
              <>
                <br />
                USt-ID: {partner.vat}
              </>
            )}
          </div>
        </Card>
      </div>

      <div className="grid-2">
        <Card title={`Verkaufsaufträge (${orders.length})`} tight>
          {orders.length === 0 ? (
            <Empty>Keine Aufträge.</Empty>
          ) : (
            <TableWrap>
              <table>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id}>
                      <td className="mono"><Link href={`/verkauf/${o.id}`}>{o.number}</Link></td>
                      <td><Badge state={o.state} kind="sale" /></td>
                      <td className="nowrap small muted">{date(o.order_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title={`Bestellungen (${purchases.length})`} tight>
          {purchases.length === 0 ? (
            <Empty>Keine Bestellungen.</Empty>
          ) : (
            <TableWrap>
              <table>
                <tbody>
                  {purchases.map((p) => (
                    <tr key={p.id}>
                      <td className="mono"><Link href={`/einkauf/${p.id}`}>{p.number}</Link></td>
                      <td><Badge state={p.state} kind="purchase" /></td>
                      <td className="nowrap small muted">{date(p.order_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>

      <RecordComments model="partner" recordId={id} path={`/kontakte/${id}`} />
    </>
  )
}
