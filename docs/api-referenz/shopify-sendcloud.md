# Shopify- & Sendcloud-Integration: API-Referenz für den Nachbau

Stand: 2026-08-05. Aktuelle stabile Shopify-API-Version: **2026-07**.

---

## SHOPIFY

### 1. Bestellungen ins externe System holen

**Admin API (GraphQL):**
- Endpoint: `https://{shop}.myshopify.com/admin/api/2026-07/graphql.json` (POST). Die REST Admin API ist Legacy; Neuentwicklungen nutzen GraphQL.
- `orders`-Query mit Cursor-Pagination (`first`/`after`, `pageInfo.hasNextPage`/`endCursor`) und Filter-Syntax, z. B. `updated_at:>2026-08-01`, `financial_status:paid`, `fulfillment_status:unfulfilled`, `status:open`.

**Zugang (Custom App / Token):**
- Eigene App mit **Admin-API-Access-Token** (Prefix `shpat_`). Token wird bei Installation **nur einmal angezeigt** → sicher speichern. Auth per Header `X-Shopify-Access-Token`.
- Custom Apps werden über das **Dev Dashboard** bzw. Shopify CLI erstellt (nicht mehr direkt im Shopify-Admin).

**Benötigte Scopes:**
- Lesen: `read_orders`. Standardmäßig nur die **letzten 60 Tage** abrufbar; ältere Orders benötigen `read_all_orders`.
- Schreiben (Tags, Order-Update): `write_orders`.

**Webhooks (Order-Topics):** `orders/create`, `orders/paid`, `orders/updated`, `orders/cancelled`, `orders/fulfilled`, `orders/partially_fulfilled`, `orders/edited`, `orders/delete`. Payload = volles Order-JSON. Subscription per `webhookSubscriptionCreate`-Mutation oder `shopify.app.toml`. Zustellung an HTTPS-Endpoint (alternativ Pub/Sub, EventBridge).

### 2. Webhook-Zuverlässigkeit

- **HMAC-Verifizierung:** Header `X-Shopify-Hmac-Sha256` = Base64-HMAC-SHA256 über den **rohen Request-Body**, Schlüssel = Client Secret der App. Timing-sicher vergleichen; bei Mismatch 401. Achtung: keine Body-Parser-Middleware vor der Verifikation (Raw Body zählt).
- **Erfolg/Fehler:** Nur HTTP 2xx zählt als zugestellt. Timeouts: 1 s Connect, 5 s gesamt — **schnell 200 zurückgeben, asynchron verarbeiten**.
- **Retries:** 8 Wiederholungen über ~4 Stunden mit exponentiellem Backoff. Nach 8 Fehlschlägen wird eine per API angelegte Subscription **automatisch gelöscht**.
- **Duplikate:** per Header `X-Shopify-Webhook-Id` idempotent verarbeiten (IDs persistieren).
- **Empfehlung (Shopify-Doku):** „Webhook delivery isn't always guaranteed" — Webhooks als Trigger + **periodischer Reconciliation-Job** (`orders(query: "updated_at:>{letzter Sync}")`).

### 3. Tags auf Orders setzen (z. B. `ready-to-ship`)

Bevorzugt **`tagsAdd`** (additiv, überschreibt bestehende Tags nicht); Gegenstück `tagsRemove`. Scope: `write_orders`.

```graphql
mutation {
  tagsAdd(id: "gid://shopify/Order/1234567890", tags: ["ready-to-ship"]) {
    node { id }
    userErrors { field message }
  }
}
```

Alternative `orderUpdate` mit `tags` ersetzt die **komplette** Tag-Liste — für additive Tags `tagsAdd` verwenden.

### 4. Relevante Order-Datenfelder (GraphQL `Order`)

