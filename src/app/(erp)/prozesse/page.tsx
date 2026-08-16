import Link from 'next/link'
import { requireArea } from '@/modules/auth'
import { sql } from '@/db/client'
import { Card, PageHeader, TableWrap } from '@/components/ui'
import { repository } from '@/modules/prozesse/introspektion'
import { FIXTURES } from '@/modules/prozesse/fixtures'

export const dynamic = 'force-dynamic'

/**
 * Das Repository der Knöpfe UND der Abläufe: jede registrierte Aktion mit
 * Bereich, Feldern, Statusübergang und API-Adresse — und jede
 * Prozessdefinition mit Version, Testabdeckung und Laufzeit-Schaltern
 * (Detailseite je Prozess).
 */
export default async function ProzesseRepositoryPage({
  searchParams,
}: {
  searchParams: Promise<{ reiter?: string }>
}) {
  await requireArea('einstellungen')
  const { reiter } = await searchParams
  const aktiv =
    reiter === 'dienste' ? 'dienste' : reiter === 'ablaeufe' ? 'ablaeufe' : 'aktionen'
  const repo = repository()

  const prozesse =
    aktiv === 'ablaeufe'
      ? await sql<
          {
            code: string
            name: string
            bereich: string
            modell: string | null
            version: number
            schritte: number
            abgeschaltet: number
          }[]
        >`
          select p.code, p.name, p.bereich, p.modell, v.version,
                 (select count(*)::int from prozess_schritte s
                   where s.version_id = v.id and s.art not in ('start', 'ende')) as schritte,
                 (select count(*)::int from prozess_overrides o
                   join prozess_schritte s on s.version_id = v.id and s.code = o.schritt_code
                   where o.prozess_code = p.code and o.aktiv = false and s.optional) as abgeschaltet
          from prozesse p
          join prozess_versionen v on v.id = prozess_aktive_version(p.code)
          where p.aktiv
          order by p.bereich, p.code`
      : []

  return (
    <>
      <PageHeader
        title="Prozesse"
        subtitle="Abläufe und das Repository der Aktionen: jeder Knopf ist ein registrierter, API-aufrufbarer Aufruf"
        actions={
          <>
            <Link
              className={`btn${aktiv === 'ablaeufe' ? ' primary' : ''}`}
              href="/prozesse?reiter=ablaeufe"
            >
              Abläufe
            </Link>
            <Link className={`btn${aktiv === 'aktionen' ? ' primary' : ''}`} href="/prozesse">
              Aktionen ({repo.aktionen.length})
            </Link>
            <Link
              className={`btn${aktiv === 'dienste' ? ' primary' : ''}`}
              href="/prozesse?reiter=dienste"
            >
              Dienste &amp; Ereignisse ({repo.jobs.length + repo.ereignisse.length})
            </Link>
          </>
        }
      />

      {aktiv === 'ablaeufe' ? (
        <Card title={`Aktive Prozesse (${prozesse.length})`} tight>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Prozess</th>
                  <th>Bereich</th>
                  <th>Beleg</th>
                  <th className="num">Version</th>
                  <th className="num">Schritte</th>
                  <th>Prozesstest</th>
                  <th>Laufzeit</th>
                </tr>
              </thead>
              <tbody>
                {prozesse.map((p) => (
                  <tr key={p.code}>
                    <td>
                      <Link href={`/prozesse/${p.code}`}>{p.name}</Link>{' '}
                      <span className="mono small muted">{p.code}</span>
                    </td>
                    <td>
                      <span className="mono-label">{p.bereich}</span>
                    </td>
                    <td className="mono small">
                      {p.modell ?? <Link href={`/p/${p.code}`}>Assistent</Link>}
                    </td>
                    <td className="num mono">{Number(p.version)}</td>
                    <td className="num">{p.schritte}</td>
                    <td>
                      {Object.values(FIXTURES).some((f) => f.prozess === p.code) ? (
                        <span className="badge success">abgedeckt</span>
                      ) : (
                        <span className="badge warn">ohne Fixture</span>
                      )}
                    </td>
                    <td className="small">
                      {Number(p.abgeschaltet) > 0
                        ? `${p.abgeschaltet} Schritt(e) abgeschaltet`
                        : 'Standard'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      ) : aktiv === 'aktionen' ? (
        <>
          <div className="notice info">
            Jede Aktion ist über <code className="mono">POST /api/aktion/&lt;name&gt;</code> aufrufbar
            (Antwort wie in der Oberfläche: Erfolg mit Link oder verständlicher Fehler) — Knöpfe,
            Prozesstests und künftige generierte Masken sind nur verschiedene Wege zum selben
            Torwächter. Noch nicht registrierte Bereiche folgen Modul für Modul.
          </div>
          <Card title={`Registrierte Aktionen (${repo.aktionen.length})`} tight>
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Knopf</th>
                    <th>Bereich</th>
                    <th>Beleg</th>
                    <th>Statusübergang</th>
                    <th>Felder</th>
                    <th>Kennzeichen</th>
                  </tr>
                </thead>
                <tbody>
                  {repo.aktionen.map((a) => (
                    <tr key={a.name}>
                      <td className="mono small nowrap">{a.name}</td>
                      <td>{a.label}</td>
                      <td>
                        <span className="mono-label">{a.bereich}</span>
                      </td>
                      <td className="mono small">
                        {a.bindung === 'beleg' ? (a.modell ?? 'beleg') : '—'}
                      </td>
                      <td className="mono small nowrap">
                        {a.uebergang
                          ? `${a.uebergang.von.join('|') || '·'} → ${a.uebergang.nach.join('|')}`
                          : '—'}
                      </td>
                      <td className="small">
                        {a.felder.length === 0
                          ? '—'
                          : a.felder
                              .map((f) => (f.pflicht ? f.name : `${f.name}?`))
                              .join(', ')}
                      </td>
                      <td>
                        <span className="actions" style={{ gap: 4 }}>
                          {a.nurAdmin && <span className="badge warn">nur Admin</span>}
                          {a.prozessfrei && <span className="badge neutral">prozessfrei</span>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
        </>
      ) : (
        <>
          <Card title={`Dienste — asynchrone Prozessschritte (${repo.jobs.length})`} tight>
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Fähigkeit</th>
                    <th>Job</th>
                    <th>Zweck</th>
                  </tr>
                </thead>
                <tbody>
                  {repo.jobs.map((j) => (
                    <tr key={j.kind}>
                      <td className="mono small nowrap">{j.faehigkeit}</td>
                      <td>
                        {j.label} <span className="mono small muted">{j.kind}</span>
                      </td>
                      <td className="small">{j.beschreibung}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>

          <Card title={`Ereignisse — Punkte, an denen Prozesse warten (${repo.ereignisse.length})`} tight>
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Topic</th>
                    <th>Ereignis</th>
                    <th>Quelle</th>
                  </tr>
                </thead>
                <tbody>
                  {repo.ereignisse.map((e) => (
                    <tr key={e.topic}>
                      <td className="mono small nowrap">{e.topic}</td>
                      <td>
                        {e.label} <div className="muted small">{e.beschreibung}</div>
                      </td>
                      <td className="mono small">{e.quelle}</td>
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
