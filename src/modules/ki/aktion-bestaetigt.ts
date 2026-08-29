import { sql } from '@/db/client'
import type { User } from '@/modules/auth'
import { aktionAusfuehrenGeprueft } from '@/modules/prozesse/torwaechter'

/**
 * Der gemeinsame Ausführungsweg für BESTÄTIGTE KI-Aktionen — genutzt vom
 * Chat (POST /api/ki/aktion, Klick auf „Anlegen"), von der Bulk-Buchung
 * des Sprachmodus (POST /api/sprechen/buchen) und der Prozess-Aufnahme.
 *
 * Seit der Auflösung des KI-Anlage-Katalogs (Entscheidungslog 2026-08-27)
 * gibt es nur noch EINEN Zweig: den Torwächter (Schema, Rechte inkl.
 * nurAdmin, Ausführung, Audit). Die record_id einer beleggebundenen Aktion
 * reist im Parameter mit (siehe agent.ts) und wird hier abgetrennt.
 * Fehler kommen als AktionsFehler/RechteFehler zum Aufrufer — der
 * entscheidet, ob daraus HTTP-Status oder Tabellenzeilen-Status wird.
 */
export async function bestaetigteAktionAusfuehren(
  name: string,
  parameter: unknown,
  user: User,
): Promise<{ text: string; link?: string }> {
  const p = (parameter && typeof parameter === 'object' ? parameter : {}) as Record<
    string,
    unknown
  >
  const { record_id, ...rest } = p
  const ergebnis = await aktionAusfuehrenGeprueft(
    name,
    { parameter: rest, recordId: typeof record_id === 'string' ? record_id : undefined },
    user,
  )
  await sql`select log_event('ki', gen_random_uuid(), 'state',
    ${`Aktion ausgeführt: ${name}`}, ${user.name})`
  return {
    text: ergebnis.text ?? 'Ausgeführt.',
    ...(ergebnis.link ? { link: ergebnis.link } : {}),
  }
}
