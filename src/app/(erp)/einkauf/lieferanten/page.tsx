import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'

export const dynamic = 'force-dynamic'

const SPRACHEN: Record<string, string> = { de: 'Deutsch', en: 'Englisch', zh: 'Chinesisch' }

/**
 * Lieferantenakten (Einkauf, 0092): alle Lieferanten mit Sprache,
 * zuständigem Einkäufer, offenen Bestellungen und Dateien — der Einstieg,
 * der quer über alle Projekte zeigt, was bei einem Lieferanten läuft.
 */
export default async function LieferantenPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireArea('einkauf')
  const { q = '' } = await searchParams
  const such = `%${q.trim()}%`
  const rows = await sql<
    {
      id: string
      name: string
      country_code: string | null
      sprache: string | null
      einkaeufer: string | null
      mail_domains: string[]
      offen: number
      dateien: number
      letzte: string | null
    }[]
  >`
    select p.id, p.name, p.country_code, p.sprache, u.name as einkaeufer, p.mail_domains,
           (select count(*)::int from purchase_orders po
             where po.vendor_id = p.id and po.state in ('draft', 'sent', 'purchase')) as offen,
           (select count(*)::int from dokumente d where d.partner_id = p.id) as dateien,
           (select max(po.created_at)::text from purchase_orders po where po.vendor_id = p.id) as letzte
    from partners p
    left join users u on u.id = p.einkaeufer_id
    where p.is_vendor and p.active and p.parent_id is null
      and (${q.trim() === ''} or p.name ilike ${such} or array_to_string(p.mail_domains, ' ') ilike ${such})
    order by (select count(*) from purchase_orders po where po.vendor_id = p.id and po.state in ('draft', 'sent', 'purchase')) desc,
             p.name
    limit 300`

  return (
    <>
      <PageHeader title="Lieferanten" subtitle="Lieferantenakten — Einkaufsdaten, Bestellungen, Dateien und Preise je Lieferant" />
      <Card tight>
        <form method="get" className="row" style={{ padding: '10px 12px 0', alignItems: 'flex-end' }}>
          <label className="field">
            <span>Suche (Name oder Maildomain)</span>
            <input name="q" defaultValue={q} placeholder="z. B. gateron oder example.cn" />
          </label>
          <div className="shrink field">
            <button className="small" type="submit">Suchen</button>
          </div>
        </form>
        {rows.length === 0 ? (
          <Empty>Keine Lieferanten gefunden.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Lieferant</th>
                  <th>Land</th>
                  <th>Sprache</th>
                  <th>Einkäufer</th>
                  <th className="num">Offene Bestellungen</th>
                  <th className="num">Dateien</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/einkauf/lieferanten/${r.id}`}>{r.name}</Link>
                      {r.mail_domains.length > 0 && (
                        <div className="muted small mono">{r.mail_domains.join(', ')}</div>
                      )}
                    </td>
                    <td className="mono">{r.country_code ?? '—'}</td>
                    <td>{r.sprache ? SPRACHEN[r.sprache] : '—'}</td>
                    <td>{r.einkaeufer ?? '—'}</td>
                    <td className="num">{r.offen}</td>
                    <td className="num">{r.dateien}</td>
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
