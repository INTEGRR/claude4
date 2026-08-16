import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/modules/auth'
import { type Area, canAccess, canWrite } from '@/modules/auth/permissions'
import { sql } from '@/db/client'
import { ActionButton } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { dateTime } from '@/modules/shared/format'
import { instanzStarten } from '../actions'

export const dynamic = 'force-dynamic'

/**
 * Belegloser Assistent: Übersicht der Läufe eines Prozesses + Start.
 * Die Seite ist GENERISCH — sie kennt keinen einzigen Prozess beim Namen,
 * alles kommt aus der Prozessdefinition in der Datenbank.
 */
export default async function AssistentPage({
  params,
}: {
  params: Promise<{ prozess: string }>
}) {
  const user = await requireUser()
  const { prozess: code } = await params

  const [prozess] = await sql<
    { name: string; beschreibung: string | null; bereich: Area }[]
  >`
    select name, beschreibung, bereich from prozesse
    where code = ${code} and aktiv and modell is null`
  if (!prozess || !canAccess(user.role, prozess.bereich)) notFound()

  const STATUS_TEXT: Record<string, string> = {
    laufend: 'läuft',
    fertig: 'fertig',
    abgebrochen: 'abgebrochen',
  }

  const instanzen = await sql<
    {
      id: string
      number: string
      schritt_code: string
      status: string
      gestartet_von: string
      created_at: string
    }[]
  >`
    select i.id, i.number, i.schritt_code, i.status, i.gestartet_von, i.created_at
    from prozess_instanzen i
    join prozesse p on p.id = i.prozess_id
    where p.code = ${code}
    order by i.created_at desc
    limit 100`

  return (
    <>
      <PageHeader
        title={prozess.name}
        subtitle={prozess.beschreibung ?? 'Assistent'}
        actions={
          canWrite(user.role, prozess.bereich) ? (
            <ActionButton className="primary" action={instanzStarten.bind(null, code)}>
              Assistent starten
            </ActionButton>
          ) : undefined
        }
      />

      <Card title="Läufe" tight>
        {instanzen.length === 0 ? (
          <Empty>Noch kein Lauf — oben starten.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nummer</th>
                  <th>Status</th>
                  <th>Schritt</th>
                  <th>Gestartet von</th>
                  <th>Am</th>
                </tr>
              </thead>
              <tbody>
                {instanzen.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <Link className="mono" href={`/p/${code}/${i.id}`}>{i.number}</Link>
                    </td>
                    <td>
                      <span className={`badge ${i.status === 'laufend' ? 'info' : 'neutral'}`}>
                        {STATUS_TEXT[i.status] ?? i.status}
                      </span>
                    </td>
                    <td className="mono">{i.schritt_code}</td>
                    <td>{i.gestartet_von}</td>
                    <td className="mono">{dateTime(i.created_at)}</td>
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
