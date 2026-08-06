import Link from 'next/link'
import { sql } from '@/db/client'
import { requireUser } from '@/modules/auth'
import { type Area, canAccess } from '@/modules/auth/permissions'
import { Badge, Card, Empty, PageHeader, Stat, TableWrap } from '@/components/ui'
import { date, money, qty } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ verweigert?: string }>
}) {
  const user = await requireUser()
  const { verweigert } = await searchParams
  const sees = (area: Area) => canAccess(user.role, area)

  const [stats] = await sql<
    {
      open_orders: number
      open_mos: number
      ready_to_ship: number
      open_receipts: number
      open_repairs: number
      shortages: number
      failed: number
      revenue_month: number
    }[]
  >`
    select
      (select count(*) from sales_orders
        where state = 'sale' and delivery_status <> 'full')::int as open_orders,
      (select count(*) from manufacturing_orders
        where state not in ('done','cancel'))::int as open_mos,
      (select count(*) from shipping_ready)::int as ready_to_ship,
      (select count(*) from stock_pickings p
         join operation_types ot on ot.id = p.operation_type_id
        where ot.kind = 'receipt' and p.state not in ('done','cancel'))::int as open_receipts,
      (select count(*) from repair_orders
        where state not in ('repaired','cancel'))::int as open_repairs,
      (select count(*) from product_variants pv
         join product_templates pt on pt.id = pv.template_id
        where pv.active and pt.type = 'goods' and forecasted_qty(pv.id) < 0)::int as shortages,
      ((select count(*) from integration_jobs where status = 'failed')
       + (select count(*) from shopify_unmatched_lines where resolved_at is null))::int as failed,
      coalesce((select sum((select net from sales_order_total(so.id)))
                from sales_orders so
                where so.state = 'sale' and so.order_date >= date_trunc('month', now())), 0)
        as revenue_month`

  const recentOrders = await sql<
    {
      id: string
      number: string
      shopify_order_name: string | null
      customer: string
      state: string
      delivery_status: string
      order_date: string
      open_mos: number
    }[]
  >`
    select so.id, so.number, so.shopify_order_name, p.name as customer, so.state,
           so.delivery_status, so.order_date,
           (select count(*) from manufacturing_orders mo
             where mo.sales_order_id = so.id and mo.state not in ('done','cancel'))::int as open_mos
    from sales_orders so join partners p on p.id = so.partner_id
    where so.state = 'sale'
    order by so.order_date desc limit 8`

  const shortages = await sql<{ id: string; product: string; forecasted: number; on_hand: number }[]>`
    select pv.id, coalesce(pv.display_name, pt.name) as product,
           forecasted_qty(pv.id) as forecasted, on_hand_qty(pv.id) as on_hand
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.active and pt.active and pt.type = 'goods' and forecasted_qty(pv.id) < 0
    order by forecasted_qty(pv.id) limit 8`

  return (
    <>
      <PageHeader title="Übersicht" subtitle="Was heute ansteht" />

      {verweigert && (
        <div className="notice danger">
          Für den Bereich „{verweigert}" fehlt Ihrer Rolle die Berechtigung.
        </div>
      )}

      {sees('integrationen') && stats.failed > 0 && (
        <div className="notice danger">
          {stats.failed} Vorgang/Vorgänge brauchen Aufmerksamkeit (fehlgeschlagene Jobs oder nicht
          zugeordnete Shopify-Positionen). <Link href="/integrationen">Zu den Integrationen</Link>
        </div>
      )}

      <div className="grid-3" style={{ marginBottom: 16 }}>
        {sees('verkauf') && (
          <Stat label="Offene Aufträge" value={stats.open_orders} href="/verkauf?status=sale" />
        )}
        {sees('fertigung') && <Stat label="Offene Fertigung" value={stats.open_mos} href="/fertigung" />}
        {sees('versand') && (
          <Stat
            label="Versandbereit"
            value={stats.ready_to_ship}
            hint="fertig, wartet aufs Label"
            href="/versand"
          />
        )}
        {sees('lager') && (
          <Stat label="Erwartete Eingänge" value={stats.open_receipts} href="/lager?art=receipt" />
        )}
        {sees('reparatur') && (
          <Stat label="Offene Reparaturen" value={stats.open_repairs} href="/reparatur" />
        )}
        {sees('scanner') && <Stat label="Scanner" value="→" hint="Belege per Barcode abarbeiten" href="/scanner" />}
        {sees('verkauf') && (
          <Stat
            label="Umsatz laufender Monat"
            value={money(stats.revenue_month)}
            hint="netto, bestätigte Aufträge"
          />
        )}
      </div>

      <div className="grid-2">
        {sees('verkauf') && (
        <Card
          title="Aktuelle Aufträge"
          actions={<Link className="btn small" href="/verkauf">Alle</Link>}
          tight
        >
          {recentOrders.length === 0 ? (
            <Empty>Noch keine bestätigten Aufträge.</Empty>
          ) : (
            <TableWrap>
              <table>
                <tbody>
                  {recentOrders.map((o) => (
                    <tr key={o.id}>
                      <td className="mono">
                        <Link href={`/verkauf/${o.id}`}>{o.shopify_order_name ?? o.number}</Link>
                      </td>
                      <td>{o.customer}</td>
                      <td><Badge state={o.delivery_status} kind="delivery" /></td>
                      <td>
                        {o.open_mos > 0 && <span className="badge warn">{o.open_mos} in Fertigung</span>}
                      </td>
                      <td className="nowrap small muted">{date(o.order_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
        )}

        {sees('produkte') && (
        <Card
          title="Unterdeckung"
          actions={<Link className="btn small" href="/lager/bestand?filter=unterdeckung">Alle</Link>}
          tight
        >
          {shortages.length === 0 ? (
            <Empty>Alle Bestände reichen aus.</Empty>
          ) : (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Produkt</th>
                    <th className="num">Bestand</th>
                    <th className="num">Prognose</th>
                  </tr>
                </thead>
                <tbody>
                  {shortages.map((s) => (
                    <tr key={s.id}>
                      <td><Link href={`/produkte/variante/${s.id}`}>{s.product}</Link></td>
                      <td className="num">{qty(s.on_hand)}</td>
                      <td className="num"><span className="badge danger">{qty(s.forecasted)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
        )}
      </div>
    </>
  )
}
