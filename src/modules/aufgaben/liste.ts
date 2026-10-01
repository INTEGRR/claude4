import { sql } from '@/db/client'
import type { Role } from '@/modules/auth/permissions'

/**
 * Lesesicht der Aufgaben (0104) — eine Abfrage für Übersicht, Navi-Zähler
 * und Aufgabenseite. „Meine" heißt: mir zugewiesen, oder ohne Person an
 * eines meiner Teams (Haupt- oder Zusatzrolle).
 */
export interface AufgabeZeile {
  id: string
  titel: string
  beschreibung: string | null
  faellig_am: string
  uhrzeit: string | null
  dauer_min: number | null
  zustaendig_id: string | null
  zustaendig: string | null
  rolle: string | null
  erstellt_von: string
  erstellt_von_id: string | null
  status: 'offen' | 'erledigt' | 'verworfen'
  erledigt_am: string | null
  erledigt_von: string | null
  notiz: string | null
  ueberfaellig: boolean
  heute: boolean
}

export type AufgabenFilter = 'meine' | 'offen' | 'erledigt'

interface Nutzer {
  id: string
  rollen: readonly Role[]
}

const meine = (u: Nutzer) =>
  sql`(a.zustaendig_id = ${u.id} or (a.zustaendig_id is null and a.rolle::text = any(${[...u.rollen]}::text[])))`

export async function aufgabenListe(u: Nutzer, filter: AufgabenFilter, limit = 200): Promise<AufgabeZeile[]> {
  return sql<AufgabeZeile[]>`
    select a.id, a.titel, a.beschreibung, a.faellig_am::text as faellig_am,
           to_char(a.uhrzeit, 'HH24:MI') as uhrzeit, a.dauer_min, a.zustaendig_id, u.name as zustaendig,
           a.rolle::text as rolle, a.erstellt_von, a.erstellt_von_id, a.status::text as status,
           a.erledigt_am::text as erledigt_am, a.erledigt_von, a.notiz,
           a.status = 'offen' and a.faellig_um < now() as ueberfaellig,
           a.faellig_am = (now() at time zone 'Europe/Berlin')::date as heute
    from aufgaben a
    left join users u on u.id = a.zustaendig_id
    where ${
      filter === 'erledigt'
        ? sql`a.status <> 'offen' and a.erledigt_am > now() - interval '14 days'`
        : filter === 'offen'
          ? sql`a.status = 'offen'`
          : sql`a.status = 'offen' and ${meine(u)}`
    }
    order by ${filter === 'erledigt' ? sql`a.erledigt_am desc` : sql`a.faellig_um, a.created_at`}
    limit ${limit}`
}

/** Für den Navi-Zähler: meine offenen Aufgaben, die heute oder früher fällig sind. */
export async function meineFaelligenAufgaben(u: Nutzer): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from aufgaben a
    where a.status = 'offen' and ${meine(u)}
      and a.faellig_am <= (now() at time zone 'Europe/Berlin')::date`
  return n
}
