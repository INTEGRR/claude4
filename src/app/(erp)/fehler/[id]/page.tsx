import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { Card, PageHeader } from '@/components/ui'
import { RecordComments } from '@/components/record-comments'
import { dateTime } from '@/modules/shared/format'
import { statusSetzen } from '../actions'

export const dynamic = 'force-dynamic'

const STATUS_TEXT: Record<string, string> = {
  offen: 'offen',
  in_arbeit: 'in Arbeit',
  behoben: 'behoben',
  verworfen: 'verworfen',
}

export default async function FehlerDetail({ params }: { params: Promise<{ id: string }> }) {
  await requireArea('fehler')
  const { id } = await params

  const [m] = await sql<
    {
      id: string
      number: string
      titel: string
      beschreibung: string | null
      seite: string | null
      schwere: string
      status: string
      gemeldet_von: string
      aufloesung: string | null
      behoben_am: string | null
      created_at: string
    }[]
  >`select * from bug_reports where id = ${id}`
  if (!m) notFound()

  const offen = m.status === 'offen' || m.status === 'in_arbeit'

  return (
    <>
      <PageHeader
        title={`${m.number} — ${m.titel}`}
        subtitle={`${STATUS_TEXT[m.status] ?? m.status} · ${m.schwere} · gemeldet von ${m.gemeldet_von} am ${dateTime(m.created_at)}`}
        actions={<Link className="btn" href="/fehler">Zur Liste</Link>}
      />

      <Card title="Meldung">
        {m.seite && (
          <p style={{ marginTop: 0 }}>
            Seite: <Link className="mono" href={m.seite}>{m.seite}</Link>
          </p>
        )}
        <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
          {m.beschreibung ?? <span className="muted">Keine Beschreibung.</span>}
        </p>
      </Card>

      {m.aufloesung && (
        <Card title="Bearbeitungsstand der Entwicklung">
          <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{m.aufloesung}</p>
          {m.behoben_am && (
            <p className="muted small" style={{ margin: '8px 0 0' }}>
              Abgeschlossen am {dateTime(m.behoben_am)}
            </p>
          )}
        </Card>
      )}

      <Card title="Status">
        <ActionForm action={statusSetzen.bind(null, m.id, offen ? 'behoben' : 'offen')}>
          {offen ? (
            <label className="field">
              <span>Vermerk zum Abschluss (optional — was war es, was wurde geändert?)</span>
              <input name="aufloesung" maxLength={2000} />
            </label>
          ) : null}
          <div className="actions">
            <button className={offen ? 'primary' : undefined} type="submit">
              {offen ? 'Als behoben schließen' : 'Wieder öffnen'}
            </button>
          </div>
        </ActionForm>
        {offen && (
          <ActionForm action={statusSetzen.bind(null, m.id, 'verworfen')} style={{ marginTop: 8 }}>
            <button className="danger" type="submit">Verwerfen (kein Fehler / Duplikat)</button>
          </ActionForm>
        )}
      </Card>

      <RecordComments model="bug_report" recordId={m.id} path={`/fehler/${m.id}`} />
    </>
  )
}
