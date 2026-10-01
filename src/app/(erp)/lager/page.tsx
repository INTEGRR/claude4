import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { sql } from '@/db/client'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { date } from '@/modules/shared/format'
import { UUID, herkunftHref } from './herkunft'

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
  searchParams: Promise<{ art?: string; offen?: string; auftrag?: string }>
}) {
  await requireArea('lager')
  const { art, offen, auftrag: auftragRoh } = await searchParams
  const onlyOpen = offen !== '0'
  // Filter „Transfers zum Auftrag" (Querverweis aus dem Verkauf, z. B. vom
  // Lieferstatus-Schild): nur gültige UUIDs — Unsinn in der Adresszeile
  // wäre sonst ein 500 statt einer leeren Liste.
  const auftrag = auftragRoh && UUID.test(auftragRoh) ? auftragRoh : undefined

  const [auftragKopf] = auftrag
    ? await sql<{ id: string; number: string; shopify_order_name: string | null }[]>`
        select id, number, shopify_order_name from sales_orders where id = ${auftrag}`
    : []

  const rows = await sql<
    {
      id: string
      number: string
      kind: string
      type_name: string
      state: string
      partner: string | null
      partner_id: string | null
      origin_model: string | null
      origin_id: string | null
      origin_label: string | null
      scheduled_date: string
      lines: number
    }[]
  >`
    select p.id, p.number, ot.kind, ot.name as type_name, p.state,
           part.name as partner, p.partner_id, p.origin_model, p.origin_id, p.origin_label,
           p.scheduled_date,
           (select count(*) from stock_moves m where m.picking_id = p.id)::int as lines
    from stock_pickings p
    join operation_types ot on ot.id = p.operation_type_id
    left join partners part on part.id = p.partner_id
    where (${art ?? null}::text is null or ot.kind = ${art ?? null}::picking_kind)
      and (${onlyOpen} = false or p.state not in ('done', 'cancel'))
      and (${auftrag ?? null}::uuid is null
           or (p.origin_model = 'sales_order' and p.origin_id = ${auftrag ?? null}::uuid))
    order by p.scheduled_date desc, p.number desc
    limit 200`

  // Adresse mit den übrigen Filtern — Art, Zustand und Auftrag bleiben beim
  // Umschalten erhalten.
  const href = (f: { art?: string; offen: boolean; auftrag?: string }) => {
    const q = new URLSearchParams()
    if (f.art) q.set('art', f.art)
    if (!f.offen) q.set('offen', '0')
    if (f.auftrag) q.set('auftrag', f.auftrag)
    const s = q.toString()
    return s ? `/lager?${s}` : '/lager'
  }

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

      {auftrag && (
        <div className="notice info">
          <span className="led" style={{ background: 'var(--info)' }} /> Gefiltert auf Auftrag{' '}
          {auftragKopf ? (
            <Link className="mono" href={`/verkauf/${auftragKopf.id}`}>
              {auftragKopf.number}
              {auftragKopf.shopify_order_name ? ` · ${auftragKopf.shopify_order_name}` : ''}
            </Link>
          ) : (
            <span className="muted">(nicht gefunden)</span>
          )}
          {' '}·{' '}
          <Link href={href({ art, offen: onlyOpen })}>Filter aufheben</Link>
        </div>
      )}

      <Card tight>
        <div className="actions" style={{ padding: 12 }}>
          {KINDS.map((k) => {
            const aktiv = art === k.key
            return (
              <Link
                key={k.label}
                href={href({ art: k.key, offen: onlyOpen, auftrag })}
                className="btn small"
                aria-current={aktiv ? 'page' : undefined}
              >
                <span className={aktiv ? 'led on' : 'led off'} />
                {k.label}
              </Link>
            )
          })}
          <span className="mono-label" style={{ marginLeft: 'auto' }}>
            <span className={onlyOpen ? 'led on' : 'led off'} /> {onlyOpen ? 'nur offene' : 'alle Zustände'}
          </span>
          <Link href={href({ art, offen: !onlyOpen, auftrag })} className="btn small">
            {onlyOpen ? 'Auch erledigte zeigen' : 'Nur offene zeigen'}
          </Link>
        </div>

        {rows.length === 0 ? (
          <Empty>
            {auftrag && onlyOpen
              ? 'Keine offenen Transfers zu diesem Auftrag — „Auch erledigte zeigen" blendet die erledigten ein.'
              : 'Keine Transfers.'}
          </Empty>
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
                {rows.map((r) => {
                  const quelle = herkunftHref(r.origin_model, r.origin_id)
                  return (
                    <tr key={r.id}>
                      <td className="mono"><Link href={`/lager/${r.id}`}>{r.number}</Link></td>
                      <td>{r.type_name}</td>
                      <td>
                        {r.partner && r.partner_id ? (
                          <Link href={`/kontakte/${r.partner_id}`}>{r.partner}</Link>
                        ) : (
                          (r.partner ?? <span className="muted">—</span>)
                        )}
                      </td>
                      <td className="mono small">
                        {r.origin_label && quelle ? (
                          <Link href={quelle}>{r.origin_label}</Link>
                        ) : (
                          (r.origin_label ?? '—')
                        )}
                      </td>
                      <td className="num">{r.lines}</td>
                      <td><Badge state={r.state} kind="picking" href={`/lager/${r.id}`} /></td>
                      <td className="nowrap mono small">{date(r.scheduled_date)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  )
}
