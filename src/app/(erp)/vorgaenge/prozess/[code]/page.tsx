import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireArea } from '@/modules/auth'
import type { Area } from '@/modules/auth/permissions'
import { sql } from '@/db/client'
import { startAngebot } from '@/modules/prozesse/angebote'
import { ProzessAktionen } from '@/components/prozess-aktionen'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { dateTime } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

/**
 * Die eigene Liste eines Laufzeit-Prozesses — der zweite Teil der
 * On-demand-Oberfläche. Die Maske entstand schon immer aus den Schritten;
 * hier entsteht auch die TABELLE aus dem Prozess: die Zustandsfilter kommen
 * aus seiner aktiven Version, die zusätzlichen Spalten aus den eigenen
 * Feldern (feld_definitionen). Diese Seite kennt keinen Prozess beim Namen.
 *
 * Der Sammelblick /vorgaenge bleibt daneben bestehen — er zeigt alle
 * Laufzeit-Prozesse zusammen.
 */
export default async function ProzessListe({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>
  searchParams: Promise<{ zustand?: string }>
}) {
  const { code } = await params
  const { zustand } = await searchParams

  const [prozess] = await sql<
    { code: string; name: string; beschreibung: string | null; bereich: string }[]
  >`
    select code, name, beschreibung, bereich from prozesse
    where code = ${code} and modell = 'vorgang'`
  if (!prozess) notFound()

  // Rechte am Bereich des Prozesses, nicht pauschal am Verkauf: ein
  // Personalablauf gehört hinter die Personalschranke.
  await requireArea(prozess.bereich as Area)

  // Zustände in Prozessreihenfolge — das ist die Filterleiste.
  const zustaende = await sql<{ zustand: string }[]>`
    select distinct on (s.zustand) s.zustand
    from prozess_schritte s
    where s.version_id = prozess_aktive_version(${code}) and s.zustand is not null
    order by s.zustand, s.sequence`

  // Spalten aus den eigenen Feldern DIESES Prozesses (plus den modellweiten):
  // `in_liste` im Entwurf setzt 'liste' in sichtbar_in. Hat niemand eine
  // Spalte gewählt, zeigen wir die ersten vier Formularfelder — eine leere
  // Tabelle wäre die schlechtere Vorgabe.
  const alleFelder = await sql<{ name: string; label: string; sichtbar_in: string[] }[]>`
    select name, label, sichtbar_in from feld_definitionen
    where modell = 'vorgang' and (prozess_code is null or prozess_code = ${code})
    order by prozess_code nulls last, sequence, name`
  const gewaehlt = alleFelder.filter((f) => f.sichtbar_in.includes('liste'))
  const felder = gewaehlt.length > 0 ? gewaehlt : alleFelder.slice(0, 4)

  // Das Startformular ist die generierte Maske des Anlage-Schritts — damit
  // trägt es die eigenen Felder des Prozesses und schreibt sie in den zusatz.
  const start = await startAngebot(code)

  const vorgaenge = await sql<
    {
      id: string
      number: string
      titel: string | null
      state: string
      partner: string | null
      zusatz: Record<string, unknown>
      created_at: string
    }[]
  >`
    select v.id, v.number, v.titel, v.state, pa.name as partner, v.zusatz, v.created_at
    from vorgaenge v
    left join partners pa on pa.id = v.partner_id
    where v.prozess_code = ${code}
      and (${zustand ?? null}::text is null or v.state = ${zustand ?? null})
    order by v.created_at desc
    limit 300`

  const jeZustand = await sql<{ state: string; anzahl: number }[]>`
    select state, count(*)::int as anzahl from vorgaenge
    where prozess_code = ${code} group by state`
  const anzahl = new Map(jeZustand.map((z) => [z.state, z.anzahl]))
  const gesamt = jeZustand.reduce((s, z) => s + z.anzahl, 0)

  return (
    <>
      <PageHeader
        title={prozess.name}
        subtitle={prozess.beschreibung ?? 'Laufzeit-Prozess — Maske und Liste kommen aus der Definition'}
        actions={
          <>
            <Link className="btn" href={`/prozesse/${prozess.code}`}>Ablauf ansehen</Link>
            <Link className="btn" href="/vorgaenge">Alle Vorgänge</Link>
          </>
        }
      />

      <Card title={`Neuer Vorgang: ${prozess.name}`}>
        {start ? (
          <ProzessAktionen schritte={[start]} sofortOffen={start.code} />
        ) : (
          <Empty>
            Dieser Ablauf hat keinen Schritt, der einen Vorgang anlegt — der Entwurf braucht
            eine Aktion <span className="mono">vorgang.anlegen</span>.
          </Empty>
        )}
      </Card>

      {zustaende.length > 0 && (
        <div className="actions" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          <Link
            className={`btn ${zustand ? '' : 'primary'}`}
            href={`/vorgaenge/prozess/${prozess.code}`}
          >
            Alle ({gesamt})
          </Link>
          {zustaende.map((z) => (
            <Link
              key={z.zustand}
              className={`btn ${zustand === z.zustand ? 'primary' : ''}`}
              href={`/vorgaenge/prozess/${prozess.code}?zustand=${encodeURIComponent(z.zustand)}`}
            >
              {z.zustand} ({anzahl.get(z.zustand) ?? 0})
            </Link>
          ))}
        </div>
      )}

      <Card title={zustand ? `Zustand „${zustand}"` : 'Alle Vorgänge dieses Ablaufs'} tight>
        {vorgaenge.length === 0 ? (
          <Empty>
            {zustand
              ? 'In diesem Zustand steht gerade nichts.'
              : 'Noch kein Vorgang — oben starten.'}
          </Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nummer</th>
                  <th>Titel</th>
                  <th>Partner</th>
                  <th>Zustand</th>
                  {felder.map((f) => (
                    <th key={f.name}>{f.label}</th>
                  ))}
                  <th>Angelegt</th>
                </tr>
              </thead>
              <tbody>
                {vorgaenge.map((v) => (
                  <tr key={v.id}>
                    <td className="mono">
                      <Link href={`/vorgaenge/${v.id}`}>{v.number}</Link>
                    </td>
                    <td>{v.titel ?? <span className="muted">—</span>}</td>
                    <td>{v.partner ?? <span className="muted">—</span>}</td>
                    <td><span className="badge neutral">{v.state}</span></td>
                    {felder.map((f) => (
                      <td key={f.name}>
                        {v.zusatz?.[f.name] == null ? (
                          <span className="muted">—</span>
                        ) : (
                          String(v.zusatz[f.name])
                        )}
                      </td>
                    ))}
                    <td className="mono small">{dateTime(v.created_at)}</td>
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
