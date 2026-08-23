import Link from 'next/link'
import { requireArea } from '@/modules/auth'
import { sql } from '@/db/client'
import { Card, PageHeader, TableWrap } from '@/components/ui'
import { MaskenVorschau } from '@/components/masken-vorschau'
import { ProzessFlow } from '@/components/prozess-flow'
import { startAngebot } from '@/modules/prozesse/angebote'
import { KiChat } from '@/app/(erp)/ki/chat'
import { kiConfigured } from '@/modules/ki/agent'
import { sprechenKonfiguriert } from '@/modules/ki/sprechen'
import { aufnahmeKonfiguriert } from '@/modules/ki/prozess-aufnahme'
import { versionDiagramm } from '@/modules/prozesse/version-diagramm'
import { dateTime } from '@/modules/shared/format'
import { WerkstattAufnahme } from './aufnahme'

export const dynamic = 'force-dynamic'

/**
 * Die Prozess-Werkstatt: hier wird MIT dem Agenten gebaut — im Dialog, mit
 * Tabellen, Entwürfen und Diagramm, nicht nebenbei. Der Chat läuft im
 * Werkstatt-Kontext (Wissensbasis + Prozess-Architekt-Rolle), Entwürfe
 * entstehen nur über prozess_entwerfen, aktiviert wird von Hand auf der
 * Prozess-Detailseite. Das Sprach-Interview (Aufnahme beim Kunden) startet
 * ebenfalls hier — nicht im Alltags-Assistenten /sprechen.
 *
 * Routen-Hinweis: /prozesse/werkstatt ist ein statisches Segment und
 * gewinnt gegen /prozesse/[code] — 'werkstatt' ist deshalb als
 * Prozess-Code reserviert (refine am prozess_entwerfen-Schema).
 */
export default async function WerkstattPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>
}) {
  const user = await requireArea('einstellungen')
  const { code } = await searchParams
  const admin = user.role === 'admin'
  const mitAufnahme = admin && sprechenKonfiguriert() && aufnahmeKonfiguriert()

  // Alle Entwurfs-Versionen — das Regal der Werkstatt.
  const entwuerfe = await sql<
    { code: string; name: string; version: number; created_by: string | null; created_at: string }[]
  >`
    select p.code, p.name, v.version, v.created_by, v.created_at
    from prozess_versionen v
    join prozesse p on p.id = v.prozess_id
    where v.status = 'entwurf'
    order by v.created_at desc
    limit 30`

  // Diagramm-Vorschau: bei ?code die NEUESTE Entwurfsversion des Prozesses
  // (die Detailseite zeigt standardmäßig die aktive — hier wird gebaut).
  const vorschau = code ? await versionDiagramm(code) : null
  const vorschauEntwurf =
    vorschau && vorschau.gezeigt.status !== 'entwurf'
      ? ((await versionDiagramm(
          code!,
          vorschau.versionen.find((v) => v.status === 'entwurf')?.version,
        )) ?? vorschau)
      : vorschau

  // Die halbe Maske gehört zur Vorschau dazu: Felder und die generierte
  // Maske des Anlage-Schritts. Zwingend mit der Versions-ID der Vorschau —
  // Entwürfe sind nicht aktiv, ohne sie käme null zurück.
  const vorschauFelder = vorschauEntwurf?.prozess.modell
    ? await sql<{ name: string; label: string }[]>`
        select name, label from feld_definitionen
        where prozess_code = ${vorschauEntwurf.prozess.code} order by sequence, name`
    : []
  const vorschauMaske = vorschauEntwurf?.prozess.modell
    ? await startAngebot(vorschauEntwurf.prozess.code, vorschauEntwurf.gezeigt.id)
    : null

  return (
    <>
      <PageHeader
        title="Prozess-Werkstatt"
        subtitle="Prozesse mit dem Agenten bauen: besprechen, entwerfen, am Diagramm prüfen — aktiviert wird von Hand"
        actions={<Link className="btn" href="/prozesse?reiter=ablaeufe">Alle Abläufe</Link>}
      />

      {vorschauEntwurf && (
        <Card
          title={`Vorschau: ${vorschauEntwurf.prozess.name} — Version ${Number(vorschauEntwurf.gezeigt.version)}${
            vorschauEntwurf.gezeigt.status === 'entwurf' ? ' (Entwurf)' : ''
          }`}
        >
          <ProzessFlow d={vorschauEntwurf.diagramm} />
          {vorschauEntwurf.prozess.modell && (
            <div style={{ padding: '0 12px 8px' }}>
              {vorschauMaske && <MaskenVorschau angebot={vorschauMaske} />}
              <p className="muted small" style={{ margin: '10px 0 0' }}>
                {vorschauFelder.length === 0 ? (
                  <>
                    Dieser Entwurf erfasst außer einem Titel nichts — Felder entstehen im
                    Gespräch („trag noch ein Feld Liefertermin nach") oder auf der
                    Detailseite unter „Eigene Felder".
                  </>
                ) : (
                  <>Erfasst wird: {vorschauFelder.map((f) => f.label).join(' · ')}</>
                )}
              </p>
            </div>
          )}
          <div className="actions" style={{ padding: '0 12px 12px' }}>
            <Link className="btn" href={`/prozesse/${vorschauEntwurf.prozess.code}?version=${Number(vorschauEntwurf.gezeigt.version)}`}>
              Zur Detailseite (prüfen &amp; aktivieren)
            </Link>
          </div>
        </Card>
      )}

      {kiConfigured() ? (
        <KiChat kontext="werkstatt" />
      ) : (
        <div className="notice info">
          Die Werkstatt braucht den KI-Agenten — in der Umgebung
          <code className="mono"> ANTHROPIC_API_KEY </code> setzen.
        </div>
      )}

      {mitAufnahme && <WerkstattAufnahme />}

      {entwuerfe.length > 0 && (
        <Card title={`Entwürfe (${entwuerfe.length})`} tight>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Prozess</th>
                  <th className="num">Version</th>
                  <th>Angelegt</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {entwuerfe.map((e) => (
                  <tr key={`${e.code}-${e.version}`}>
                    <td>
                      {e.name} <span className="mono small muted">{e.code}</span>
                    </td>
                    <td className="num mono">{Number(e.version)}</td>
                    <td className="mono small muted">
                      {dateTime(e.created_at)}
                      {e.created_by ? ` · ${e.created_by}` : ''}
                    </td>
                    <td className="actions">
                      <Link className="btn small" href={`/prozesse/werkstatt?code=${e.code}`}>
                        Vorschau
                      </Link>
                      <Link className="btn small" href={`/prozesse/${e.code}?version=${Number(e.version)}`}>
                        Detailseite
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <p className="muted small" style={{ padding: '8px 12px', margin: 0 }}>
            Entwürfe sind nicht in Betrieb — aktiviert wird auf der Detailseite, nach
            Sichtprüfung des Diagramms.
          </p>
        </Card>
      )}
    </>
  )
}
