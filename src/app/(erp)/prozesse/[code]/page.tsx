import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireArea } from '@/modules/auth'
import { sql } from '@/db/client'
import { ActionButton } from '@/components/action-button'
import { Card, PageHeader, TableWrap } from '@/components/ui'
import { ProzessDiagramm } from '@/components/prozess-diagramm'
import { type LayoutKante, type LayoutSchritt, layout } from '@/modules/prozesse/diagramm-layout'
import { FIXTURES } from '@/modules/prozesse/fixtures'
import { schrittSchalten } from '../actions'

export const dynamic = 'force-dynamic'

/**
 * Eine Prozessdefinition im Detail: Diagramm, Schritte, Übergänge — und die
 * Laufzeit-Schalter der Firma (Overrides): optionale Schritte lassen sich
 * hier abschalten, Nachfolger rücken in den Abläufen automatisch nach.
 */
export default async function ProzessDetailPage({
  params,
}: {
  params: Promise<{ code: string }>
}) {
  const user = await requireArea('einstellungen')
  const { code } = await params

  const [prozess] = await sql<
    {
      code: string
      name: string
      beschreibung: string | null
      bereich: string
      modell: string | null
      version: number
    }[]
  >`
    select p.code, p.name, p.beschreibung, p.bereich, p.modell, v.version
    from prozesse p
    join prozess_versionen v on v.id = prozess_aktive_version(p.code)
    where p.code = ${code} and p.aktiv`
  if (!prozess) notFound()

  const schritte = await sql<
    (LayoutSchritt & {
      aktion: string | null
      job_kind: string | null
      ereignis: string | null
      zustand: string | null
      rollen: string[] | null
      override_aktiv: boolean | null
    })[]
  >`
    select s.code, s.name, s.art::text as art, s.optional,
           s.aktion, s.job_kind, s.ereignis, s.zustand, s.rollen,
           o.aktiv as override_aktiv,
           coalesce(o.aktiv, true) = false and s.optional as abgeschaltet
    from prozess_schritte s
    left join prozess_overrides o
      on o.prozess_code = ${code} and o.schritt_code = s.code
    where s.version_id = prozess_aktive_version(${code})
    order by s.sequence`

  const kanten = await sql<LayoutKante[]>`
    select von_code as von, nach_code as nach, sequence, beschriftung
    from prozess_uebergaenge
    where version_id = prozess_aktive_version(${code})
    order by sequence`

  const diagramm = layout(schritte, kanten, null)
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
            <span className="mono">{prozess.code}</span> · Version {Number(prozess.version)} ·
            Bereich {prozess.bereich} ·{' '}
            {prozess.modell ? (
              <>Beleg <span className="mono">{prozess.modell}</span></>
            ) : (
              <Link href={`/p/${prozess.code}`}>Assistent öffnen</Link>
            )}
          </>
        }
        actions={
          <>
            {fixture ? (
              <span className="badge success" title="Der Prozesstest spielt diesen Ablauf durch">
                Prozesstest ✓
              </span>
            ) : (
              <span className="badge warn">ohne Fixture</span>
            )}
            <Link className="btn" href="/prozesse?reiter=ablaeufe">Alle Abläufe</Link>
          </>
        }
      />

      {prozess.beschreibung && (
        <p className="muted" style={{ marginTop: 0 }}>{prozess.beschreibung}</p>
      )}

      <Card title="Diagramm">
        <ProzessDiagramm d={diagramm} />
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
    </>
  )
}
