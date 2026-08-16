import { sql } from '@/db/client'
import { Card } from '@/components/ui'
import { ProzessDiagramm } from '@/components/prozess-diagramm'
import { type LayoutKante, type LayoutSchritt, layout } from '@/modules/prozesse/diagramm-layout'
import { registrierteAktion } from '@/modules/prozesse/registry'
import type { Role } from '@/modules/auth/permissions'
import { aktionErlaubt } from '@/modules/prozesse/torwaechter'

/**
 * Prozess-Panel einer Belegseite: wo steht der Beleg (Diagramm), und welche
 * Schritte sind JETZT möglich — aus der Prozessdefinition, den Overrides und
 * der Rolle des Betrachters, nicht aus verstreuten if-Bedingungen der Seite.
 *
 * Erste Ausbaustufe bewusst lesend: die vorhandenen Knöpfe bleiben die
 * Ausführung; das Panel macht den Prozess sichtbar. Die generierten
 * Schrittformulare übernehmen in der nächsten Stufe.
 */
export async function ProzessPanel({
  prozessCode,
  recordId,
  rolle,
}: {
  prozessCode: string
  recordId: string
  rolle: Role
}) {
  const [prozess] = await sql<{ id: string; name: string; beschreibung: string | null }[]>`
    select id, name, beschreibung from prozesse where code = ${prozessCode} and aktiv`
  if (!prozess) return null

  const schritte = await sql<
    (LayoutSchritt & { rollen: string[] | null })[]
  >`
    select s.code, s.name, s.art::text as art, s.optional, s.rollen,
           coalesce(o.aktiv, true) = false and s.optional as abgeschaltet
    from prozess_schritte s
    left join prozess_overrides o
      on o.prozess_code = ${prozessCode} and o.schritt_code = s.code
    where s.version_id = prozess_aktive_version(${prozessCode})
    order by s.sequence`
  if (schritte.length === 0) return null

  const kanten = await sql<LayoutKante[]>`
    select von_code as von, nach_code as nach, sequence, beschriftung
    from prozess_uebergaenge
    where version_id = prozess_aktive_version(${prozessCode})
    order by sequence`

  const [standort] = await sql<{ schritt: string | null }[]>`
    select prozess_aktueller_schritt(${prozessCode}, ${recordId}) as schritt`

  const naechste = await sql<
    { code: string; name: string; art: string; aktion: string | null; rollen: string[] | null }[]
  >`
    select code, name, art::text as art, aktion, rollen
    from prozess_naechste_schritte(${prozessCode}, ${recordId})`

  const diagramm = layout(schritte, kanten, standort?.schritt)

  return (
    <Card title={`Prozess: ${prozess.name}`}>
      <ProzessDiagramm d={diagramm} />
      <div style={{ marginTop: 10 }}>
        <span className="mono-label">Als Nächstes möglich</span>
        <div className="actions" style={{ marginTop: 6, flexWrap: 'wrap', gap: 6 }}>
          {naechste.length === 0 ? (
            <span className="muted small">Nichts — der Prozess ist am Ende oder wartet.</span>
          ) : (
            naechste.map((s) => {
              const eintrag = s.aktion ? registrierteAktion(s.aktion) : undefined
              // Schritt-Rollen UND Aktionsrechte entscheiden, ob die Rolle
              // des Betrachters dran darf.
              const rolleErlaubt =
                (!s.rollen || s.rollen.length === 0 || s.rollen.includes(rolle)) &&
                (!eintrag || aktionErlaubt(eintrag, rolle))
              return (
                <span
                  key={s.code}
                  className={`badge ${rolleErlaubt ? 'info' : 'neutral'}`}
                  title={
                    (eintrag ? `${s.aktion}` : s.art) +
                    (rolleErlaubt ? '' : ' — für Ihre Rolle nicht freigegeben')
                  }
                >
                  {s.name}
                  {!rolleErlaubt && ' 🔒'}
                </span>
              )
            })
          )}
        </div>
      </div>
    </Card>
  )
}
