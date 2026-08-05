import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Shopify Admin API (GraphQL). Die REST-API ist Legacy; alles läuft über
 * GraphQL gegen die in SHOPIFY_API_VERSION gepinnte Version.
 */

export interface ShopifyConfig {
  shop: string
  token: string
  apiVersion: string
  webhookSecret: string
}

export function shopifyConfig(): ShopifyConfig {
  return {
    shop: process.env.SHOPIFY_SHOP_DOMAIN ?? '',
    token: process.env.SHOPIFY_ADMIN_TOKEN ?? '',
    apiVersion: process.env.SHOPIFY_API_VERSION ?? '2026-07',
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET ?? '',
  }
}

export function shopifyConfigured(): boolean {
  const c = shopifyConfig()
  return Boolean(c.shop && c.token)
}

/**
 * Prüft die Webhook-Signatur gegen den ROHEN Request-Body. Wichtig: der Body
 * darf vorher nicht geparst werden, sonst stimmt der HMAC nicht mehr.
 */
export function verifyWebhookHmac(rawBody: string, headerHmac: string | null): boolean {
  const secret = shopifyConfig().webhookSecret
  if (!secret || !headerHmac) return false

  const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest()
  let received: Buffer
  try {
    received = Buffer.from(headerHmac, 'base64')
  } catch {
    return false
  }
  return digest.length === received.length && timingSafeEqual(digest, received)
}

export class ShopifyError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'ShopifyError'
  }
}

interface GraphQLResponse<T> {
  data?: T
  errors?: { message: string; extensions?: { code?: string } }[]
}

