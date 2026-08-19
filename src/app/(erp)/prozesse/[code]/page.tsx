import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireArea } from '@/modules/auth'
import { ActionButton } from '@/components/action-button'
import { Card, PageHeader, TableWrap } from '@/components/ui'
import { ProzessFlow } from '@/components/prozess-flow'
import { versionDiagramm } from '@/modules/prozesse/version-diagramm'
import { FIXTURES } from '@/modules/prozesse/fixtures'
import { dateTime } from '@/modules/shared/format'
import { prozessSchalten, schrittSchalten, versionAktivieren } from '../actions'

export const dynamic = 'force-dynamic'

/**
 * Eine Prozessdefinition im Detail: Diagramm, Schritte, Übergänge — und die
 * Laufzeit-Schalter der Firma (Overrides): optionale Schritte lassen sich
 * hier abschalten, Nachfolger rücken in den Abläufen automatisch nach.
 */
export default async function ProzessDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>
  searchParams: Promise<{ version?: string }>
}) {
  const user = await requireArea('einstellungen')
  const { code } = await params
  const { version: versionParam } = await searchParams

  // Lesen + Layout geteilt mit der Werkstatt — siehe version-diagramm.ts
  // (dort auch die Auswahlregel gewählt > aktiv > neueste).
  const daten = await versionDiagramm(
    code,
    versionParam !== undefined ? Number(versionParam) : undefined,
  )
  if (!daten) notFound()
  const { prozess, versionen, gezeigt, schritte, diagramm } = daten
  const fixture = Object.values(FIXTURES).some((f) => f.prozess === code)
  const admin = user.role === 'admin'

  const ART_TEXT: Record<string, string> = {
    start: 'Start',
    aktion: 'Aktion',
    dienst: 'Dienst',
    ereignis: 'Ereignis',
    matching: 'Klärung',
    xor: 'Entscheidung',
    ende: 'Ende',
  }

  return (
    <>
      <PageHeader
        title={prozess.name}
        subtitle={
          <>
            <span className="mono">{prozess.code}</span> · Version {Number(gezeigt.version)}
            {gezeigt.status !== 'aktiv' && ` (${gezeigt.status})`} · Bereich {prozess.bereich} ·{' '}
            {prozess.modell ? (
              <>Beleg <span className="mono">{prozess.modell}</span></>
            ) : (
              <Link href={`/p/${prozess.code}`}>Assistent öffnen</Link>
            )}
          </>
        }
        actions={
          <>
            {gezeigt.status === 'entwurf' && <span className="badge warn">Entwurf</span>}
            {gezeigt.status === 'entwurf' && admin && (
              <ActionButton
                action={versionAktivieren.bind(null, code, Number(gezeigt.version))}
                confirm={`Version ${Number(gezeigt.version)} von „${prozess.name}" aktivieren? Der Entwurf wird validiert, die bisher aktive Version archiviert — ab dann führt diese Version die Abläufe.`}
              >
                Version aktivieren
              </ActionButton>
            )}
            {!prozess.aktiv && <span className="badge neutral">abgeschaltet</span>}
            {fixture ? (
              <span className="badge success" title="Der Prozesstest spielt diesen Ablauf durch">
                Prozesstest ✓
              </span>
            ) : (
              <span className="badge warn">ohne Fixture</span>
            )}
            {admin && prozess.code !== 'bug_ticket' && (
              <ActionButton
                action={prozessSchalten.bind(null, code, !prozess.aktiv)}
                confirm={
                  prozess.aktiv
                    ? `„${prozess.name}" abschalten? Der Prozess verschwindet aus Navigation und Assistenten — Belege und Historie bleiben lesbar.`
                    : undefined
                }
              >
                {prozess.aktiv ? 'Prozess abschalten' : 'Prozess aktivieren'}
              </ActionButton>
            )}
            <Link className="btn" href="/prozesse?reiter=ablaeufe">Alle Abläufe</Link>
          </>
        }
      />

      {prozess.beschreibung && (
        <p className="muted" style={{ marginTop: 0 }}>{prozess.beschreibung}</p>
      )}

      <Card title="Diagramm">
        <ProzessFlow d={diagramm} />
      </Card>

      <Card title="Schritte" tight>
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Schritt</th>
                <th>Art</th>
                <th>Verknüpfung</th>
                <th>Belegzustand</th>
                <th>Rollen</th>
                <th>Laufzeit-Schalter</th>
              </tr>
            </thead>
            <tbody>
              {schritte.map((s) => (
                <tr key={s.code} style={s.abgeschaltet ? { opacity: 0.55 } : undefined}>
                  <td>
                    {s.name} <span className="mono small muted">{s.code}</span>
                  </td>
                  <td>
                    <span className="badge neutral">{ART_TEXT[s.art] ?? s.art}</span>
                  </td>
                  <td className="mono small">{s.aktion ?? s.job_kind ?? s.ereignis ?? '—'}</td>
                  <td className="mono small">{s.zustand ?? '—'}</td>
                  <td className="mono small">{s.rollen?.join(', ') ?? 'alle'}</td>
                  <td>
                    {!s.optional ? (
                      <span className="muted small">fester Bestandteil</span>
                    ) : (
                      <span className="actions" style={{ gap: 6 }}>
                        <span className={`led ${s.abgeschaltet ? 'off' : 'ok'}`} />{' '}
                        <span className="small">{s.abgeschaltet ? 'abgeschaltet' : 'aktiv'}</span>
                        {admin && (
                          <ActionButton
                            className="small"
                            action={schrittSchalten.bind(null, code, s.code, Boolean(s.abgeschaltet))}
                          >
                            {s.abgeschaltet ? 'Einschalten' : 'Abschalten'}
                          </ActionButton>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <p className="muted small" style={{ padding: '8px 12px', margin: 0 }}>
          Overrides binden an den Schritt-Code und überleben Versionswechsel. Abgeschaltete
          optionale Schritte verschwinden aus „Als Nächstes möglich" — die Nachfolger rücken nach.
        </p>
      </Card>

      {versionen.length > 1 && (
        <Card title={`Versionen (${versionen.length})`} tight>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th className="num">Version</th>
                  <th>Status</th>
                  <th>Angelegt</th>
                  <th>Aktiviert</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {versionen.map((v) => (
                  <tr key={v.id}>
                    <td className="num mono">
                      <Link href={`/prozesse/${code}?version=${Number(v.version)}`}>
                        {Number(v.version)}
                      </Link>
                      {v.id === gezeigt.id && <span className="muted small"> (angezeigt)</span>}
                    </td>
                    <td>
                      <span
                        className={`badge ${
                          v.status === 'aktiv' ? 'success' : v.status === 'entwurf' ? 'warn' : 'neutral'
                        }`}
                      >
                        {v.status}
                      </span>
                    </td>
                    <td className="mono small muted">
                      {dateTime(v.created_at)}
                      {v.created_by ? ` · ${v.created_by}` : ''}
                    </td>
                    <td className="mono small muted">
                      {v.aktiviert_am ? dateTime(v.aktiviert_am) : '—'}
                    </td>
                    <td>
                      {v.status === 'entwurf' && admin && (
                        <ActionButton
                          className="small"
                          action={versionAktivieren.bind(null, code, Number(v.version))}
                          confirm={`Version ${Number(v.version)} aktivieren? Der Entwurf wird validiert, die bisher aktive Version archiviert.`}
                        >
                          Aktivieren
                        </ActionButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <p className="muted small" style={{ padding: '8px 12px', margin: 0 }}>
            Entwürfe entstehen aus KI-Vorschlägen (prozess_entwerfen) — aktiv wird eine Version
            erst durch den Klick hier, nach Prüfung des Diagramms.
          </p>
        </Card>
      )}
    </>
  )
}
