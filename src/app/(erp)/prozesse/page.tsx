import Link from 'next/link'
import { requireArea } from '@/modules/auth'
import { sql } from '@/db/client'
import { ActionButton } from '@/components/action-button'
import { Card, PageHeader, TableWrap } from '@/components/ui'
import { repository } from '@/modules/prozesse/introspektion'
import { FIXTURES } from '@/modules/prozesse/fixtures'
import { paketAktivieren } from './actions'

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
  const user = await requireArea('einstellungen')
  const admin = user.role === 'admin'
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
            aktiv: boolean
            version: number | null
            schritte: number
            abgeschaltet: number
            entwuerfe: number
          }[]
        >`
          select p.code, p.name, p.bereich, p.modell, p.aktiv, v.version,
                 (select count(*)::int from prozess_schritte s
                   where s.version_id = v.id and s.art not in ('start', 'ende')) as schritte,
                 (select count(*)::int from prozess_overrides o
                   join prozess_schritte s on s.version_id = v.id and s.code = o.schritt_code
                   where o.prozess_code = p.code and o.aktiv = false and s.optional) as abgeschaltet,
                 (select count(*)::int from prozess_versionen pv
                   where pv.prozess_id = p.id and pv.status = 'entwurf') as entwuerfe
          from prozesse p
          left join prozess_versionen v on v.id = prozess_aktive_version(p.code)
          order by p.bereich, p.code`
      : []

  const pakete =
    aktiv === 'ablaeufe'
      ? await sql<
          { code: string; name: string; beschreibung: string | null; prozess_codes: string[] }[]
        >`select code, name, beschreibung, prozess_codes from prozess_pakete order by code`
      : []
  const prozessAktiv = new Map(prozesse.map((p) => [p.code, p.aktiv]))
  const paketPasst = (codes: string[]) =>
    prozesse.every((p) => p.aktiv === (codes.includes(p.code) || p.code === 'bug_ticket'))

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
        <>
          <Card title={`Prozesse (${prozesse.filter((p) => p.aktiv).length} aktiv)`} tight>
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
                    <tr key={p.code} style={p.aktiv ? undefined : { opacity: 0.55 }}>
                      <td>
                        <Link href={`/prozesse/${p.code}`}>{p.name}</Link>{' '}
                        <span className="mono small muted">{p.code}</span>
                      </td>
                      <td>
                        <span className="mono-label">{p.bereich}</span>
                      </td>
                      <td className="mono small">
                        {p.modell ?? (p.aktiv ? <Link href={`/p/${p.code}`}>Assistent</Link> : 'Assistent')}
                      </td>
                      <td className="num mono">
                        {p.version === null ? '—' : Number(p.version)}
                        {Number(p.entwuerfe) > 0 && (
                          <span className="badge warn" style={{ marginLeft: 6 }}>
                            {p.entwuerfe} Entwurf/Entwürfe
                          </span>
                        )}
                      </td>
                      <td className="num">{p.schritte}</td>
                      <td>
                        {Object.values(FIXTURES).some((f) => f.prozess === p.code) ? (
                          <span className="badge success">abgedeckt</span>
                        ) : (
                          <span className="badge warn">ohne Fixture</span>
                        )}
                      </td>
                      <td className="small">
                        {!p.aktiv ? (
                          <span className="badge neutral">abgeschaltet</span>
                        ) : Number(p.abgeschaltet) > 0 ? (
                          `${p.abgeschaltet} Schritt(e) abgeschaltet`
                        ) : (
                          'Standard'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>

          {/* Chamäleon: Pivot = Paketwechsel. Ein Paket schaltet genau seine
              Prozesse aktiv — Navigation und Assistenten folgen automatisch,
              Belege und Historie abgeschalteter Prozesse bleiben lesbar. */}
          <div className="grid-3">
            {pakete.map((paket) => (
              <Card
                key={paket.code}
                title={paket.name}
                actions={
                  paketPasst(paket.prozess_codes) && <span className="badge success">aktiv</span>
                }
              >
                {paket.beschreibung && (
                  <p className="muted small" style={{ marginTop: 0 }}>{paket.beschreibung}</p>
                )}
                <ul className="small" style={{ margin: '0 0 10px', paddingLeft: 0, listStyle: 'none' }}>
                  {paket.prozess_codes.map((code) => (
                    <li key={code} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className={`led ${prozessAktiv.get(code) ? 'ok' : 'off'}`} />
                      <span className="mono">{code}</span>
                    </li>
                  ))}
                </ul>
                {admin && !paketPasst(paket.prozess_codes) && (
                  <ActionButton
                    action={paketAktivieren.bind(null, paket.code)}
                    confirm={`Paket „${paket.name}" aktivieren? Genau diese Prozesse werden aktiv, alle anderen abgeschaltet (der Bug-Loop bleibt an). Belege und Historie bleiben lesbar.`}
                  >
                    Paket aktivieren
                  </ActionButton>
                )}
              </Card>
            ))}
          </div>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            Ein Pivot ist ein Paketwechsel, kein Code-Umbau: Navigation und Assistenten sind eine
            Projektion der aktiven Prozesse. Einzelne Prozesse lassen sich auf ihrer Detailseite
            an- und abschalten.
          </p>
        </>
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
