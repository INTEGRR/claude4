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
  partner_id: string
  partner_name: string
  order_date: string
  gross: number
  open_mos: number
  lieferungen: number
  lieferungen_offen: number
  lieferung_id: string | null
}

/**
 * Wohin das Lieferstatus-Schild führt (Betreiber 2026-10-01: Status sind
 * Wege): genau eine offene Lieferung → direkt dorthin; keine offene, aber
 * genau eine überhaupt → zu ihr; sonst die Transfers des Auftrags.
 */
function lieferungHref(r: Row): string | undefined {
  if (r.lieferungen === 0) return undefined
  if (r.lieferung_id && (r.lieferungen_offen === 1 || r.lieferungen === 1)) {
    return `/lager/${r.lieferung_id}`
  }
  return `/lager?auftrag=${r.id}${r.lieferungen_offen > 0 ? '' : '&offen=0'}`
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
           so.source, so.shopify_order_name, so.partner_id, p.name as partner_name, so.order_date,
           (select gross from sales_order_total(so.id)) as gross,
           (select count(*) from manufacturing_orders mo
             where mo.sales_order_id = so.id and mo.state not in ('done','cancel'))::int as open_mos,
           coalesce(lf.anzahl, 0) as lieferungen,
           coalesce(lf.offen, 0) as lieferungen_offen,
           lf.ziel as lieferung_id
    from sales_orders so
    join partners p on p.id = so.partner_id
    -- Warenausgänge des Auftrags (Index origin_model/origin_id): Anzahl,
    -- davon offen, und das Sprungziel — die offene zuerst, sonst die jüngste.
    left join lateral (
      select count(*)::int as anzahl,
             (count(*) filter (where sp.state not in ('done', 'cancel')))::int as offen,
             (array_agg(sp.id order by (sp.state in ('done', 'cancel')), sp.scheduled_date desc))[1] as ziel
      from stock_pickings sp
      join operation_types ot on ot.id = sp.operation_type_id and ot.kind = 'delivery'
      where sp.origin_model = 'sales_order' and sp.origin_id = so.id
    ) lf on true
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
                    <td><Link href={`/kontakte/${r.partner_id}`}>{r.partner_name}</Link></td>
                    <td className="mono nowrap">{date(r.order_date)}</td>
                    <td><Badge state={r.state} kind="sale" href={`/verkauf/${r.id}`} /></td>
                    <td>
                      <Badge
                        state={r.delivery_status}
                        kind="delivery"
                        href={lieferungHref(r)}
                        title={
                          r.lieferungen > 1
                            ? `${r.lieferungen} Lieferungen, davon ${r.lieferungen_offen} offen`
                            : undefined
                        }
                      />
                    </td>
                    <td>
                      {r.open_mos > 0 ? (
                        <Link
                          className="badge warn"
                          href={`/fertigung?auftrag=${r.id}`}
                          title="Fertigungsaufträge dieses Auftrags"
                        >
                          {r.open_mos} offen
                        </Link>
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
