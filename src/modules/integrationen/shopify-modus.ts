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
 * Durchgesetzt wird der Modus an EINER Naht — shopifyGraphQL() weist jede
 * Mutation ab —, nicht je Aufrufer. Entscheidungslog 2026-09-18.
 */

export type ShopifyModus = 'lesen' | 'schreiben'

export const SHOPIFY_MODUS_STANDARD: ShopifyModus = 'lesen'

export async function shopifyModus(db: Sql | TransactionSql): Promise<ShopifyModus> {
  const [row] = await db<{ modus: string | null }[]>`
    select value ->> 'modus' as modus from settings where key = 'shopify'`
  return row?.modus === 'schreiben' ? 'schreiben' : SHOPIFY_MODUS_STANDARD
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
