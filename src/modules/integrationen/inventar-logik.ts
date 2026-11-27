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
    // „quantities" bei der absoluten Meldung, „changes" bei der Differenz (0136).
    const i = Math.max(feld.indexOf('quantities'), feld.indexOf('changes'))
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
  /** Zeitpunkt der Änderung laut Shop (0136) — null, wenn der Payload ihn nicht trägt. */
  geaendertAm: Date | null
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
  const zeit = typeof payload.updated_at === 'string' ? new Date(payload.updated_at) : null
  return {
    inventoryItemGid: inventoryItemGid(item as string | number),
    verfuegbar,
    geaendertAm: zeit && !Number.isNaN(zeit.getTime()) ? zeit : null,
  }
}

// --- Buch und Differenz (0136) -------------------------------------------------

/** Ein Shop-Angebot mit Ziel (Kontingent) und Buch. */
export interface AngebotStand {
  inventory_item_gid: string | null
  /** Ziel: das Kontingent dieses Angebots. */
  frei: number
  /** Buch: was der Shop zeigt, wenn alle Bestellungen bekannt sind. null = nie gesetzt. */
  pushed_qty: number | null
  /** Seit wann das Buch läuft. null = es muss erst absolut gesetzt werden. */
  buch_ab: Date | string | null
}

export interface MeldePlan<T> {
  /** Noch nie gemeldet: einmal absolut setzen, danach läuft das Buch. */
  erst: T[]
  /** Differenz < 0 — zuerst senden, damit die Summe nie über dem Bestand liegt. */
  senken: (T & { delta: number })[]
  /** Differenz > 0 — zuletzt. */
  heben: (T & { delta: number })[]
  ohneZuordnung: T[]
}

/**
 * Was ist zu melden? Statt absoluter Mengen die DIFFERENZ zwischen Kontingent
 * und Buch (Entscheidungslog 2026-11-27): ein Kauf, den KRNL noch nicht
 * kennt, hat den Shop schon heruntergezählt — eine Differenz lässt das
 * stehen, eine absolute Menge überschriebe es (Überverkauf). Reihenfolge
 * der Meldung: senken, erstmalig setzen, heben.
 */
export function meldungPlanen<T extends AngebotStand>(angebote: T[]): MeldePlan<T> {
  const plan: MeldePlan<T> = { erst: [], senken: [], heben: [], ohneZuordnung: [] }
  for (const a of angebote) {
    if (!a.inventory_item_gid) {
      plan.ohneZuordnung.push(a)
      continue
    }
    if (a.pushed_qty === null || a.buch_ab === null) {
      plan.erst.push(a)
      continue
    }
    const delta = Math.floor(Number(a.frei)) - Math.round(Number(a.pushed_qty))
    if (delta < 0) plan.senken.push({ ...a, delta })
    else if (delta > 0) plan.heben.push({ ...a, delta })
  }
  return plan
}

/**
 * InventoryAdjustQuantitiesInput einer Differenz-Meldung. changeFromQuantity
 * ist seit 2026-04 Pflicht:
 *
 * - ERHÖHEN mit null („nicht vergleichen"): die Differenz gilt, was immer
 *   der Shop gerade zeigt — ein unbekannter Kauf bleibt abgezogen.
 * - SENKEN mit dem Buchwert (`erwartet`): der Shop senkt nur, wenn er genau
 *   das zeigt, was das Buch sagt. Liegt ein unbekannter Kauf darauf, lehnt
 *   er ab (CHANGE_FROM_QUANTITY_STALE) — sonst wäre die Senkung nur
 *   scheinbar (die Stücke sind schon verkauft), und was mit dem
 *   „freigewordenen" Bestand anderswo erhöht würde, wäre ungedeckt.
 */
export function deltaInput(
  block: { inventory_item_gid: string | null; delta: number; erwartet?: number | null }[],
  locationGid: string,
): Record<string, unknown> {
  return {
    name: 'available',
    reason: 'correction',
    referenceDocumentUri: 'erp://bestandsabgleich',
    changes: block.map((v) => ({
      inventoryItemId: v.inventory_item_gid,
      locationId: locationGid,
      delta: v.delta,
      changeFromQuantity: v.erwartet ?? null,
    })),
  }
}

/**
 * Die Differenz-Mutation. Der Schlüssel der @idempotent-Direktive sorgt
 * dafür, dass eine wiederholte Zustellung desselben Aufrufs die Differenz
 * nicht zweimal bucht.
 */
export const DELTA_MUTATION = `mutation bestandDelta($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
  inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) { userErrors { field message code } }
}`

/** Hat der Shop die Senkung abgelehnt, weil er nicht (mehr) den Buchwert zeigt? */
export function istVeraltet(grund: string): boolean {
  return /CHANGE_FROM_QUANTITY_STALE|stale|changed since|quantity has changed/i.test(grund)
}

/**
 * Wie weit darf erhöht werden (0136)? Erhöhungen sind nur aus Bestand
 * gedeckt, der wirklich frei ist: Pool minus dem, was die Angebote laut Buch
 * schon halten. Hat der Shop eine Senkung abgelehnt, hält das Angebot seinen
 * alten Buchwert — und bindet damit weiter Teile, die anderswo NICHT
 * verteilt werden dürfen. Rückgabe: je Angebot die erlaubte Erhöhung
 * (0 … gewünscht), in der gegebenen Reihenfolge vergeben.
 */
export function erhoehungenImBudget(
  wuensche: { id: string; delta: number }[],
  /** Was jedes Angebot laut Buch aus den Pools hält (Stück, ohne eigenen Vorrat). */
  gehalten: Map<string, number>,
  bedarf: Map<string, { komponente: string; je: number }[]>,
  pool: Map<string, number>,
): Map<string, number> {
  const frei = new Map<string, number>()
  for (const [k, v] of pool) frei.set(k, Math.max(Number(v) || 0, 0))
  for (const [id, stueck] of gehalten) {
    for (const b of bedarf.get(id) ?? []) frei.set(b.komponente, (frei.get(b.komponente) ?? 0) - Math.max(stueck, 0) * b.je)
  }
  const erlaubt = new Map<string, number>()
  for (const w of wuensche) {
    const teile = bedarf.get(w.id) ?? []
    let d = Math.max(Math.floor(w.delta), 0)
    for (const b of teile) {
      if (b.je <= 0) continue
      d = Math.min(d, Math.floor(((frei.get(b.komponente) ?? 0) + 1e-9) / b.je))
    }
    d = Math.max(d, 0)
    erlaubt.set(w.id, d)
    for (const b of teile) frei.set(b.komponente, (frei.get(b.komponente) ?? 0) - d * b.je)
  }
  return erlaubt
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
  block: { inventory_item_gid: string | null; frei: number }[],
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
