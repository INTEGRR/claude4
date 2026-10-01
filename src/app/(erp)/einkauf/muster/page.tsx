import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { rundeText, trackingLink } from '@/modules/einkauf/bemusterung'
import { date, money } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

const ANSICHTEN = [
  { key: 'offen', label: 'Offen', filter: ['offen'] },
  { key: 'freigegeben', label: 'Freigegeben', filter: ['freigegeben'] },
  { key: 'alle', label: 'Alle', filter: ['offen', 'freigegeben', 'abgelehnt', 'nachbessern'] },
] as const

/**
 * Muster (Bemusterung, 0107): alle Muster-Runden über die Projekte — was
 * unterwegs ist, was auf die Bewertung wartet, welche Golden Samples gelten.
 * Angefordert wird im Einkaufsprojekt.
 */
export default async function MusterPage({ searchParams }: { searchParams: Promise<{ ansicht?: string }> }) {
  await requireArea('einkauf')
  const { ansicht: roh } = await searchParams
  const ansicht = ANSICHTEN.find((a) => a.key === roh) ?? ANSICHTEN[0]

  const rows = await sql<
    {
      id: string
      runde: number
      revision: string | null
      bezeichnung: string | null
      status: string
      golden: boolean
      bestellt_am: string | null
      erhalten_am: string | null
      tracking: string | null
      kosten: number | null
      waehrung: string
      projekt_id: string
      projekt_nummer: string
      projekt_titel: string
      partner_id: string
      lieferant: string
    }[]
  >`
    select b.id, b.runde, b.revision, b.bezeichnung, b.status::text as status, b.golden,
           b.bestellt_am::text as bestellt_am, b.erhalten_am::text as erhalten_am, b.tracking,
           b.kosten::float as kosten, b.waehrung,
           ep.id as projekt_id, ep.nummer as projekt_nummer, ep.titel as projekt_titel,
           pa.id as partner_id, pa.name as lieferant
    from bemusterungen b
    join einkaufsprojekte ep on ep.id = b.projekt_id
    join partners pa on pa.id = b.partner_id
    where b.status = any(${ansicht.filter as unknown as string[]}::bemusterung_status[])
      and (${ansicht.key} <> 'freigegeben' or b.golden)
    order by (b.erhalten_am is not null) desc, b.created_at desc
    limit 300`

  return (
    <>
      <PageHeader title="Muster" subtitle="Bemusterung je Projekt und Lieferant — bis das Golden Sample freigegeben ist" />
      <Card tight>
        <div className="actions" style={{ padding: 12 }}>
          {ANSICHTEN.map((a) => (
            <Link
              key={a.key}
              href={`/einkauf/muster?ansicht=${a.key}`}
              className="btn small"
              aria-current={a.key === ansicht.key ? 'page' : undefined}
            >
              <span className={a.key === ansicht.key ? 'led on' : 'led off'} />
              {a.label}
            </Link>
          ))}
        </div>
        {rows.length === 0 ? (
          <Empty>Keine Muster in dieser Ansicht. Muster fordert man im Einkaufsprojekt an.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Muster</th>
                  <th>Projekt</th>
                  <th>Lieferant</th>
                  <th>Angefordert</th>
                  <th>Eingang</th>
                  <th className="num">Kosten</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const link = trackingLink(r.tracking)
                  return (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/einkauf/muster/${r.id}`}>{rundeText(r)}</Link>
                        {r.tracking && (
                          <div className="muted small mono">
                            {link ? (
                              <a href={link} target="_blank" rel="noreferrer">
                                Sendung verfolgen
                              </a>
                            ) : (
                              r.tracking
                            )}
                          </div>
                        )}
                      </td>
                      <td className="small">
                        <Link href={`/einkauf/projekte/${r.projekt_id}`}>
                          <span className="mono">{r.projekt_nummer}</span> {r.projekt_titel}
                        </Link>
                      </td>
                      <td className="small">
                        <Link href={`/einkauf/lieferanten/${r.partner_id}`}>{r.lieferant}</Link>
                      </td>
                      <td className="small nowrap">{date(r.bestellt_am)}</td>
                      <td className="small nowrap">{r.erhalten_am ? date(r.erhalten_am) : r.status === 'offen' ? 'unterwegs' : '—'}</td>
                      <td className="num small">{r.kosten !== null ? money(r.kosten, r.waehrung) : '—'}</td>
                      <td className="nowrap">
                        <Badge state={r.status} kind="bemusterung" href={`/einkauf/muster/${r.id}`} />
                        {r.golden && <span className="badge success" style={{ marginLeft: 4 }}>Golden Sample</span>}
                      </td>
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