export async function shopifyGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const c = shopifyConfig()
  if (!c.shop || !c.token) throw new ShopifyError('Shopify ist nicht konfiguriert', false)

  const res = await fetch(`https://${c.shop}/admin/api/${c.apiVersion}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': c.token,
    },
    body: JSON.stringify({ query, variables }),
  })

  // 429/5xx sind vorübergehend - der Job-Runner versucht es später erneut.
  if (res.status === 429 || res.status >= 500) {
    throw new ShopifyError(`Shopify antwortete mit ${res.status}`, true)
  }
  if (!res.ok) {
    throw new ShopifyError(`Shopify antwortete mit ${res.status}: ${await res.text()}`, false)
  }

  const body = (await res.json()) as GraphQLResponse<T>
  if (body.errors?.length) {
    const throttled = body.errors.some((e) => e.extensions?.code === 'THROTTLED')
    throw new ShopifyError(body.errors.map((e) => e.message).join('; '), throttled)
  }
  if (!body.data) throw new ShopifyError('Shopify lieferte keine Daten', true)
  return body.data
}

// --- Orders lesen ----------------------------------------------------------

export interface ShopifyOrder {
  id: string
  name: string
  createdAt: string
  email: string | null
  tags: string[]
  displayFinancialStatus: string | null
  displayFulfillmentStatus: string | null
  cancelledAt: string | null
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } }
  customer: { id: string; firstName: string | null; lastName: string | null; email: string | null } | null
  shippingAddress: {
    name: string | null
    address1: string | null
    address2: string | null
    zip: string | null
    city: string | null
    countryCodeV2: string | null
    phone: string | null
  } | null
  lineItems: {
    nodes: {
      id: string
      title: string
      sku: string | null
      currentQuantity: number
      quantity: number
      variant: { id: string } | null
      originalUnitPriceSet: { shopMoney: { amount: string } }
    }[]
  }
}

const ORDER_FIELDS = `
  id
  name
  createdAt
  email
  tags
  displayFinancialStatus
  displayFulfillmentStatus
  cancelledAt
  totalPriceSet { shopMoney { amount currencyCode } }
  customer { id firstName lastName email }
  shippingAddress { name address1 address2 zip city countryCodeV2 phone }
  lineItems(first: 100) {
    nodes {
      id title sku currentQuantity quantity
      variant { id }
      originalUnitPriceSet { shopMoney { amount } }
    }
  }
`

export async function fetchOrder(gid: string): Promise<ShopifyOrder | null> {
  const data = await shopifyGraphQL<{ order: ShopifyOrder | null }>(
    `query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`,
    { id: gid },
  )
  return data.order
}

/**
 * Holt Orders, die seit `since` geändert wurden - das Sicherheitsnetz gegen
 * verlorene Webhooks (Shopify garantiert keine Zustellung).
 */
export async function fetchOrdersUpdatedSince(
  since: Date,
  limit = 50,
): Promise<ShopifyOrder[]> {
  const query = `updated_at:>'${since.toISOString()}'`
  const out: ShopifyOrder[] = []
  let cursor: string | null = null

  do {
    const data: {
      orders: { nodes: ShopifyOrder[]; pageInfo: { hasNextPage: boolean; endCursor: string } }
    } = await shopifyGraphQL(
      `query($q: String!, $after: String) {
         orders(first: 50, query: $q, after: $after, sortKey: UPDATED_AT) {
           nodes { ${ORDER_FIELDS} }
           pageInfo { hasNextPage endCursor }
         }
       }`,
      { q: query, after: cursor },
    )
    out.push(...data.orders.nodes)
    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null
  } while (cursor && out.length < limit)

  return out
}

// --- Fulfillment schreiben -------------------------------------------------

export interface FulfillmentOrderInfo {
  id: string
  status: string
  supportedActions: { action: string }[]
  lineItems: {
    nodes: { id: string; remainingQuantity: number; lineItem: { id: string; sku: string | null } }[]
  }
}

export async function fetchFulfillmentOrders(orderGid: string): Promise<FulfillmentOrderInfo[]> {
  const data = await shopifyGraphQL<{
    order: { fulfillmentOrders: { nodes: FulfillmentOrderInfo[] } } | null
  }>(
    `query($id: ID!) {
       order(id: $id) {
         fulfillmentOrders(first: 20) {
           nodes {
             id status
             supportedActions { action }
             lineItems(first: 100) {
               nodes { id remainingQuantity lineItem { id sku } }
             }
           }
         }
       }
     }`,
    { id: orderGid },
  )
  return data.order?.fulfillmentOrders.nodes ?? []
}

export interface TrackingInfo {
  company: string
  number: string
  url?: string
}

/**
 * Erzeugt das Fulfillment mit Tracking. `notifyCustomer: true` löst Shopifys
 * Versandbestätigung an den Kunden aus (Shopify-Default wäre false).
 */
export async function createFulfillment(
  fulfillmentOrderId: string,
  tracking: TrackingInfo,
  lineItems?: { id: string; quantity: number }[],
): Promise<string> {
  const data = await shopifyGraphQL<{
    fulfillmentCreate: {
      fulfillment: { id: string; status: string } | null
      userErrors: { field: string[]; message: string }[]
    }
  }>(
    `mutation($fulfillment: FulfillmentInput!) {
       fulfillmentCreate(fulfillment: $fulfillment) {
         fulfillment { id status }
         userErrors { field message }
       }
     }`,
    {
      fulfillment: {
        lineItemsByFulfillmentOrder: [
          {
            fulfillmentOrderId,
            ...(lineItems?.length
              ? {
                  fulfillmentOrderLineItems: lineItems.map((l) => ({
                    id: l.id,
                    quantity: l.quantity,
                  })),
                }
              : {}),
          },
        ],
        trackingInfo: {
          company: tracking.company,
          number: tracking.number,
          ...(tracking.url ? { url: tracking.url } : {}),
        },
        notifyCustomer: true,
      },
    },
  )

  const result = data.fulfillmentCreate
  if (result.userErrors.length) {
    const msg = result.userErrors.map((e) => e.message).join('; ')
    // Bestandsprobleme lösen sich nicht von selbst - nicht endlos wiederholen.
    const permanent = /nonFulfillable|not fulfillable|location/i.test(msg)
    throw new ShopifyError(`Fulfillment abgelehnt: ${msg}`, !permanent)
  }
  if (!result.fulfillment) throw new ShopifyError('Shopify lieferte kein Fulfillment', true)
  return result.fulfillment.id
}

export async function updateTrackingInfo(
  fulfillmentId: string,
  tracking: TrackingInfo,
): Promise<void> {
  const data = await shopifyGraphQL<{
    fulfillmentTrackingInfoUpdate: { userErrors: { message: string }[] }
  }>(
    `mutation($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!) {
       fulfillmentTrackingInfoUpdate(
         fulfillmentId: $fulfillmentId
         trackingInfoInput: $trackingInfoInput
         notifyCustomer: true
       ) { userErrors { message } }
     }`,
    {
      fulfillmentId,
      trackingInfoInput: {
        company: tracking.company,
        number: tracking.number,
        ...(tracking.url ? { url: tracking.url } : {}),
      },
    },
  )
  const errors = data.fulfillmentTrackingInfoUpdate.userErrors
  if (errors.length) throw new ShopifyError(errors.map((e) => e.message).join('; '), true)
}

/** Fügt Tags hinzu, ohne bestehende zu überschreiben (anders als orderUpdate). */
export async function addOrderTags(orderGid: string, tags: string[]): Promise<void> {
  const data = await shopifyGraphQL<{ tagsAdd: { userErrors: { message: string }[] } }>(
    `mutation($id: ID!, $tags: [String!]!) {
       tagsAdd(id: $id, tags: $tags) { userErrors { message } }
     }`,
    { id: orderGid, tags },
  )
  if (data.tagsAdd.userErrors.length) {
    throw new ShopifyError(data.tagsAdd.userErrors.map((e) => e.message).join('; '), true)
  }
}
