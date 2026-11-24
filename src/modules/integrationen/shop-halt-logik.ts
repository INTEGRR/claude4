/**
 * Fulfillment-Halt aus Shopify (0134) — reine Logik, ohne Datenbank und
 * ohne Netz. Der Halt wird nur im Shop gesetzt und aufgehoben; KRNL liest
 * ihn mit und sperrt den Versand (Entscheidungslog 2026-11-24).
 */

/** Was Shopify je Fulfillment-Auftrag zum Halt meldet. */
export interface ShopFulfillmentHalt {
  status: string
  fulfillmentHolds: { reason: string; reasonNotes: string | null }[]
}

/** Der Halt, wie er am Auftrag steht. */
export interface ShopHalt {
  grund: string
  notiz: string | null
}

/** Shopifys Halt-Gründe in Betriebsdeutsch. */
const GRUND: Record<string, string> = {
  AWAITING_PAYMENT: 'Zahlung ausstehend',
  AWAITING_RETURN_ITEMS: 'Wartet auf Rücksendung',
  HIGH_RISK_OF_FRAUD: 'Betrugsverdacht',
  INCORRECT_ADDRESS: 'Adresse falsch',
  INVENTORY_OUT_OF_STOCK: 'Nicht auf Lager',
  ONLINE_STORE_POST_PURCHASE_CROSS_SELL: 'Zusatzangebot nach dem Kauf läuft',
  OTHER: 'Sonstiges',
  UNKNOWN_DELIVERY_DATE: 'Liefertermin unbekannt',
}

export function haltGrundText(reason: string): string {
  return GRUND[reason] ?? reason
}

function eindeutig(werte: (string | null | undefined)[]): string[] {
  return [...new Set(werte.map((w) => (w ?? '').trim()).filter(Boolean))]
}

/**
 * Der Halt einer Bestellung laut Shop — null = nicht angehalten.
 *
 * `auftraege` sind die Fulfillment-Aufträge der Bestellung; angehalten ist
 * sie, sobald EINER davon auf ON_HOLD steht (auch ein Teil-Halt sperrt die
 * ganze Lieferung — KRNL versendet eine Bestellung nicht in Stücken am
 * Halt vorbei). `null` heißt: die Einzelheiten waren nicht lesbar (Recht
 * fehlt, Shop nicht erreichbar) — dann entscheidet der Anzeige-Status der
 * Bestellung, nur eben ohne Grund und Notiz.
 */
export function haltAusShop(
  anzeigeStatus: string | null,
  auftraege: ShopFulfillmentHalt[] | null,
): ShopHalt | null {
  if (auftraege === null) {
    return anzeigeStatus === 'ON_HOLD' ? { grund: 'In Shopify angehalten', notiz: null } : null
  }
  const gehalten = auftraege.filter((a) => a.status === 'ON_HOLD')
  if (gehalten.length === 0) return null
  const holds = gehalten.flatMap((a) => a.fulfillmentHolds)
  const gruende = eindeutig(holds.map((h) => haltGrundText(h.reason)))
  const notizen = eindeutig(holds.map((h) => h.reasonNotes))
  return {
    grund: gruende.join(' · ') || 'In Shopify angehalten',
    notiz: notizen.join(' · ') || null,
  }
}

/** „Sonstiges: Kabel beilegen" — Grund und Notiz in einer Zeile. */
export function haltText(halt: { grund: string | null; notiz: string | null }): string {
  return [halt.grund, halt.notiz].filter(Boolean).join(': ') || 'ohne Angabe'
}

/** Hat sich am Auftrag etwas zu ändern? */
export function haltAenderung(
  vorher: { halt: boolean; grund: string | null; notiz: string | null },
  jetzt: ShopHalt | null,
): 'gesetzt' | 'geaendert' | 'aufgehoben' | null {
  if (!jetzt) return vorher.halt ? 'aufgehoben' : null
  if (!vorher.halt) return 'gesetzt'
  return vorher.grund !== jetzt.grund || vorher.notiz !== jetzt.notiz ? 'geaendert' : null
}
