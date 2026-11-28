import 'server-only'

/**
 * Deterministischer Shopify-Ersatz für Prozesstests und Staging
 * (SHOPIFY_FAKE=1). Antwortet an derselben Naht wie der echte Dienst — der
 * GraphQL-Kapselung in shopify.ts — und deckt genau die Operationen ab, die
 * die Outbox-Jobs verwenden. Eine unbekannte Operation wirft laut, statt
 * still Unsinn zu liefern: wer einen neuen Aufruf einbaut, erweitert den
 * Fake im selben Zug.
 */

function operation(query: string): string {
  const treffer = query.match(/^\s*(?:query|mutation)?\s*(?:\w+\s*)?\(?[^{]*\{\s*(\w+)/)
  return treffer?.[1] ?? 'unbekannt'
}

/**
 * Bestellungen, die der Fake auf fetchOrder-Anfragen liefert — hinterlegt
 * von den Prozess-Fixtures (der echte Webhook-Payload wird beim Import
 * verworfen, die Wahrheit kommt immer aus fetchOrder).
 */
const FAKE_BESTELLUNGEN = new Map<string, { id: string }>()

export function fakeOrderHinterlegen(order: { id: string }): void {
  FAKE_BESTELLUNGEN.set(order.id, order)
}

/** Eine hinterlegte Bestellung (z. B. um sie storniert neu zu hinterlegen). */
export function fakeOrderHolen(id: string): ({ id: string } & Record<string, unknown>) | undefined {
  return FAKE_BESTELLUNGEN.get(id) as ({ id: string } & Record<string, unknown>) | undefined
}

/** Alle hinterlegten Bestellungen vergessen (Tests mit eigenem Bestand). */
export function fakeBestellungenLeeren(): void {
  FAKE_BESTELLUNGEN.clear()
}

/**
 * Fulfillment-Halt je Bestellung (0134) — ohne Eintrag ist nichts
 * angehalten. `null` als Wert stellt das fehlende Recht nach: die Abfrage
 * wirft wie der echte Shop bei ACCESS_DENIED.
 */
const FAKE_HALT = new Map<string, { reason: string; reasonNotes: string | null }[] | null>()

export function fakeHaltSetzen(
  orderGid: string,
  holds: { reason: string; reasonNotes: string | null }[] | null | undefined,
): void {
  if (holds === undefined) FAKE_HALT.delete(orderGid)
  else FAKE_HALT.set(orderGid, holds)
}

/** Bestand je InventoryItem, wie ihn der Shop führte (0136). */
const FAKE_BESTAND = new Map<string, number>()
const FAKE_SCHLUESSEL = new Set<string>()

export function fakeBestand(inventoryItemGid: string): number | undefined {
  return FAKE_BESTAND.get(inventoryItemGid)
}

/** Alle geführten Bestände — für Summenprüfungen über viele Angebote. */
export function fakeBestaende(): Map<string, number> {
  return new Map(FAKE_BESTAND)
}

/**
 * Ein Kauf im Shop: Shopify zählt sofort herunter — lange bevor KRNL die
 * Bestellung sieht. false = ausverkauft (nicht weiterverkaufen).
 */
export function fakeKauf(inventoryItemGid: string, menge = 1): boolean {
  const da = FAKE_BESTAND.get(inventoryItemGid) ?? 0
  if (da < menge) return false
  FAKE_BESTAND.set(inventoryItemGid, da - menge)
  return true
}

/** Bestand von Hand setzen — wie eine Änderung im Shop-Admin. */
export function fakeBestandSetzen(inventoryItemGid: string, menge: number): void {
  FAKE_BESTAND.set(inventoryItemGid, menge)
}

export function fakeBestandLeeren(): void {
  FAKE_BESTAND.clear()
  FAKE_SCHLUESSEL.clear()
}

/**
 * Produkte, die der Fake auf die Seitenabfrage des Produktimports liefert —
 * in der Reihenfolge der Hinterlegung, eine einzige Seite.
 */
let FAKE_PRODUKTE: unknown[] = []

/** Letzte Variablen je Operation — damit Tests prüfen können, was angefragt wurde. */
const FAKE_AUFRUFE = new Map<string, Record<string, unknown>>()

export function fakeLetzterAufruf(operation: string): Record<string, unknown> | undefined {
  return FAKE_AUFRUFE.get(operation)
}

/** Wie oft eine Operation aufgerufen wurde — damit Tests zeigen können, was ein Ablauf an Shop-Aufrufen kostet. */
const FAKE_ZAEHLER = new Map<string, number>()

export function fakeAufrufZahl(operation: string): number {
  return FAKE_ZAEHLER.get(operation) ?? 0
}

export function fakeAufrufeLeeren(): void {
  FAKE_ZAEHLER.clear()
}

/** Shop-Stand der Varianten (productVariants) — für den Vergleich Ist/Soll. */
let FAKE_SHOP_STAND: unknown[] = []

export function fakeShopStandHinterlegen(varianten: unknown[]): void {
  FAKE_SHOP_STAND = varianten
}

export function fakeProdukteHinterlegen(produkte: unknown[]): void {
  FAKE_PRODUKTE = produkte
}

export async function fakeShopifyGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const op = operation(query)
  FAKE_AUFRUFE.set(op, variables)
  FAKE_ZAEHLER.set(op, (FAKE_ZAEHLER.get(op) ?? 0) + 1)

  const antwort = (() => {
    // Beide Order-Anfragen beginnen mit `order(id:)` — unterschieden wird
    // am angefragten Feld, nicht am Operationsnamen.
    if (op === 'fulfillmentOrder') {
      // fetchOrderGidZuFulfillmentOrder: die Kennung trägt die Bestellnummer
      // („…/FulfillmentOrder/<Order-Nr>") — so findet der Halt-Webhook heim.
      const nr = String(variables.id).split('/').pop()
      return { fulfillmentOrder: { order: { id: `gid://shopify/Order/${nr}` } } }
    }
    if (query.includes('fulfillmentHolds')) {
      // fetchOrderHalt: der hinterlegte Halt der Bestellung.
      const id = String(variables.id)
      const holds = FAKE_HALT.get(id)
      if (holds === null) throw new Error('Access denied for fulfillmentOrders field.')
      const bestellung = FAKE_BESTELLUNGEN.get(id) as
        | { displayFulfillmentStatus?: string; displayFinancialStatus?: string }
        | undefined
      return {
        order: {
          displayFinancialStatus: bestellung?.displayFinancialStatus ?? null,
          displayFulfillmentStatus: holds?.length ? 'ON_HOLD' : (bestellung?.displayFulfillmentStatus ?? 'UNFULFILLED'),
          fulfillmentOrders: {
            nodes: [{
              id: 'gid://shopify/FulfillmentOrder/1',
              status: holds?.length ? 'ON_HOLD' : 'OPEN',
              fulfillmentHolds: holds ?? [],
            }],
          },
        },
      }
    }
    if (query.includes('fulfillmentOrders(')) {
      // fetchFulfillmentOrders: ein offenes Fulfillment ohne Positionsliste —
      // die Jobs werten das als Voll-Fulfillment (every() über leer = true).
      // Angehalten (0134): wie im echten Shop ohne CREATE_FULFILLMENT.
      const gehalten = Boolean(FAKE_HALT.get(String(variables.id))?.length)
      return {
        order: {
          fulfillmentOrders: {
            nodes: [
              {
                id: 'gid://shopify/FulfillmentOrder/1',
                status: gehalten ? 'ON_HOLD' : 'OPEN',
                supportedActions: [{ action: gehalten ? 'RELEASE_HOLD' : 'CREATE_FULFILLMENT' }],
                lineItems: { nodes: [] },
              },
            ],
          },
        },
      }
    }
    if (op === 'order' && query.includes('lineItems')) {
      // fetchOrder: die von der Fixture hinterlegte Bestellung (oder null).
      return { order: FAKE_BESTELLUNGEN.get(String(variables.id)) ?? null }
    }
    switch (op) {
      case 'fulfillmentCreate':
        return {
          fulfillmentCreate: {
            fulfillment: { id: 'gid://shopify/Fulfillment/1', status: 'SUCCESS' },
            userErrors: [],
          },
        }
      case 'fulfillmentTrackingInfoUpdate':
        return { fulfillmentTrackingInfoUpdate: { userErrors: [] } }
      case 'inventorySetQuantities': {
        // Wie der echte Shop seit 2026-07: changeFromQuantity ist in jedem
        // Eintrag Pflicht (null erlaubt = kein Vergleich), und die Mutation
        // braucht die @idempotent-Direktive mit Schlüssel. Beide Lücken haben
        // in Prod je einen Schwung Bestandsabgleiche scheitern lassen.
        const input = variables.input as
          | { quantities?: Record<string, unknown>[] }
          | undefined
        if ((input?.quantities ?? []).some((q) => !('changeFromQuantity' in q))) {
          throw new Error(
            'InventoryQuantityInput must include the following argument: changeFromQuantity.',
          )
        }
        if (!/@idempotent\s*\(/.test(query) || typeof variables.idempotencyKey !== 'string') {
          throw new Error(
            'The @idempotent directive is required for this mutation but was not provided.',
          )
        }
        // Ein InventoryItem, das am Standort nicht geführt wird (Kennung endet
        // auf 404404): Shopify lehnt die GANZE Mutation ab und nennt den Index
        // im Feldpfad — für den Nachweis, dass ein Zweitangebot die Artikel
        // nicht blockiert (0106).
        const userErrors = (input?.quantities ?? []).flatMap((q, i) =>
          String(q.inventoryItemId ?? '').endsWith('404404')
            ? [{ field: ['input', 'quantities', String(i), 'inventoryItemId'], message: 'The specified inventory item is not stocked at the location.' }]
            : [],
        )
        // Der Fake führt den Bestand je InventoryItem mit (0136) — so lässt
        // sich prüfen, was nach absoluten Meldungen, Differenzen und
        // „Käufen" (fakeKauf) wirklich im Shop stünde.
        if (userErrors.length === 0) {
          for (const q of input?.quantities ?? []) FAKE_BESTAND.set(String(q.inventoryItemId), Number(q.quantity))
        }
        return { inventorySetQuantities: { userErrors } }
      }
      case 'inventoryAdjustQuantities': {
        // Differenz-Meldung (0136): dieselben Pflichten wie die absolute —
        // changeFromQuantity in jedem Eintrag, @idempotent mit Schlüssel.
        const input = variables.input as { changes?: Record<string, unknown>[] } | undefined
        if ((input?.changes ?? []).some((q) => !('changeFromQuantity' in q))) {
          throw new Error('InventoryChangeInput must include the following argument: changeFromQuantity.')
        }
        if (!/@idempotent\s*\(/.test(query) || typeof variables.idempotencyKey !== 'string') {
          throw new Error('The @idempotent directive is required for this mutation but was not provided.')
        }
        // Derselbe Schlüssel zweimal: Shopify bucht nur einmal.
        if (FAKE_SCHLUESSEL.has(String(variables.idempotencyKey))) {
          return { inventoryAdjustQuantities: { userErrors: [] } }
        }
        const userErrors = (input?.changes ?? []).flatMap((q, i) => {
          if (String(q.inventoryItemId ?? '').endsWith('404404')) {
            return [{ field: ['input', 'changes', String(i), 'inventoryItemId'], message: 'The specified inventory item is not stocked at the location.', code: 'ITEM_NOT_STOCKED_AT_LOCATION' }]
          }
          // Compare-and-Swap: mit Vergleichswert bucht der Shop nur, wenn er genau diesen Stand zeigt.
          const erwartet = q.changeFromQuantity
          if (typeof erwartet === 'number' && (FAKE_BESTAND.get(String(q.inventoryItemId)) ?? 0) !== erwartet) {
            return [{ field: ['input', 'changes', String(i), 'changeFromQuantity'], message: 'The quantity has changed since it was last read.', code: 'CHANGE_FROM_QUANTITY_STALE' }]
          }
          return []
        })
        if (userErrors.length === 0) {
          FAKE_SCHLUESSEL.add(String(variables.idempotencyKey))
          for (const q of input?.changes ?? []) {
            const id = String(q.inventoryItemId)
            FAKE_BESTAND.set(id, (FAKE_BESTAND.get(id) ?? 0) + Number(q.delta))
          }
        }
        return { inventoryAdjustQuantities: { userErrors } }
      }
      case 'tagsAdd':
        return { tagsAdd: { userErrors: [] } }
      case 'locations':
        return { locations: { nodes: [{ id: 'gid://shopify/Location/1', name: 'Lager (Fake)', isActive: true }] } }
      case 'nodes': {
        // Varianten wie im echten Shop: InventoryItem, Produkt, und für
        // Tastaturen anfangs ohne Mengenverfolgung (so war es bei ANVIL).
        const ids = (variables.ids as string[] | undefined) ?? []
        // fetchOrders (S4): mehrere Bestellungen in einem Aufruf.
        if (ids.some((id) => id.includes('/Order/'))) {
          return { nodes: ids.map((id) => FAKE_BESTELLUNGEN.get(id) ?? null) }
        }
        return {
          nodes: ids.map((id) => {
            const nr = id.split('/').pop()
            return {
              id,
              inventoryItem: { id: `gid://shopify/InventoryItem/${nr}`, tracked: false },
              // Was der Shop gerade anbietet (0136) — für die gesättigte Senkung.
              inventoryQuantity: FAKE_BESTAND.get(`gid://shopify/InventoryItem/${nr}`) ?? 0,
              product: { id: `gid://shopify/Product/${nr}` },
              inventoryPolicy: 'CONTINUE',
            }
          }),
        }
      }
      case 'productVariants':
        return { productVariants: { nodes: FAKE_SHOP_STAND, pageInfo: { hasNextPage: false, endCursor: null } } }
      case 'productVariantsBulkUpdate':
        return { productVariantsBulkUpdate: { userErrors: [] } }
      case 'customers':
        return { customers: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }
      case 'orders': {
        // Seitenweise wie der echte Shop (50 je Seite, Cursor = Position):
        // die hinterlegten Bestellungen, nach updatedAt aufsteigend.
        const alle = [...FAKE_BESTELLUNGEN.values()].sort((a, b) =>
          String((a as { updatedAt?: string }).updatedAt ?? '').localeCompare(
            String((b as { updatedAt?: string }).updatedAt ?? ''),
          ),
        )
        const ab = variables.after ? Number(variables.after) : 0
        const seite = alle.slice(ab, ab + 50)
        const weiter = ab + 50 < alle.length
        return {
          orders: {
            nodes: seite,
            pageInfo: { hasNextPage: weiter, endCursor: weiter ? String(ab + 50) : null },
          },
        }
      }
      case 'products':
        return { products: { nodes: FAKE_PRODUKTE, pageInfo: { hasNextPage: false, endCursor: null } } }
      case 'node':
        // aktualisiereProduktAusShopify: ein einzelnes hinterlegtes Produkt.
        return { node: (FAKE_PRODUKTE as { id?: string }[]).find((x) => x.id === variables.id) ?? null }
      default:
        return null
    }
  })()

  const { logTransaction } = await import('./transaktionen')
  await logTransaction({
    system: 'shopify',
    kind: `fake:${op}`,
    request: { variables },
    response: antwort,
    ok: antwort !== null,
    error: antwort === null ? `Shopify-Fake kennt die Operation „${op}" nicht` : undefined,
  })

  if (antwort === null) {
    // Bewusst kein ShopifyError-Import (hielte den Fake aus dem Modulgraphen
    // des echten Clients heraus) — nicht wiederholbar ist der Fehler ohnehin.
    throw new Error(
      `Shopify-Fake kennt die Operation „${op}" nicht — bitte in shopify-fake.ts ergänzen.`,
    )
  }
  return antwort as T
}
