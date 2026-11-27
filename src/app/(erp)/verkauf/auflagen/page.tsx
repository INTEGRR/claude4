import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { dateTime, plural } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

/**
 * Nummerierte Auflagen (0144, Entscheidungslog 2026-11-27): welche Nummer
 * zu welcher Bestellung gehört — z. B. Founders Edition 1 bis 96. Vergeben
 * wird automatisch in Bestellreihenfolge; angelegt wird eine Auflage in der
 * Produktliste („Nummerierte Auflage" für angehakte Produkte).
 */
export default async function AuflagenPage({
  searchParams,
}: {
  searchParams: Promise<{ auflage?: string }>
}) {
  await requireArea('verkauf')
  const sp = await searchParams
  const auflagen = await sql<
    { id: string; name: string; von: number; bis: number; vergeben: number; ohne_nummer: number; produkte: string[] | null }[]
  >`
    select a.id, a.name, a.von, a.bis,
           (select count(*)::int from auflage_nummern n where n.auflage_id = a.id) as vergeben,
           auflage_ohne_nummer(a.id) as ohne_nummer,
           (select array_agg(pt.name order by pt.name) from product_templates pt where pt.auflage_id = a.id) as produkte
    from auflagen a order by a.name`
  const aktiv = auflagen.find((a) => a.id === sp.auflage) ?? auflagen[0] ?? null

  const zeilen = aktiv
    ? await sql<
        {
          nummer: number
          order_id: string | null
          bestellung: string | null
          order_date: string | null
          kunde: string | null
          partner_id: string | null
          artikel: string | null
          fertigung: string | null
        }[]
      >`
        select g.nummer, so.id as order_id, coalesce(so.shopify_order_name, so.number) as bestellung,
               so.order_date, p.name as kunde, so.partner_id, sol.name as artikel,
               (select string_agg(mo.number || case mo.state when 'done' then ' ✓' else '' end, ', ' order by mo.number)
                  from manufacturing_orders mo
                 where mo.sales_order_id = so.id and mo.variant_id = sol.variant_id and mo.state <> 'cancel') as fertigung
        from generate_series(${aktiv.von}::int, ${aktiv.bis}::int) as g(nummer)
        left join auflage_nummern n on n.auflage_id = ${aktiv.id} and n.nummer = g.nummer
        left join sales_order_lines sol on sol.id = n.sales_order_line_id
        left join sales_orders so on so.id = sol.order_id
        left join partners p on p.id = so.partner_id
        order by g.nummer`
    : []
  const gesamt = aktiv ? aktiv.bis - aktiv.von + 1 : 0

  return (
    <>
      <PageHeader
        title="Nummerierte Auflagen"
        subtitle="Jedes verkaufte Stück bekommt die nächste Nummer — in der Reihenfolge der Bestellungen"
      />
      {auflagen.length === 0 || !aktiv ? (
        <Card>
          <Empty>
            Noch keine Auflage. In der <Link href="/produkte">Produktliste</Link> die Produkte anhaken und unter
            „Nummerierte Auflage" Name und Nummernbereich setzen (z. B. Founders Edition, 1 bis 96).
          </Empty>
        </Card>
      ) : (
        <>
          {auflagen.length > 1 && (
            <div className="actions" style={{ marginBottom: 12 }}>
              {auflagen.map((a) => (
                <Link key={a.id} href={`/verkauf/auflagen?auflage=${a.id}`} className="btn small" aria-current={a.id === aktiv.id ? 'true' : undefined}>
                  {a.name}
                </Link>
              ))}
            </div>
          )}
          <Card title={`${aktiv.name} · ${aktiv.vergeben} von ${gesamt} vergeben`}>
            <p className="small muted" style={{ marginTop: 0 }}>
              Gilt für: {(aktiv.produkte ?? []).join(' · ') || 'kein Produkt'}. Eine Nummer wird frei, wenn die Bestellung
              storniert wird, und geht dann an das nächste Stück ohne Nummer.
            </p>
            {aktiv.ohne_nummer > 0 && (
              <p className="notice warn">
                {aktiv.vergeben >= gesamt
                  ? `Die Auflage ist voll — ${plural(aktiv.ohne_nummer, 'verkauftes Stück hat', 'verkaufte Stück haben')} keine Nummer.`
                  : `${plural(aktiv.ohne_nummer, 'Stück wartet', 'Stück warten')} auf die Nummer — sie kommt innerhalb von zwei Minuten nach der Bestellung.`}
              </p>
            )}
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th className="num" style={{ width: 70 }}>Nr.</th>
                    <th>Bestellung</th>
                    <th>Bestellt</th>
                    <th>Kunde</th>
                    <th>Artikel</th>
                    <th>Fertigung</th>
                  </tr>
                </thead>
                <tbody>
                  {zeilen.map((z) => (
                    <tr key={z.nummer} className={z.order_id ? undefined : 'muted'}>
                      <td className="num"><strong>{z.nummer}</strong></td>
                      {z.order_id ? (
                        <>
                          <td><Link className="mono" href={`/verkauf/${z.order_id}`}>{z.bestellung}</Link></td>
                          <td className="small">{z.order_date ? dateTime(z.order_date) : ''}</td>
                          <td>{z.partner_id ? <Link href={`/kontakte/${z.partner_id}`}>{z.kunde}</Link> : '—'}</td>
                          <td className="small">{z.artikel}</td>
                          <td className="mono small">{z.fertigung ?? '—'}</td>
                        </>
                      ) : (
                        <td colSpan={5} className="small">frei</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
        </>
      )}
    </>
  )
}
