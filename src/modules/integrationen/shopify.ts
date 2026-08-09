import 'server-only'

export { verifyWebhookHmac } from './shopify-hmac'

/**
 * Shopify Admin API (GraphQL). Die REST-API ist Legacy; alles läuft über
 * GraphQL gegen die in SHOPIFY_API_VERSION gepinnte Version.
 */

export interface ShopifyConfig {
  shop: string
  /** Statisches Admin-Token (shpat_…) — nur noch bei Alt-Apps von vor 2026. */
  token: string
  /** Dev-Dashboard-App: Client ID + Secret, Token kommt per OAuth-Grant. */
  clientId: string
  clientSecret: string
  apiVersion: string
  webhookSecret: string
}

export function shopifyConfig(): ShopifyConfig {
  return {
    shop: process.env.SHOPIFY_SHOP_DOMAIN ?? '',
    token: process.env.SHOPIFY_ADMIN_TOKEN ?? '',
    clientId: process.env.SHOPIFY_CLIENT_ID ?? '',
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET ?? '',
    apiVersion: process.env.SHOPIFY_API_VERSION ?? '2026-07',
    // Webhooks der eigenen App signiert Shopify mit dem Client Secret —
    // ein eigenes Secret ist nur noch für Admin-Seiten-Webhooks nötig.
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || (process.env.SHOPIFY_CLIENT_SECRET ?? ''),
  }
}

export function shopifyConfigured(): boolean {
  const c = shopifyConfig()
  return Boolean(c.shop && (c.token || (c.clientId && c.clientSecret)))
}

// --- Access Token ------------------------------------------------------------
//
// Seit 2026 zeigt Shopify für neue Apps kein statisches Admin-Token mehr an.
// Stattdessen wird die Client ID samt Secret über den Client-Credentials-Grant
// gegen ein Token getauscht, das 24 Stunden gilt. Voraussetzung: App und Shop
// gehören derselben Organisation — für eine Eigen-App auf dem eigenen Shop
// (unser Fall) ist das immer erfüllt.

let tokenCache: { token: string; gueltigBis: number } | null = null

