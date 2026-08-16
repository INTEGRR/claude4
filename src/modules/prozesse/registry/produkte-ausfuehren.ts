import { sql } from '@/db/client'
import { type ProduktEingabe, produktAnlegen } from '../../ki/produkt-anlegen.ts'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung der Produkt-Aktionen — dieselbe Fachlogik wie die KI-Aktion. */

export async function produktAnlegenAktion(
  p: ProduktEingabe,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const ergebnis = await produktAnlegen(sql, p, ctx.actor)
  return {
    text:
      `Produkt „${p.name}" angelegt — ${ergebnis.varianten} Variante(n)` +
      (ergebnis.benannt > 0 ? `, ${ergebnis.benannt} mit Artikelnummer` : '') +
      '.',
    link: `/produkte/${ergebnis.templateId}`,
    recordId: ergebnis.templateId,
  }
}
