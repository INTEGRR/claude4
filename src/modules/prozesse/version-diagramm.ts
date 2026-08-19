import 'server-only'

import { sql } from '@/db/client'
import type { FlowKante, FlowSchritt } from './flow-daten'
import { type FlowDiagramm, flowLayout } from './flow-layout'

/**
 * Eine Prozessversion samt gelayoutetem Diagramm lesen — geteilt zwischen
 * der Detailseite /prozesse/<code> und der Prozess-Werkstatt. Angezeigt wird:
 * die ausdrücklich gewünschte Version, sonst die aktive, sonst die neueste
 * (reiner Entwurf). Bewusst OHNE `aktiv`-Filter: abgeschaltete Prozesse und
 * reine Entwürfe (KI-Vorschläge ohne aktive Version) bleiben sichtbar — sie
 * fehlen nur in Navigation und Assistenten.
 */

export interface ProzessKopf {
  id: string
  code: string
  name: string
  beschreibung: string | null
  bereich: string
  modell: string | null
  aktiv: boolean
}

export interface ProzessVersion {
  id: string
  version: number
  status: string
  created_by: string | null
  created_at: string
  aktiviert_am: string | null
}

export interface VersionDiagramm {
  prozess: ProzessKopf
  versionen: ProzessVersion[]
  gezeigt: ProzessVersion
  schritte: (FlowSchritt & { override_aktiv: boolean | null })[]
  diagramm: FlowDiagramm
}

export async function versionDiagramm(
  code: string,
  versionWunsch?: number,
): Promise<VersionDiagramm | null> {
  const [prozess] = await sql<ProzessKopf[]>`
    select id, code, name, beschreibung, bereich, modell, aktiv
    from prozesse where code = ${code}`
  if (!prozess) return null

  const versionen = await sql<ProzessVersion[]>`
    select id, version, status, created_by, created_at, aktiviert_am
    from prozess_versionen
    where prozess_id = ${prozess.id}
    order by version desc`
  if (versionen.length === 0) return null

  const gezeigt =
    (versionWunsch !== undefined &&
      versionen.find((v) => Number(v.version) === Number(versionWunsch))) ||
    versionen.find((v) => v.status === 'aktiv') ||
    versionen[0]

  const schritte = await sql<(FlowSchritt & { override_aktiv: boolean | null })[]>`
    select s.code, s.name, s.art::text as art, s.optional,
           s.aktion, s.job_kind, s.ereignis, s.teilprozess, s.zustand, s.rollen,
           o.aktiv as override_aktiv,
           coalesce(o.aktiv, true) = false and s.optional as abgeschaltet
    from prozess_schritte s
    left join prozess_overrides o
      on o.prozess_code = ${code} and o.schritt_code = s.code
    where s.version_id = ${gezeigt.id}
    order by s.sequence`

  const kanten = await sql<FlowKante[]>`
    select von_code as von, nach_code as nach, sequence, beschriftung
    from prozess_uebergaenge
    where version_id = ${gezeigt.id}
    order by sequence`

  const diagramm = await flowLayout(schritte, kanten, null)
  return { prozess, versionen, gezeigt, schritte, diagramm }
}
