import 'server-only'
import { cookies } from 'next/headers'
import { sql } from '@/db/client'
import { idOderNull } from './routing'

/**
 * Der Arbeitsplatz dieses PCs (Entscheidungslog 2026-09-29): einmal am Gerät
 * gewählt, im Kopf sichtbar und umschaltbar. Jede Anmeldung an diesem PC ist
 * damit an den Platz gebunden — gedruckt wird auf seinen Druckern. Das
 * Cookie übersteht das Abmelden (logout löscht nur die Sitzung).
 */
export const ARBEITSPLATZ_COOKIE = 'erp_arbeitsplatz'
/** Browser begrenzen Cookies auf gut 400 Tage. */
export const ARBEITSPLATZ_TAGE = 400

export interface ArbeitsplatzKurz {
  id: string
  code: string
  name: string
  art: string
}

/** Die ID aus dem Cookie — ungeprüft gegen die Datenbank. */
export async function arbeitsplatzIdDesGeraets(): Promise<string | null> {
  const jar = await cookies()
  return idOderNull(jar.get(ARBEITSPLATZ_COOKIE)?.value)
}

/** Aktive Arbeitsplätze für die Auswahl im Kopf, nach Art gruppierbar. */
export async function arbeitsplaetzeZurAuswahl(): Promise<ArbeitsplatzKurz[]> {
  return sql<ArbeitsplatzKurz[]>`
    select id, code, name, art from work_centers
    where active order by art, name`
}