async function accessToken(): Promise<string> {
  const c = shopifyConfig()
  if (c.token) return c.token // Alt-App mit statischem Token

  if (tokenCache && Date.now() < tokenCache.gueltigBis) return tokenCache.token

  const start = Date.now()
  let res: Response
  try {
    res = await fetch(`https://${c.shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        grant_type: 'client_credentials',
      }),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await protokollToken(false, null, `Netzwerkfehler: ${message}`, start)
    throw new ShopifyError(`Shopify-Token nicht erreichbar: ${message}`, true)
  }

  if (!res.ok) {
    const text = (await res.text()).slice(0, 300)
    await protokollToken(false, res.status, text, start)
    throw new ShopifyError(
      `Shopify-Token abgelehnt (${res.status}): ${text} — stimmen Client ID/Secret, und ist die App im Shop installiert?`,
      res.status >= 500,
    )
  }

  const body = (await res.json()) as { access_token?: string; expires_in?: number | string }
  if (!body.access_token) {
    await protokollToken(false, res.status, 'Antwort ohne access_token', start)
    throw new ShopifyError('Shopify-Token: Antwort ohne access_token', true)
  }

  // Fünf Minuten Sicherheitsabstand: lieber einmal zu früh erneuern als mit
  // einem gerade abgelaufenen Token in einen 401 laufen.
  const sekunden = Number(body.expires_in ?? 86399)
  tokenCache = { token: body.access_token, gueltigBis: Date.now() + (sekunden - 300) * 1000 }
  await protokollToken(true, res.status, undefined, start)
  return body.access_token
}

/** Tokenholung protokollieren — ohne Request-Body: da stünde das Secret drin. */
async function protokollToken(ok: boolean, statusCode: number | null, error: string | undefined, start: number) {
  const { logTransaction } = await import('./transaktionen')
  await logTransaction({
    system: 'shopify', kind: 'oauth_token', request: null,
    response: null, ok, statusCode, error, durationMs: Date.now() - start,
  })
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

/** Operationsname fürs Transaktionslog: erstes Feld hinter der öffnenden Klammer. */
function operationName(query: string): string {
  return /(?:query|mutation)[^{]*\{\s*(\w+)/.exec(query)?.[1] ?? 'anonym'
}

export async function shopifyGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const c = shopifyConfig()
  if (!shopifyConfigured()) throw new ShopifyError('Shopify ist nicht konfiguriert', false)

  const start = Date.now()
  const kind = `graphql:${operationName(query)}`
  const protokoll = async (ok: boolean, statusCode: number | null, response: unknown, error?: string) => {
    const { logTransaction } = await import('./transaktionen')
    await logTransaction({
      system: 'shopify', kind, request: { variables }, response,
      ok, statusCode, error, durationMs: Date.now() - start,
    })
  }

  const anfrage = async () =>
    fetch(`https://${c.shop}/admin/api/${c.apiVersion}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': await accessToken(),
      },
      body: JSON.stringify({ query, variables }),
    })

  let res: Response
  try {
    res = await anfrage()
    // 401 mit Grant-Token: Token kann widerrufen oder gerade abgelaufen sein —
    // einmal frisch holen und wiederholen, erst dann ist es ein echter Fehler.
    if (res.status === 401 && !c.token) {
      tokenCache = null
      res = await anfrage()
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await protokoll(false, null, null, `Netzwerkfehler: ${message}`)
    throw new ShopifyError(`Shopify nicht erreichbar: ${message}`, true)
  }

  // 429/5xx sind vorübergehend - der Job-Runner versucht es später erneut.
  if (res.status === 429 || res.status >= 500) {
    await protokoll(false, res.status, null, `Shopify antwortete mit ${res.status}`)
    throw new ShopifyError(`Shopify antwortete mit ${res.status}`, true)
  }
  if (!res.ok) {
    const text = await res.text()
    await protokoll(false, res.status, null, text.slice(0, 500))
    throw new ShopifyError(`Shopify antwortete mit ${res.status}: ${text}`, false)
  }

  const body = (await res.json()) as GraphQLResponse<T>
  if (body.errors?.length) {
    const throttled = body.errors.some((e) => e.extensions?.code === 'THROTTLED')
    const message = body.errors.map((e) => e.message).join('; ')
    await protokoll(false, res.status, body.errors, message)
    throw new ShopifyError(message, throttled)
  }
  if (!body.data) {
    await protokoll(false, res.status, null, 'Shopify lieferte keine Daten')
    throw new ShopifyError('Shopify lieferte keine Daten', true)
  }
  await protokoll(true, res.status, body.data)
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
  customer: {
    id: string
    firstName: string | null
    lastName: string | null
    defaultEmailAddress: { emailAddress: string | null } | null
  } | null
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
  customer { id firstName lastName defaultEmailAddress { emailAddress } }
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
/**
 * Eine einzelne Bestellungs-Seite — für die Erstübernahme, die als Job in
 * Häppchen arbeitet und den Cursor zwischen den Läufen mitnimmt.
 */
export async function fetchOrdersPage(
  q: string,
  after: string | null,
): Promise<{ orders: ShopifyOrder[]; endCursor: string | null }> {
  const data: {
    orders: { nodes: ShopifyOrder[]; pageInfo: { hasNextPage: boolean; endCursor: string } }
  } = await shopifyGraphQL(
    `query($q: String!, $after: String) {
       orders(first: 50, query: $q, after: $after, sortKey: CREATED_AT) {
         nodes { ${ORDER_FIELDS} }
         pageInfo { hasNextPage endCursor }
       }
     }`,
    { q, after },
  )
  return {
    orders: data.orders.nodes,
    endCursor: data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null,
  }
}

export interface ShopifyCustomer {
  id: string
  firstName: string | null
  lastName: string | null
  /** 2026-07: E-Mail und Telefon liegen in eigenen Unterobjekten. */
  defaultEmailAddress: { emailAddress: string | null } | null
  defaultPhoneNumber: { phoneNumber: string | null } | null
  defaultAddress: {
    company: string | null
    address1: string | null
    address2: string | null
    zip: string | null
    city: string | null
    countryCodeV2: string | null
    phone: string | null
  } | null
}

/** Eine Kunden-Seite für die Erstübernahme. */
export async function fetchCustomersPage(
  after: string | null,
): Promise<{ customers: ShopifyCustomer[]; endCursor: string | null }> {
  const data: {
    customers: { nodes: ShopifyCustomer[]; pageInfo: { hasNextPage: boolean; endCursor: string } }
  } = await shopifyGraphQL(
    `query($after: String) {
       customers(first: 100, after: $after, sortKey: CREATED_AT) {
         nodes {
           id firstName lastName
           defaultEmailAddress { emailAddress }
           defaultPhoneNumber { phoneNumber }
           defaultAddress { company address1 address2 zip city countryCodeV2 phone }
         }
         pageInfo { hasNextPage endCursor }
       }
     }`,
    { after },
  )
  return {
    customers: data.customers.nodes,
    endCursor: data.customers.pageInfo.hasNextPage ? data.customers.pageInfo.endCursor : null,
  }
}

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

// --- Webhook-Verwaltung -------------------------------------------------------
//
// Damit Änderungen aus Shopify sofort ankommen, registriert das ERP seine
// Webhooks selbst — vorausgesetzt, es ist öffentlich erreichbar.

const WEBHOOK_TOPICS = [
  'ORDERS_CREATE',
  'ORDERS_UPDATED',
  'ORDERS_CANCELLED',
  'INVENTORY_LEVELS_UPDATE',
  'PRODUCTS_CREATE',
  'PRODUCTS_UPDATE',
] as const

export interface WebhookEintrag {
  id: string
  topic: string
  callbackUrl: string | null
}

export async function fetchWebhooks(): Promise<WebhookEintrag[]> {
  // Seit 2026-07 liegt die Zieladresse direkt als `uri` am Abo; der frühere
  // Umweg über endpoint { callbackUrl } ist als veraltet markiert.
  const data = await shopifyGraphQL<{
    webhookSubscriptions: { nodes: { id: string; topic: string; uri: string }[] }
  }>(`query { webhookSubscriptions(first: 50) { nodes { id topic uri } } }`)
  return data.webhookSubscriptions.nodes.map((n) => ({
    id: n.id,
    topic: n.topic,
    callbackUrl: n.uri ?? null,
  }))
}

/**
 * Registriert die benötigten Webhooks auf `${baseUrl}/api/webhooks/shopify`.
 * Vorhandene Einträge mit derselben Adresse bleiben; abweichende Adressen zum
 * selben Thema werden auf die neue umgezogen.
 */
export async function registerWebhooks(
  baseUrl: string,
): Promise<{ angelegt: number; aktualisiert: number; unveraendert: number }> {
  const ziel = `${baseUrl.replace(/\/+$/, '')}/api/webhooks/shopify`
  const vorhandene = await fetchWebhooks()
  let angelegt = 0
  let aktualisiert = 0
  let unveraendert = 0

  for (const topic of WEBHOOK_TOPICS) {
    const bestehend = vorhandene.find((w) => w.topic === topic)
    if (bestehend?.callbackUrl === ziel) {
      unveraendert++
      continue
    }
    if (bestehend) {
      const upd = await shopifyGraphQL<{
        webhookSubscriptionUpdate: { userErrors: { message: string }[] }
      }>(
        `mutation aktualisieren($id: ID!, $sub: WebhookSubscriptionInput!) {
           webhookSubscriptionUpdate(id: $id, webhookSubscription: $sub) {
             userErrors { message }
           }
         }`,
        { id: bestehend.id, sub: { uri: ziel } },
      )
      const fehler = upd.webhookSubscriptionUpdate.userErrors
      if (fehler.length) throw new ShopifyError(`${topic}: ${fehler.map((f) => f.message).join('; ')}`, false)
      aktualisiert++
      continue
    }
    const neu = await shopifyGraphQL<{
      webhookSubscriptionCreate: { userErrors: { message: string }[] }
    }>(
      `mutation anlegen($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
         webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
           userErrors { message }
         }
       }`,
      { topic, sub: { uri: ziel } },
    )
    const fehler = neu.webhookSubscriptionCreate.userErrors
    if (fehler.length) throw new ShopifyError(`${topic}: ${fehler.map((f) => f.message).join('; ')}`, false)
    angelegt++
  }

  return { angelegt, aktualisiert, unveraendert }
}
