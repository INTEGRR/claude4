import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { dateTime } from '@/modules/shared/format'
import { commitUrl, kurzerSha } from '@/modules/shared/repo'

export const dynamic = 'force-dynamic'

const SCHWERE_BADGE: Record<string, string> = {
  kritisch: 'danger',
  stoerend: 'warn',
  kosmetisch: 'neutral',
}

const STATUS_BADGE: Record<string, string> = {
  offen: 'warn',
  in_arbeit: 'info',
  behoben: 'success',
  verworfen: 'neutral',
}

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  await requireArea('fehler')
  const params = await searchParams
  const filter = params.status ?? 'alle'
  const status =
    filter === 'offen'
      ? ['offen', 'in_arbeit']
      : filter === 'erledigt'
        ? ['behoben', 'verworfen']
        : ['offen', 'in_arbeit', 'behoben', 'verworfen']

  const tickets = await sql<
    {
      id: string
      number: string
      titel: string
      seite: string | null
      schwere: string
      status: string
      gemeldet_von: string
      aufloesung: string | null
      commit_sha: string | null
      created_at: string
    }[]
  >`
    select id, number, titel, seite, schwere, status, gemeldet_von,
           aufloesung, commit_sha, created_at
    from bug_reports
    where status = any(${status}::bug_status[])
    order by created_at desc
    limit 200`

  return (
    <>
      <PageHeader
        title="Tickets"
        subtitle="Fehlermeldungen aus dem Betrieb — melden über den Reiter am rechten Rand, abgearbeitet auf Zuruf"
      />

      <Card title={`Tickets (${tickets.length})`} tight>
        <div className="row" style={{ padding: '10px 12px 0', gap: 6 }}>
          {[
            ['alle', 'Alle'],
            ['offen', 'Offen'],
            ['erledigt', 'Erledigt'],
          ].map(([wert, text]) => (
            <div className="shrink" key={wert}>
              <Link
                className={`btn small${filter === wert ? ' primary' : ''}`}
                href={wert === 'alle' ? '/tickets' : `/tickets?status=${wert}`}
              >
                {text}
              </Link>
            </div>
          ))}
        </div>
        {tickets.length === 0 ? (
          <Empty>Keine Tickets — melden geht auf jeder Seite über den Reiter „Fehler?" rechts.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Titel</th>
                  <th>Seite</th>
                  <th>Schwere</th>
                  <th>Status</th>
                  <th>Behebung</th>
                  <th>Gemeldet</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => (
                  <tr key={t.id}>
                    <td className="mono">
                      <Link href={`/tickets/${t.id}`}>{t.number}</Link>
                    </td>
                    <td>
                      <Link href={`/tickets/${t.id}`}>{t.titel}</Link>
                    </td>
                    <td className="mono small">{t.seite ?? '—'}</td>
                    <td>
                      <span className={`badge ${SCHWERE_BADGE[t.schwere] ?? ''}`}>{t.schwere}</span>
                    </td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[t.status] ?? ''}`}>
                        {t.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="small">
                      {t.commit_sha ? (
                        <a
                          className="mono"
                          href={commitUrl(t.commit_sha)}
                          target="_blank"
                          rel="noreferrer"
                          title={t.aufloesung ?? undefined}
                        >
                          {kurzerSha(t.commit_sha)}
                        </a>
                      ) : t.aufloesung ? (
                        <span title={t.aufloesung}>Vermerk</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="small nowrap">
                      {t.gemeldet_von} · <span className="mono">{dateTime(t.created_at)}</span>
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
