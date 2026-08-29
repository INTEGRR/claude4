import { sql } from '@/db/client'
import type { User } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { aktionPruefen as katalogPruefen } from './aktionen'
import { aktionAusfuehren as katalogAusfuehren } from './aktionen-ausfuehren'

/**
 * Der gemeinsame Ausführungsweg für BESTÄTIGTE KI-Aktionen — genutzt vom
 * Chat (POST /api/ki/aktion, Klick auf „Anlegen") und von der Bulk-Buchung
 * des Sprachmodus (POST /api/sprechen/buchen, Sichtprüfung + „Alle buchen").
 *
 * Zwei Zweige wie gehabt: Registry-Aktionen (Name mit Punkt) laufen komplett
 * über den Torwächter (Schema, Rechte inkl. nurAdmin, Audit); der Rest des
 * KI-Anlage-Katalogs (verkaufsauftrag_anlegen …) über aktionPruefen +
 * canWrite — bis auch er in die Registry überführt ist.
 * Fehler kommen als AktionsFehler/RechteFehler bzw. Error zum Aufrufer —
 * der entscheidet, ob daraus HTTP-Status oder Tabellenzeilen-Status wird.
 */
export async function bestaetigteAktionAusfuehren(
  name: string,
  parameter: unknown,
  user: User,
): Promise<{ text: string; link?: string }> {
  if (name.includes('.')) {
    const p = (parameter && typeof parameter === 'object' ? parameter : {}) as Record<
      string,
      unknown
    >
    const { record_id, ...rest } = p
    const { aktionAusfuehrenGeprueft } = await import('@/modules/prozesse/torwaechter')
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

  const geprueft = katalogPruefen(name, parameter)
  if (!canWrite(user.role, geprueft.aktion.bereich)) {
    const { RechteFehler } = await import('@/modules/prozesse/torwaechter')
    throw new RechteFehler(`Ihrer Rolle fehlt die Berechtigung für „${geprueft.aktion.label}"`)
  }
  const ergebnis = await katalogAusfuehren(geprueft.name, geprueft.werte, user.name)
  await sql`select log_event('ki', gen_random_uuid(), 'state',
    ${`Aktion ausgeführt: ${geprueft.name} — ${geprueft.aktion.zusammenfassung(geprueft.werte)}`}, ${user.name})`
  return ergebnis
}
