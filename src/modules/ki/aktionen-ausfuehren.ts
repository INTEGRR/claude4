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

// Leer seit der Katalog-Auflösung — siehe aktionen.ts.
const AUSFUEHRUNG: Record<AktionName, (p: never, actor: string) => Promise<AktionErgebnis>> = {}

export async function aktionAusfuehren(
  name: AktionName,
  werte: Record<string, unknown>,
  actor: string,
): Promise<AktionErgebnis> {
  const fn = (AUSFUEHRUNG as Record<string, (p: never, actor: string) => Promise<AktionErgebnis>>)[
    name
  ]
  if (!fn) throw new Error(`Unbekannte Aktion „${name}"`)
  return fn(werte as never, actor)
}
