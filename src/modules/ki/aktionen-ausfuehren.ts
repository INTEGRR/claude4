import { sql } from '@/db/client'
import type { AktionErgebnis, AktionName } from './aktionen'

/**
 * Die Ausführung der Katalogaktionen — getrennt vom Katalog, weil nur dieser
 * Teil die Datenbank braucht. Aufgerufen wird sie ausschließlich von
 * /api/ki/aktion, also nach Rechteprüfung und Bestätigung durch den Benutzer.
 *
 * Angelegt wird immer über dieselben Wege wie in der Oberfläche: Nummernkreise
 * über next_sequence, Fertigungsaufträge über create_manufacturing_order. Kein
 * Sonderweg für die KI — sonst gälten für ihre Datensätze andere Regeln.
 */

// --- Ausführung -------------------------------------------------------------

type Werte = Record<string, unknown>

const AUSFUEHRUNG: Record<AktionName, (p: never, actor: string) => Promise<AktionErgebnis>> = {
  notiz_anlegen: async (p: Werte, actor) => {
    await sql`select log_event(${p.model as string}, ${p.record_id as string}::uuid, 'note',
      ${p.text as string}, ${actor})`
    return { text: 'Notiz hinterlegt.' }
  },
}

export async function aktionAusfuehren(
  name: AktionName,
  werte: Record<string, unknown>,
  actor: string,
): Promise<AktionErgebnis> {
  return AUSFUEHRUNG[name](werte as never, actor)
}
