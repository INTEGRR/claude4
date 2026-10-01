import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { SPRACHEN } from '@/modules/einkauf/mail-vorlagen'
import { dateTime } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

const ANSICHTEN = [
  { key: 'offen', label: 'Offen', filter: ['entwurf', 'freigegeben'] },
  { key: 'gesendet', label: 'Gesendet', filter: ['gesendet'] },
  { key: 'verworfen', label: 'Verworfen', filter: ['verworfen'] },
  { key: 'alle', label: 'Alle', filter: ['entwurf', 'freigegeben', 'gesendet', 'verworfen'] },
] as const

/**
 * Mail-Entwürfe an Lieferanten (0094): was geschrieben, aber noch nicht
 * freigegeben ist — von Hand, aus Vorlagen, aus Bestellungen und ab Stufe 6
 * vom Agenten. Gesendet wird aus dem Entwurf heraus.
 */
export default async function EntwuerfePage({ searchParams }: { searchParams: Promise<{ ansicht?: string }> }) {
  await requireArea('einkauf')
  const { ansicht: roh } = await searchParams
  const ansicht = ANSICHTEN.find((a) => a.key === roh) ?? ANSICHTEN[0]

  const rows = await sql<
    {
      id: string
      betreff: string
      status: string
      sprache: string
      an: string[]
      quelle: string
      erstellt_von: string | null
      created_at: string
      gesendet_am: string | null
      lieferant: string | null
      partner_id: string | null
      purchase_order_id: string | null
      bestellung: string | null
      projekt_id: string | null
      projekt: string | null
      thread_id: string | null
      fehler: string | null
    }[]
  >`
    select e.id, e.betreff, e.status::text as status, e.sprache, e.an, e.quelle, e.erstellt_von,
           e.created_at::text as created_at, e.gesendet_am::text as gesendet_am, p.name as lieferant, e.partner_id,
           e.purchase_order_id, po.number as bestellung, e.einkaufsprojekt_id as projekt_id, ep.nummer as projekt,
           e.thread_id, e.fehler
    from mail_entwuerfe e
    left join partners p on p.id = e.partner_id
    left join purchase_orders po on po.id = e.purchase_order_id
    left join einkaufsprojekte ep on ep.id = e.einkaufsprojekt_id
    where e.status = any(${ansicht.filter as unknown as string[]}::mail_entwurf_status[])
    order by coalesce(e.gesendet_am, e.created_at) desc
    limit 200`

  return (
    <>
      <PageHeader
        title="Mail-Entwürfe"
        subtitle="Mails an Lieferanten — gegenlesen, übersetzen, freigeben"
        actions={
          <Link className="btn" href="/einkauf/posteingang">
            Posteingang
          </Link>
        }
      />
      <Card tight>
        <div className="actions" style={{ padding: 12 }}>
          {ANSICHTEN.map((a) => (
            <Link
              key={a.key}
              href={`/einkauf/entwuerfe?ansicht=${a.key}`}
              className="btn small"
              aria-current={a.key === ansicht.key ? 'page' : undefined}
            >
              <span className={a.key === ansicht.key ? 'led on' : 'led off'} />
              {a.label}
            </Link>
          ))}
        </div>
        {rows.length === 0 ? (
          <Empty>Keine Entwürfe. Neue Mails entstehen im Thread („Antworten"), in der Lieferantenakte oder an der Bestellung.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Betreff</th>
                  <th>Lieferant</th>
                  <th>An</th>
                  <th>Sprache</th>
                  <th>Zeit</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/einkauf/entwuerfe/${r.id}`}>{r.betreff || '(ohne Betreff)'}</Link>
                      <div className="muted small">
                        {r.quelle === 'agent' ? 'vom Agenten · ' : ''}
                        {r.erstellt_von ?? ''}
                        {r.purchase_order_id && (
                          <>
                            {' · '}
                            <Link className="mono" href={`/einkauf/${r.purchase_order_id}`}>{r.bestellung}</Link>
                          </>
                        )}
                        {r.projekt_id && (
                          <>
                            {' · '}
                            <Link className="mono" href={`/einkauf/projekte/${r.projekt_id}`}>{r.projekt}</Link>
                          </>
                        )}
                        {r.thread_id && (
                          <>
                            {' · '}
                            <Link href={`/einkauf/posteingang/${r.thread_id}`}>Antwort</Link>
                          </>
                        )}
                      </div>
                      {r.fehler && <div className="small wv-ueberfaellig">{r.fehler}</div>}
                    </td>
                    <td>{r.partner_id ? <Link href={`/einkauf/lieferanten/${r.partner_id}`}>{r.lieferant}</Link> : '—'}</td>
                    <td className="small mono">{r.an.join(', ') || '—'}</td>
                    <td className="small">{SPRACHEN[r.sprache as keyof typeof SPRACHEN] ?? r.sprache}</td>
                    <td className="small nowrap">{dateTime(r.gesendet_am ?? r.created_at)}</td>
                    <td>
                      {/* Gesendet → das Gespräch, sonst der Entwurf. */}
                      <Badge
                        state={r.status}
                        kind="mail_entwurf"
                        href={
                          r.status === 'gesendet' && r.thread_id
                            ? `/einkauf/posteingang/${r.thread_id}`
                            : `/einkauf/entwuerfe/${r.id}`
                        }
                      />
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
