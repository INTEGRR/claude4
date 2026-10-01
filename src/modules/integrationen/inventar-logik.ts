/**
 * Bestandsabgleich mit Shopify — der rechnende Teil, ohne Datenbank und ohne
 * Netz, damit er sich direkt testen lässt. Die Orchestrierung (GraphQL,
 * State-Tabelle) liegt in inventar.ts.
 */

export interface VarianteMitBestand {
  variant_id: string
  sku: string | null
  inventory_item_gid: string | null
  /** frei verfügbare Menge im ERP (Bestand minus Reservierungen) */
  frei: number
  /** zuletzt an den Shop gemeldete Menge, null = noch nie gemeldet */
  pushed_qty: number | null
}

/**
 * Welche Varianten müssen an den Shop gemeldet werden?
 *
 * Gemeldet wird, was sich seit der letzten Meldung geändert hat oder noch nie
 * gemeldet wurde. Varianten ohne InventoryItem-Zuordnung können nicht
 * gemeldet werden und werden getrennt zurückgegeben, damit der Aufrufer die
 * Zuordnung nachholen kann statt sie still zu verlieren.
 */
export function zuUebertragen<T extends VarianteMitBestand>(varianten: T[]): {
  melden: T[]
  ohneZuordnung: T[]
} {
  const melden: T[] = []
  const ohneZuordnung: T[] = []
  for (const v of varianten) {
    if (!v.inventory_item_gid) {
      ohneZuordnung.push(v)
      continue
    }
    // Shopify führt Bestände ganzzahlig; gemeldet wird abgerundet — lieber
    // ein Stück zu wenig anbieten als eines verkaufen, das halb fehlt.
    if (v.pushed_qty === null || Math.floor(v.frei) !== Math.floor(v.pushed_qty)) {
      melden.push(v)
    }
  }
  return { melden, ohneZuordnung }
}

// --- Zweitangebote (0106) ------------------------------------------------------

/**
 * Ein Zweitangebot: weiteres Shop-Angebot mit der SKU eines Artikels
 * (Bundle-Bestandteil, Aktions-Edition). Es meldet wie eine Variante — an
 * sein EIGENES InventoryItem, mit der Soll-Menge des Artikels
 * (shopify_soll_menge_zweitangebot: auto/immer/aus je Angebot).
 */
export interface AngebotMitBestand extends VarianteMitBestand {
  angebot_id: string
  /** Titel des Shop-Angebots, z. B. „ANVIL NATIVE 75 - Black Week Editions". */
  produkt: string
  /** Zuletzt von Shopify abgelehnte Menge — erst eine neue Menge versucht es erneut. */
  push_fehler_qty: number | null
}

/**
 * Welche Zweitangebote müssen gemeldet werden? Wie zuUebertragen — ohne die,
 * deren Menge Shopify schon einmal abgelehnt hat (sonst hagelte es bei jedem
 * Abgleich dieselbe Ablehnung). Ändert sich die Menge, wird neu versucht.
 */
export function angeboteZuMelden<T extends AngebotMitBestand>(angebote: T[]): { melden: T[]; ohneZuordnung: T[] } {
  const { melden, ohneZuordnung } = zuUebertragen(angebote)
  return {
    melden: melden.filter(
      (a) => a.push_fehler_qty === null || Math.floor(Number(a.push_fehler_qty)) !== Math.floor(a.frei),
    ),
    ohneZuordnung,
  }
}

/**
 * Ordnet die userErrors einer Bestandsmeldung den Positionen zu: Shopify
 * nennt im Feldpfad den Index der Menge (["input", "quantities", "2",
 * "inventoryItemId"]). Ein Fehler ohne verwertbaren Index trifft alle
 * Positionen — dann weiß niemand, welche schuld ist.
 */
export function fehlerJePosition(
  anzahl: number,
  userErrors: { field: string[] | null; message: string }[],
): Map<number, string> {
  const ergebnis = new Map<number, string>()
  for (const fehler of userErrors) {
    const feld = fehler.field ?? []
    const i = feld.indexOf('quantities')
    const index = i >= 0 ? Number(feld[i + 1]) : Number.NaN
    const ziele = Number.isInteger(index) && index >= 0 && index < anzahl ? [index] : [...Array(anzahl).keys()]
    for (const z of ziele) {
      ergebnis.set(z, ergebnis.has(z) ? `${ergebnis.get(z)}; ${fehler.message}` : fehler.message)
    }
  }
  return ergebnis
}

/** Shopify meldet numerische IDs; die Admin-API arbeitet mit GIDs. */
export function inventoryItemGid(id: string | number): string {
  const s = String(id)
  return s.startsWith('gid://') ? s : `gid://shopify/InventoryItem/${s}`
}

export interface InventarMeldung {
  inventoryItemGid: string
  verfuegbar: number
}

/**
 * Liest den Webhook `inventory_levels/update`. Shopify sendet dort
 * inventory_item_id, location_id und available. Alles andere (connect,
 * disconnect, fremde Felder) ergibt null und wird übersprungen.
 */
export function deuteInventarPayload(payload: Record<string, unknown>): InventarMeldung | null {
  const item = payload.inventory_item_id
  const verfuegbar = payload.available
  if (item === undefined || item === null) return null
  if (typeof verfuegbar !== 'number' || !Number.isFinite(verfuegbar)) return null
  return { inventoryItemGid: inventoryItemGid(item as string | number), verfuegbar }
}

/**
 * Baut den InventorySetQuantitiesInput einer Meldung. Seit API 2026-07 ist
 * changeFromQuantity in JEDEM Eintrag Pflicht: eine Zahl aktiviert
 * Compare-and-Swap, explizites null überspringt den Vergleich. Wir senden
 * null — das ERP ist die Quelle der Wahrheit. Das Feld schlicht WEGLASSEN
 * lehnt Shopify ab („InventoryQuantityInput must include the following
 * argument: changeFromQuantity").
 */
export function bestandsInput(
  block: VarianteMitBestand[],
  locationGid: string,
): Record<string, unknown> {
  return {
    name: 'available',
    reason: 'correction',
    referenceDocumentUri: 'erp://bestandsabgleich',
    quantities: block.map((v) => ({
      inventoryItemId: v.inventory_item_gid,
      locationId: locationGid,
      quantity: Math.floor(v.frei),
      changeFromQuantity: null,
    })),
  }
}

/**
 * Die Mutation der Bestandsmeldung. Seit 2026-04 erzwingt Shopify für
 * Inventur- und Refund-Mutationen die @idempotent-Direktive mit eindeutigem
 * Schlüssel — zur LAUFZEIT, im Schema ist sie unsichtbar („The @idempotent
 * directive is required for this mutation"). Je Aufruf kommt ein frischer
 * UUID-Schlüssel mit; da absolute Mengen GESETZT werden, wäre selbst eine
 * Wiederholung folgenlos.
 */
export const INVENTAR_MUTATION = `mutation bestand($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
  inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) { userErrors { field message } }
}`

/** Zerlegt eine Liste in Blöcke — Shopify nimmt höchstens 250 Mengen je Aufruf. */
export function inBloecken<T>(liste: T[], groesse: number): T[][] {
  const bloecke: T[][] = []
  for (let i = 0; i < liste.length; i += groesse) bloecke.push(liste.slice(i, i + groesse))
  return bloecke
}