- `id` (GID), `name` (z. B. „#1001"), `createdAt`, `email`, `tags`
- `lineItems`: pro `LineItem` u. a. `sku`, `quantity` / `currentQuantity` (nach Edits/Refunds), `variant { id }`, `product { id }`
- `customer`, `shippingAddress { name, address1, address2, zip, city, countryCodeV2, phone }`
- `displayFinancialStatus` (PAID, PENDING, REFUNDED …), `displayFulfillmentStatus` (UNFULFILLED, FULFILLED, PARTIALLY_FULFILLED …)
- `totalPriceSet`, `fulfillmentOrders`

### 5. Fulfillments (kurz)

Shopify nutzt das **FulfillmentOrder-Modell**: erst `fulfillmentOrders` der Order abfragen, dann `fulfillmentCreate` mit `lineItemsByFulfillmentOrder`, `trackingInfo { number, company, url }`, `notifyCustomer`. Scopes: `write_assigned_fulfillment_orders`, `write_merchant_managed_fulfillment_orders` bzw. `write_third_party_fulfillment_orders`. Hinweis: Mit der Sendcloud-Shopify-Integration erzeugt Sendcloud das Fulfillment inkl. Tracking selbst — dann genügt das Tag im ERP-Flow.

---

## SENDCLOUD

### 6a. Variante A: Sendcloud-Shopify-Integration (empfohlen als Startpunkt)

- Verbindung im Sendcloud-Panel: Settings → Integrations → Shopify → Connect (OAuth). Sendcloud importiert Bestellungen automatisch in den „Orders"-Arbeitsbereich; Konfiguration über Import-Präferenzen, Versandregeln, Benachrichtigungen.
- Ablauf: Shopify-Orders werden per API/Webhooks gezogen; Label wird in Sendcloud erstellt; **Tracking-Nummer und Fulfillment werden automatisch an die Shopify-Order zurückgemeldet**. Zusätzlich: Servicepunkte, Retourenportal, Versandregeln, Scan-&-Ship per EAN/SKU.
- Für das ERP heißt das: Das ERP muss die Order nur in Shopify „versandbereit" markieren (Tag `ready-to-ship`, in Sendcloud-Versandregeln/Filtern nutzbar) — Labelerstellung, Fulfillment und Tracking übernimmt Sendcloud.

### 6b. Variante B: Direkte Sendcloud-API

**Auth:** API-Keys im Panel (Settings → Integrations → „Sendcloud API") → **Public Key + Secret Key**, HTTP Basic Auth (User = Public, Passwort = Secret); alternativ OAuth2 Client Credentials (Beta).

**Wichtig — API-Versionen:** Die klassische **v2 Parcels API ist im Maintenance-Mode** und für neue Accounts geschlossen. Neuentwicklung direkt mit **API v3**:

| Zweck | Endpoint |
|---|---|
| Shipment anlegen + announcen + Label (synchron, ≤ 15 Pakete) | `POST https://panel.sendcloud.sc/api/v3/shipments/announce` |
| Label/Dokument abrufen | `GET /api/v3/parcels/{id}/documents/label` (PDF/ZPL/PNG; `dpi` 72–600, `paper_size` A4/A5/A6) |
| Tracking abfragen | `GET /api/v3/parcel-tracking/...` |
| Status-Push statt Polling | v3-Webhook `parcel_status_changed` |
| Orders aus dem ERP nach Sendcloud pushen (Variante C) | Orders API v3 (Batch anlegen/aktualisieren, pro `integration`) |

**Request `POST /api/v3/shipments/announce` (Kern):** `to_address`, `from_address` oder `sender_address_id`, `ship_with` (`shipping_option_code`, optional `contract_id`), `parcels[]` (`weight`, optional `dimensions`, `parcel_items[]` mit HS-Code/Wert/Ursprungsland für Drittland), `order_number`, `label_details`, `external_reference_id` (Idempotenz: Duplikat → 409 mit bestehendem Shipment).
**Response (201):** `data.parcels[].id`, `tracking_number`, `tracking_url`, `label_file` (Base64-PDF) bzw. `documents[]`-Links.

**Architektur-Empfehlung:** Variante A minimiert Eigenentwicklung — das ERP steuert nur per Tag in Shopify. Die direkte v3-API lohnt sich, wenn das ERP selbst Versandlogik oder eigenes Label-Handling (z. B. ZPL an Etikettendrucker) braucht.

---

## Quellen

**Shopify (shopify.dev):**
- https://shopify.dev/docs/apps/build/webhooks
- https://shopify.dev/docs/apps/build/webhooks/subscribe/https
- https://shopify.dev/docs/api/webhooks?reference=toml
- https://shopify.dev/docs/api/admin-graphql/latest/queries/orders
- https://shopify.dev/docs/api/admin-graphql/latest/objects/Order
- https://shopify.dev/docs/api/admin-graphql/latest/mutations/tagsAdd
- https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderUpdate
- https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentCreate
- https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/generate-app-access-tokens-admin
- https://shopify.dev/docs/apps/build/webhooks/verify-deliveries

**Sendcloud (sendcloud.dev / sendcloud.com):**
- https://sendcloud.dev/docs/getting-started/authentication.md
- https://sendcloud.dev/api/v2/parcels/create-a-parcel-or-parcels.md (Legacy-Hinweis)
- https://sendcloud.dev/api/v3/shipments/index.md
- https://sendcloud.dev/api/v3/shipments/create-and-announce-a-shipment-synchronously.md
- https://sendcloud.dev/api/v3/parcel-documents/retrieve-a-parcel-document.md
- https://sendcloud.dev/api/v3/orders/index.md
- https://www.sendcloud.com/integrations/shopify/
