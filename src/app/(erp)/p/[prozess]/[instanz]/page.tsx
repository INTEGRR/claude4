import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/modules/auth'
import { type Area, canAccess, canWrite } from '@/modules/auth/permissions'
import { sql } from '@/db/client'
import { ActionButton } from '@/components/action-button'
import { Card, PageHeader } from '@/components/ui'
import { ProzessDiagramm } from '@/components/prozess-diagramm'
import { ProzessAktionen } from '@/components/prozess-aktionen'
import { type LayoutKante, type LayoutSchritt, layout } from '@/modules/prozesse/diagramm-layout'
import { naechsteAngebote } from '@/modules/prozesse/angebote'
import { dateTime } from '@/modules/shared/format'
import { instanzAbschliessen } from '../../actions'

export const dynamic = 'force-dynamic'

/**
 * Ein Lauf eines beleglosen Assistenten: Diagramm mit Standort, die JETZT
 * möglichen Schritte als generierte Formulare (über /api/aktion + Instanz-
 * Weiterschaltung), gesammelte Ergebnisse aus instanz.daten.
 */
export default async function AssistentLaufPage({
  params,
}: {
  params: Promise<{ prozess: string; instanz: string }>
}) {
  const user = await requireUser()
  const { prozess: code, instanz: instanzId } = await params

  const [kopf] = await sql<
    {
      id: string
      number: string
      schritt_code: string
      status: string
      daten: Record<string, unknown>
      gestartet_von: string
      created_at: string
      beendet_am: string | null
      version_id: string
      name: string
      bereich: Area
    }[]
  >`
    select i.id, i.number, i.schritt_code, i.status, i.daten, i.gestartet_von,
           i.created_at, i.beendet_am, i.version_id, p.name, p.bereich
    from prozess_instanzen i
    join prozesse p on p.id = i.prozess_id
    where i.id = ${instanzId} and p.code = ${code} and p.modell is null`
  if (!kopf || !canAccess(user.role, kopf.bereich)) notFound()

  const schritte = await sql<LayoutSchritt[]>`
    select s.code, s.name, s.art::text as art, s.optional,
           coalesce(o.aktiv, true) = false and s.optional as abgeschaltet
    from prozess_schritte s
    left join prozess_overrides o
      on o.prozess_code = ${code} and o.schritt_code = s.code
    where s.version_id = ${kopf.version_id}
    order by s.sequence`

  const kanten = await sql<LayoutKante[]>`
    select von_code as von, nach_code as nach, sequence, beschriftung
    from prozess_uebergaenge where version_id = ${kopf.version_id}
    order by sequence`

  const diagramm = layout(schritte, kanten, kopf.schritt_code)
  const laufend = kopf.status === 'laufend'
  const darfSchreiben = canWrite(user.role, kopf.bereich)

  const { angebote, passiv } = laufend
    ? await naechsteAngebote(code, kopf.id, user.role)
    : { angebote: [], passiv: [] }

  // Direkt abschließbar? (Kante vom aktuellen Schritt zu einem Ende)
  const [ende] = laufend
    ? await sql<{ nach_code: string }[]>`
        select u.nach_code from prozess_uebergaenge u
        join prozess_schritte z on z.version_id = u.version_id and z.code = u.nach_code
        where u.version_id = ${kopf.version_id}
          and u.von_code = ${kopf.schritt_code} and z.art = 'ende'
        limit 1`
    : []

  // Gesammelte Ergebnisse: *_record_id-Einträge als Belegverweise anzeigen.
  const ergebnisse = Object.entries(kopf.daten).filter(([, wert]) => wert !== null)

  return (
    <>
      <PageHeader
        title={<span className="mono">{kopf.number}</span>}
        subtitle={
          <>
            {kopf.name} · gestartet von {kopf.gestartet_von} am{' '}
            <span className="mono">{dateTime(kopf.created_at)}</span>
            {kopf.beendet_am && (
              <>
                {' '}· beendet <span className="mono">{dateTime(kopf.beendet_am)}</span>
              </>
            )}
          </>
        }
        actions={
          <>
            <span className={`badge ${laufend ? 'info' : 'neutral'}`}>
              {laufend ? 'läuft' : kopf.status}
            </span>
            <Link className="btn" href={`/p/${code}`}>Alle Läufe</Link>
          </>
        }
      />

      <Card title="Ablauf">
        <ProzessDiagramm d={diagramm} />
        {laufend && (
          <div style={{ marginTop: 10 }}>
            <span className="mono-label">Als Nächstes möglich</span>
            <div style={{ marginTop: 6 }}>
              {angebote.length === 0 && passiv.length === 0 && !ende ? (
                <span className="muted small">Nichts — der Assistent wartet.</span>
              ) : (
                <>
                  {angebote.length > 0 && darfSchreiben && (
                    <ProzessAktionen schritte={angebote} instanzId={kopf.id} />
                  )}
                  {passiv.length > 0 && (
                    <div className="actions" style={{ marginTop: 6, flexWrap: 'wrap', gap: 6 }}>
                      {passiv.map((s) => (
                        <span key={s.code} className="badge neutral" title={s.art}>
                          {s.name} — wartet
                        </span>
                      ))}
                    </div>
                  )}
                  {ende && darfSchreiben && (
                    <div style={{ marginTop: 8 }}>
                      <ActionButton
                        action={instanzAbschliessen.bind(null, kopf.id, ende.nach_code)}
                      >
                        Assistent abschließen
                      </ActionButton>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </Card>

      {ergebnisse.length > 0 && (
        <Card title="Ergebnisse">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {ergebnisse.map(([schluessel, wert]) => (
              <li key={schluessel}>
                <span className="mono-label" style={{ marginRight: 8 }}>{schluessel}</span>
                {schluessel === 'produkt_record_id' && typeof wert === 'string' ? (
                  <Link className="mono" href={`/produkte/${wert}`}>{wert}</Link>
                ) : (
                  <span className="mono">{String(wert)}</span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  )
}
