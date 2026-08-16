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

export async function fakeShopifyGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const op = operation(query)

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
    if (query.includes('displayFinancialStatus')) {
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
      case 'tagsAdd':
        return { tagsAdd: { userErrors: [] } }
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
