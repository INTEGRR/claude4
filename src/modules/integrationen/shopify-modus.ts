import type { Sql, TransactionSql } from 'postgres'

/**
 * Lese-/Schreibmodus der Shopify-Anbindung (settings.shopify.modus).
 *
 * „lesen" ist der Staging-Modus: KRNL hängt am Live-Shop, holt Bestellungen,
 * Kunden und Produkte, schreibt aber NICHTS zurück — keine Fulfillments,
 * kein Tracking, keine Bestände, keine Produktänderungen, keine Webhook-
 * Registrierung. Erst der Betreiber stellt in den Einstellungen auf
 * „schreiben" um (Registry-Aktion einstellungen.shopify_modus_setzen).
 *
 * Standard ohne Eintrag ist „lesen": Wer Zugangsdaten setzt, hat damit noch
 * nicht entschieden, dass ein zweites System in den Shop schreibt.
 *
 * „probe" (Probelauf, 0102) liegt dazwischen: alle Auslöser laufen wie im
 * Schreibmodus (Bestandsabgleich, Versandmeldungen, Einrichtung), aber jede
 * Mutation wird an derselben Naht NICHT gesendet, sondern als „würde
 * senden" protokolliert und in der Debug-Box angezeigt. Einzige Ausnahme:
 * Webhook-Abos (imProbelaufErlaubt) — sie richten nur den Eingang ein.
 * Durchgesetzt wird der Modus an EINER Naht — shopifyGraphQL() weist jede
 * Mutation ab —, nicht je Aufrufer. Entscheidungslog 2026-09-18.
 */

export type ShopifyModus = 'lesen' | 'probe' | 'schreiben'

export const SHOPIFY_MODUS_STANDARD: ShopifyModus = 'lesen'

export async function shopifyModus(db: Sql | TransactionSql): Promise<ShopifyModus> {
  const [row] = await db<{ modus: string | null }[]>`
    select value ->> 'modus' as modus from settings where key = 'shopify'`
  return row?.modus === 'schreiben' ? 'schreiben' : row?.modus === 'probe' ? 'probe' : SHOPIFY_MODUS_STANDARD
}

/**
 * Die EINE Ausnahme im Probelauf: Webhook-Abos anlegen oder umziehen
 * (Entscheidungslog 2026-11-27). Ein Abo ändert im Shop weder Produkte noch
 * Bestände noch Bestellungen — es richtet nur den EINGANG ein, den KRNL im
 * Probelauf ohnehin liest, nur eben in Sekunden statt alle 15 Minuten. So
 * lässt sich der Eingang vor dem Scharfschalten echt testen. Erkannt wird
 * streng am ersten (und einzigen) Feld des Dokuments; „nur lesen" bleibt zu.
 */
export function imProbelaufErlaubt(query: string): boolean {
  if (!istMutation(query)) return false
  const ohneKommentare = query.replace(/#[^\n]*/g, '')
  // Felder der obersten Ebene einsammeln: genau eines, und zwar ein
  // Webhook-Abo — nichts darf im Windschatten mitfahren (auch kein Alias).
  const rumpf = ohneKommentare.slice(ohneKommentare.indexOf('{') + 1)
  const felder: string[] = []
  let tiefe = 0
  let klammer = 0
  for (const [t] of rumpf.matchAll(/[{}()]|[A-Za-z_][A-Za-z0-9_]*/g)) {
    if (t === '{') tiefe++
    else if (t === '}') tiefe--
    else if (t === '(') klammer++
    else if (t === ')') klammer--
    else if (tiefe === 0 && klammer === 0) felder.push(t)
    if (tiefe < 0) break
  }
  return felder.length === 1 && /^webhookSubscription(Create|Update)$/.test(felder[0])
}

/** Laufen die Auslöser (Abgleich, Rückmeldungen)? In „schreiben" und im Probelauf. */
export function ausloeserAktiv(modus: ShopifyModus): boolean {
  return modus !== 'lesen'
}

/**
 * Erkennt eine GraphQL-Mutation am Dokumentanfang. Ein Dokument ohne
 * Operationstyp (`{ shop { … } }`) ist per Spezifikation eine Query;
 * Kommentare vor dem Schlüsselwort werden übersprungen.
 */
export function istMutation(query: string): boolean {
  const ohneKommentare = query.replace(/#[^\n]*/g, '')
  return /^\s*mutation\b/.test(ohneKommentare)
}
