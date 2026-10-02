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
 * Produkte, die der Fake auf die Seitenabfrage des Produktimports liefert —
 * in der Reihenfolge der Hinterlegung, eine einzige Seite.
 */
let FAKE_PRODUKTE: unknown[] = []

/** Letzte Variablen je Operation — damit Tests prüfen können, was angefragt wurde. */
const FAKE_AUFRUFE = new Map<string, Record<string, unknown>>()

export function fakeLetzterAufruf(operation: string): Record<string, unknown> | undefined {
  return FAKE_AUFRUFE.get(operation)
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

  const antwort = (() => {
    // Beide Order-Anfragen beginnen mit `order(id:)` — unterschieden wird
    // am angefragten Feld, nicht am Operationsnamen.
    if (query.includes('fulfillmentOrders(')) {
      // fetchFulfillmentOrders: ein offenes Fulfillment ohne Positionsliste —
      // die Jobs werten das als Voll-Fulfillment (every() über leer = true).
      return {
        order: {
          fulfillmentOrders: {
            nodes: [
              {
                id: 'gid://shopify/FulfillmentOrder/1',
                status: 'OPEN',
                supportedActions: [{ action: 'CREATE_FULFILLMENT' }],
                lineItems: { nodes: [] },
              },
            ],
          },
        },
      }
    }
    if (op === 'order' && query.includes('displayFinancialStatus')) {
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
        return { inventorySetQuantities: { userErrors } }
      }
      case 'tagsAdd':
        return { tagsAdd: { userErrors: [] } }
      case 'locations':
        return { locations: { nodes: [{ id: 'gid://shopify/Location/1', name: 'Lager (Fake)', isActive: true }] } }
      case 'nodes': {
        // Varianten wie im echten Shop: InventoryItem, Produkt, und für
        // Tastaturen anfangs ohne Mengenverfolgung (so war es bei ANVIL).
        const ids = (variables.ids as string[] | undefined) ?? []
        return {
          nodes: ids.map((id) => {
            const nr = id.split('/').pop()
            return {
              id,
              inventoryItem: { id: `gid://shopify/InventoryItem/${nr}`, tracked: false },
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
