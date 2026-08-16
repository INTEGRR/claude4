import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { sql } from '@/db/client'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { date, money } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

interface Row {
  id: string
  number: string
  state: string
  locked: boolean
  delivery_status: string
  source: string
  shopify_order_name: string | null
  partner_name: string
  order_date: string
  gross: number
  open_mos: number
}

export default async function VerkaufPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>
}) {
  await requireArea('verkauf')
  const { status, q } = await searchParams

  const rows = await sql<Row[]>`
    select so.id, so.number, so.state, so.locked, so.delivery_status,
           so.source, so.shopify_order_name, p.name as partner_name, so.order_date,
           (select gross from sales_order_total(so.id)) as gross,
           (select count(*) from manufacturing_orders mo
             where mo.sales_order_id = so.id and mo.state not in ('done','cancel'))::int as open_mos
    from sales_orders so
    join partners p on p.id = so.partner_id
    where (${status ?? null}::text is null or so.state = ${status ?? null}::sale_state)
      and (${q ?? null}::text is null
           or so.number ilike ${'%' + (q ?? '') + '%'}
           or coalesce(so.shopify_order_name, '') ilike ${'%' + (q ?? '') + '%'}
           or p.name ilike ${'%' + (q ?? '') + '%'})
    order by so.order_date desc, so.number desc
    limit 200`

  const filters = [
    { key: undefined, label: 'Alle' },
    { key: 'draft', label: 'Angebote' },
    { key: 'sale', label: 'Aufträge' },
    { key: 'cancel', label: 'Abgebrochen' },
  ]

  return (
    <>
      <PageHeader
        title="Verkaufsaufträge"
        subtitle="Aufträge aus Shopify und manuell erfasste Aufträge"
        actions={
          <Link className="btn primary" href="/verkauf/neu">
            Neuer Auftrag
          </Link>
        }
      />

      <Card tight>
        <div className="actions" style={{ padding: 12 }}>
          {filters.map((f) => (
            // Der aktive Ansichtsfilter wird wie die Navigation markiert (Rille + Akzentkante),
            // nicht als gefüllte Primärtaste — Orange bleibt der echten Primäraktion vorbehalten.
            <Link
              key={f.label}
              href={f.key ? `/verkauf?status=${f.key}` : '/verkauf'}
              className="btn small"
              aria-current={status === f.key ? 'page' : undefined}
              style={
                status === f.key
                  ? {
                      background: 'var(--surface-2)',
                      borderLeft: '2px solid var(--accent)',
                      fontWeight: 600,
                    }
                  : // gleiche Kantenbreite im Ruhezustand, damit nichts springt
                    { borderLeft: '2px solid transparent' }
              }
            >
              {f.label}
            </Link>
          ))}
          <form className="actions" style={{ marginLeft: 'auto', gap: 6 }}>
            <span className="mono-label">Suche</span>
            <input
              type="search"
              name="q"
              aria-label="Suche nach Nummer oder Kunde"
              placeholder="Nummer oder Kunde"
              defaultValue={q ?? ''}
              style={{ width: 240 }}
            />
          </form>
        </div>

        {rows.length === 0 ? (
          <Empty>Keine Aufträge gefunden.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nummer</th>
                  <th>Kunde</th>
                  <th>Datum</th>
                  <th>Status</th>
                  <th>Lieferung</th>
                  <th>Fertigung</th>
                  <th className="num">Summe</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">
                      <Link href={`/verkauf/${r.id}`}>{r.number}</Link>
                      {r.shopify_order_name && (
                        <span className="muted small"> · {r.shopify_order_name}</span>
                      )}
                      {/* Sperre ist ein Betriebszustand: Leuchte plus Wort, nicht nur ein graues Chip. */}
                      {r.locked && (
                        <span className="nowrap" style={{ marginLeft: 8 }}>
                          <span className="led warn" /> <span className="mono-label">Gesperrt</span>
                        </span>
                      )}
                    </td>
                    <td>{r.partner_name}</td>
                    <td className="mono nowrap">{date(r.order_date)}</td>
                    <td><Badge state={r.state} kind="sale" /></td>
                    <td><Badge state={r.delivery_status} kind="delivery" /></td>
                    <td>
                      {r.open_mos > 0 ? (
                        <span className="badge warn">{r.open_mos} offen</span>
                      ) : (
                        <span className="muted small">—</span>
                      )}
                    </td>
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
