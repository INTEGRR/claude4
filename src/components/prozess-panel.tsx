import { sql } from '@/db/client'
import { Card } from '@/components/ui'
import { ProzessFlow } from '@/components/prozess-flow'
import type { FlowKante, FlowSchritt } from '@/modules/prozesse/flow-daten'
import { flowLayout } from '@/modules/prozesse/flow-layout'
import { naechsteAngebote } from '@/modules/prozesse/angebote'
import type { Role } from '@/modules/auth/permissions'
import { ProzessAktionen } from '@/components/prozess-aktionen'

/**
 * Prozess-Panel einer Belegseite: wo steht der Beleg (Diagramm), und welche
 * Schritte sind JETZT möglich — aus der Prozessdefinition, den Overrides und
 * der Rolle des Betrachters, nicht aus verstreuten if-Bedingungen der Seite.
 *
 * Seit Phase 4 aktiv: die möglichen Schritte sind Tasten mit GENERIERTEN
 * Formularen aus den Registry-Schemas; ausgeführt wird über /api/aktion —
 * denselben Torwächter wie Server Actions und Prozesstest. Die vorhandenen
 * Fachmasken bleiben daneben bestehen, bis der Prozess sie ablöst.
 */
export async function ProzessPanel({
  prozessCode,
  recordId,
  rolle,
  befugnisse = [],
  nurDiagramm = false,
}: {
  prozessCode: string
  recordId: string
  rolle: Role
  /** Personengebundene Zusatzrechte des Betrachters (users.befugnisse). */
  befugnisse?: string[]
  /**
   * Nur das Diagramm (mit Standort), ohne den Schritte-Block — für Seiten,
   * die „Als Nächstes möglich" selbst prominenter platzieren und den Ablauf
   * als einklappbaren Kontext ans Ende stellen (Vorgangs-Detailseite).
   */
  nurDiagramm?: boolean
}) {
  const [prozess] = await sql<{ id: string; name: string; beschreibung: string | null }[]>`
    select id, name, beschreibung from prozesse where code = ${prozessCode} and aktiv`
  if (!prozess) return null

  const schritte = await sql<
    (FlowSchritt & { teilprozess_link: Record<string, unknown> | null })[]
  >`
    select s.code, s.name, s.art::text as art, s.optional, s.rollen,
           s.aktion, s.job_kind, s.ereignis, s.teilprozess, s.teilprozess_link, s.zustand,
           coalesce(o.aktiv, true) = false and s.optional as abgeschaltet
    from prozess_schritte s
    left join prozess_overrides o
      on o.prozess_code = ${prozessCode} and o.schritt_code = s.code
    where s.version_id = prozess_aktive_version(${prozessCode})
    order by s.sequence`
  if (schritte.length === 0) return null

  const kanten = await sql<FlowKante[]>`
    select von_code as von, nach_code as nach, sequence, beschriftung
    from prozess_uebergaenge
    where version_id = prozess_aktive_version(${prozessCode})
    order by sequence`

  const [standort] = await sql<{ schritt: string | null }[]>`
    select prozess_aktueller_schritt(${prozessCode}, ${recordId}) as schritt`

  // Fortschritt der Teilprozesse — nur mit Beleg sinnvoll.
  for (const s of schritte) {
    if (s.art !== 'prozess' || !s.teilprozess) continue
    const [stand] = await sql<{ gesamt: number; fertig: number }[]>`
      select gesamt, fertig from teilprozess_stand(
        ${s.teilprozess},
        ${s.teilprozess_link ? sql.json(s.teilprozess_link as never) : null},
        (select modell from prozesse where code = ${prozessCode}), ${recordId})`
    s.teilprozessStand = { gesamt: Number(stand.gesamt), fertig: Number(stand.fertig) }
  }

  const diagramm = await flowLayout(schritte, kanten, standort?.schritt)

  if (nurDiagramm) {
    return (
      <Card title={`Prozess: ${prozess.name}`}>
        <ProzessFlow d={diagramm} />
      </Card>
    )
  }

  const { angebote, passiv } = await naechsteAngebote(prozessCode, recordId, rolle, befugnisse)

  return (
    <Card title={`Prozess: ${prozess.name}`}>
      <ProzessFlow d={diagramm} />
      <div style={{ marginTop: 10 }}>
        <span className="mono-label">Als Nächstes möglich</span>
        <div style={{ marginTop: 6 }}>
          {angebote.length === 0 && passiv.length === 0 ? (
            <span className="muted small">Nichts — der Prozess ist am Ende oder wartet.</span>
          ) : (
            <>
              {angebote.length > 0 && <ProzessAktionen schritte={angebote} recordId={recordId} />}
              {passiv.length > 0 && (
                <div className="actions" style={{ marginTop: 6, flexWrap: 'wrap', gap: 6 }}>
                  {passiv.map((s) => (
                    <span key={s.code} className="badge neutral" title={s.art}>
                      {s.name} — wartet
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  )
}
