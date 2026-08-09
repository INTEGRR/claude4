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
export function zuUebertragen(varianten: VarianteMitBestand[]): {
  melden: VarianteMitBestand[]
  ohneZuordnung: VarianteMitBestand[]
} {
  const melden: VarianteMitBestand[] = []
  const ohneZuordnung: VarianteMitBestand[] = []
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

/** Zerlegt eine Liste in Blöcke — Shopify nimmt höchstens 250 Mengen je Aufruf. */
export function inBloecken<T>(liste: T[], groesse: number): T[][] {
  const bloecke: T[][] = []
  for (let i = 0; i < liste.length; i += groesse) bloecke.push(liste.slice(i, i + groesse))
  return bloecke
}
