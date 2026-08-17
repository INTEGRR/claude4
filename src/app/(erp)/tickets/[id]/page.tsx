import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { Card, PageHeader } from '@/components/ui'
import { RecordComments } from '@/components/record-comments'
import { ProzessPanel } from '@/components/prozess-panel'
import { dateTime } from '@/modules/shared/format'
import { commitUrl, kurzerSha } from '@/modules/shared/repo'
import { statusSetzen } from '../actions'

export const dynamic = 'force-dynamic'

const STATUS_TEXT: Record<string, string> = {
  offen: 'offen',
  in_arbeit: 'in Arbeit',
  behoben: 'behoben',
  verworfen: 'verworfen',
}

export default async function TicketDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireArea('fehler')
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
      commit_sha: string | null
      behoben_am: string | null
      created_at: string
      prozess_code: string | null
      schritt_code: string | null
      test_ok: boolean | null
      test_befund: string | null
      test_commit_sha: string | null
      test_gelaufen_am: string | null
    }[]
  >`select * from bug_reports where id = ${id}`
  if (!m) notFound()

  const [betroffen] = m.prozess_code
    ? await sql<{ name: string; modell: string | null }[]>`
        select name, modell from prozesse where code = ${m.prozess_code}`
    : []

  const offen = m.status === 'offen' || m.status === 'in_arbeit'

  return (
    <>
      <PageHeader
        title={`${m.number} — ${m.titel}`}
        subtitle={`${STATUS_TEXT[m.status] ?? m.status} · ${m.schwere} · gemeldet von ${m.gemeldet_von} am ${dateTime(m.created_at)}`}
        actions={<Link className="btn" href="/tickets">Zur Liste</Link>}
      />

      <ProzessPanel prozessCode="bug_ticket" recordId={m.id} rolle={user.role} befugnisse={user.befugnisse} />

      {/* Bug-Loop: welcher Prozess ist betroffen, und was sagt der Test? */}
      {betroffen && m.prozess_code && (
        <Card title="Betroffener Prozess">
          <p style={{ marginTop: 0 }}>
            <span className="mono">{m.prozess_code}</span> — {betroffen.name}
            {m.schritt_code && (
              <>
                {' '}· Schritt <span className="mono">{m.schritt_code}</span>
              </>
            )}
            {betroffen.modell === null && (
              <>
                {' '}· <Link href={`/p/${m.prozess_code}`}>Assistent öffnen</Link>
              </>
            )}
          </p>
          <p style={{ margin: 0 }}>
            <span className="mono-label" style={{ marginRight: 8 }}>Prozesstest</span>
            {m.test_ok === null ? (
              <span className="badge neutral">nie gelaufen</span>
            ) : m.test_ok ? (
              <>
                <span className="badge success">grün</span>{' '}
                {m.test_commit_sha && (
                  <a className="mono" href={commitUrl(m.test_commit_sha)} target="_blank" rel="noreferrer">
                    {kurzerSha(m.test_commit_sha)}
                  </a>
                )}{' '}
                {m.test_gelaufen_am && (
                  <span className="muted small">am {dateTime(m.test_gelaufen_am)}</span>
                )}
              </>
            ) : (
              <>
                <span className="badge danger">rot</span>{' '}
                {m.test_gelaufen_am && (
                  <span className="muted small">am {dateTime(m.test_gelaufen_am)}</span>
                )}
              </>
            )}
          </p>
          {m.test_befund && (
            <p className="muted small" style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>
              {m.test_befund}
            </p>
          )}
        </Card>
      )}

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

      {(m.aufloesung || m.commit_sha) && (
        <Card title="Behebung">
          {m.aufloesung && <p style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>{m.aufloesung}</p>}
          {m.commit_sha && (
            <p style={{ margin: 0 }}>
              Commit:{' '}
              <a className="mono" href={commitUrl(m.commit_sha)} target="_blank" rel="noreferrer">
                {kurzerSha(m.commit_sha)}
              </a>
            </p>
          )}
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
            <div className="row">
              <label className="field" style={{ flex: 2 }}>
                <span>Vermerk zum Abschluss (was war es, was wurde geändert?)</span>
                <input name="aufloesung" maxLength={2000} />
              </label>
              <label className="field shrink">
                <span>Commit (SHA)</span>
                <input className="mono" name="commit_sha" maxLength={64} style={{ width: 130 }} />
              </label>
            </div>
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

      <RecordComments model="bug_report" recordId={m.id} path={`/tickets/${m.id}`} />
    </>
  )
}
