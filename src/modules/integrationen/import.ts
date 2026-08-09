import 'server-only'
import type { TransactionSql } from 'postgres'
import { sql, tx } from '@/db/client'
import { splitStreet } from '@/modules/shared/address'
import { fetchOrder, type ShopifyOrder } from './shopify'

export { splitStreet }

/**
 * Import-Pipeline: aus einer Shopify-Order wird ein Verkaufsauftrag.
 *
 * Verarbeitung läuft bewusst getrennt vom Webhook-Empfang - der Endpunkt
 * speichert nur und antwortet sofort (Shopify bricht nach 5 s ab).
 */

async function upsertCustomer(t: TransactionSql, order: ShopifyOrder): Promise<string> {
  const addr = order.shippingAddress
  const name =
    addr?.name ||
    [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ') ||
    order.email ||
    'Unbekannter Kunde'
  const { street, houseNumber } = splitStreet(addr?.address1)
  const shopifyCustomerId = order.customer?.id ?? null
  const email = order.customer?.email ?? order.email

  if (shopifyCustomerId) {
    const [existing] = await t<{ id: string }[]>`
      select id from partners where shopify_customer_id = ${shopifyCustomerId}`
    if (existing) {
      await t`
        update partners set
          name = ${name}, email = coalesce(${email}, email),
          street = ${street}, house_number = ${houseNumber},
          street2 = ${addr?.address2 ?? null}, zip = ${addr?.zip ?? null},
          city = ${addr?.city ?? null},
          country_code = coalesce(${addr?.countryCodeV2 ?? null}, country_code),
          phone = coalesce(${addr?.phone ?? null}, phone), is_customer = true
        where id = ${existing.id}`
      return existing.id
    }
  }

  const [created] = await t<{ id: string }[]>`
    insert into partners (
      name, is_customer, email, street, house_number, street2, zip, city,
      country_code, phone, shopify_customer_id)
    values (
      ${name}, true, ${email ?? null}, ${street}, ${houseNumber},
      ${addr?.address2 ?? null}, ${addr?.zip ?? null}, ${addr?.city ?? null},
      ${addr?.countryCodeV2 ?? 'DE'}, ${addr?.phone ?? null}, ${shopifyCustomerId})
    returning id`
  return created.id
}

/** Findet die Variante über die Shopify-Varianten-ID oder die SKU. */
async function matchVariant(
  t: TransactionSql,
  sku: string | null,
  variantGid: string | null,
): Promise<string | null> {
  if (variantGid) {
    const [byGid] = await t<{ id: string }[]>`
      select id from product_variants where shopify_variant_id = ${variantGid} and active`
    if (byGid) return byGid.id
  }
  if (sku) {
    const [bySku] = await t<{ id: string }[]>`
      select id from product_variants where sku = ${sku} and active`
    if (bySku) {
      // Zuordnung merken, damit der nächste Import ohne SKU-Suche auskommt.
      if (variantGid) {
        await t`update product_variants set shopify_variant_id = ${variantGid}
                where id = ${bySku.id} and shopify_variant_id is null`
      }
      return bySku.id
    }
  }
  return null
}

export interface ImportResult {
  salesOrderId: string | null
  created: boolean
  unmatched: number
  message: string
}

/**
 * Legt aus einer Shopify-Order einen Verkaufsauftrag an (idempotent über
 * shopify_order_id). Bezahlte Orders werden direkt bestätigt, wodurch
 * Lieferung und Fertigungsaufträge entstehen.
 */
export async function importShopifyOrder(
  order: ShopifyOrder,
  eventId: string | null = null,
): Promise<ImportResult> {
  return tx(async (t) => {
    const [existing] = await t<{ id: string; state: string }[]>`
      select id, state from sales_orders where shopify_order_id = ${order.id}`

    // Stornierte Orders: vorhandenen Auftrag stornieren, sonst nichts tun.
    if (order.cancelledAt) {
      if (existing && existing.state !== 'cancel') {
        await t`select cancel_sales_order(${existing.id}, 'shopify')`
        return {
          salesOrderId: existing.id,
          created: false,
          unmatched: 0,
          message: `Auftrag zu ${order.name} storniert`,
        }
      }
      return { salesOrderId: existing?.id ?? null, created: false, unmatched: 0,
        message: `${order.name} ist storniert - nichts zu tun` }
    }

    if (existing) {
      return {
        salesOrderId: existing.id,
        created: false,
        unmatched: 0,
        message: `${order.name} war bereits importiert`,
      }
    }

    const partnerId = await upsertCustomer(t, order)
    const addr = order.shippingAddress
    const { street, houseNumber } = splitStreet(addr?.address1)

    const [created] = await t<{ id: string }[]>`
      insert into sales_orders (
        number, partner_id, source, shopify_order_id, shopify_order_name,
        order_date, currency,
        ship_name, ship_street, ship_house_number, ship_street2,
        ship_zip, ship_city, ship_country_code, ship_phone, ship_email)
      values (
        next_sequence('sale'), ${partnerId}, 'shopify', ${order.id}, ${order.name},
        ${order.createdAt}, ${order.totalPriceSet.shopMoney.currencyCode},
        ${addr?.name ?? null}, ${street}, ${houseNumber}, ${addr?.address2 ?? null},
        ${addr?.zip ?? null}, ${addr?.city ?? null}, ${addr?.countryCodeV2 ?? 'DE'},
        ${addr?.phone ?? null}, ${order.email ?? null})
      returning id`

    let sequence = 10
    let unmatched = 0

    for (const item of order.lineItems.nodes) {
      const qty = item.currentQuantity ?? item.quantity
      if (qty <= 0) continue

      const variantId = await matchVariant(t, item.sku, item.variant?.id ?? null)
      if (!variantId) {
        // Ohne Produktzuordnung keine Position - stattdessen Klärfall anlegen.
        await t`
          insert into shopify_unmatched_lines (
            event_id, shopify_order_id, order_name, sku, title, variant_gid, qty)
          values (${eventId}, ${order.id}, ${order.name}, ${item.sku},
                  ${item.title}, ${item.variant?.id ?? null}, ${qty})`
        unmatched++
        continue
      }

      const [uomRow] = await t<{ uom_id: string }[]>`
        select pt.uom_id from product_variants pv
        join product_templates pt on pt.id = pv.template_id where pv.id = ${variantId}`

      await t`
        insert into sales_order_lines (order_id, sequence, variant_id, name, qty, uom_id, price_unit)
        values (${created.id}, ${sequence}, ${variantId}, ${item.title}, ${qty},
                ${uomRow.uom_id}, ${Number(item.originalUnitPriceSet.shopMoney.amount)})`
      sequence += 10
    }

    if (unmatched > 0) {
      await t`select log_event('sales_order', ${created.id}, 'error',
        ${`${unmatched} Position(en) konnten keinem Produkt zugeordnet werden und fehlen im Auftrag.`},
        'shopify')`
    }

    // Bezahlte Orders sofort bestätigen: erzeugt Lieferung + Fertigungsaufträge.
    const paid = order.displayFinancialStatus === 'PAID'
    if (paid && unmatched === 0) {
      await t`select confirm_sales_order(${created.id}, 'shopify')`
    }

    return {
      salesOrderId: created.id,
      created: true,
      unmatched,
      message:
        `${order.name} importiert` +
        (paid && unmatched === 0 ? ' und bestätigt' : '') +
        (unmatched > 0 ? ` (${unmatched} Position(en) offen)` : ''),
    }
  })
}

// --- Webhook-Verarbeitung --------------------------------------------------

export interface ProcessResult {
  processed: number
  failed: number
}

/** Arbeitet die gespeicherten Webhook-Events ab. */
export async function processPendingWebhooks(limit = 25): Promise<ProcessResult> {
  const events = await sql<
    { id: string; topic: string; shopify_order_id: string | null; payload: Record<string, unknown> }[]
  >`
    select id, topic, shopify_order_id, payload
    from shopify_webhook_events
    where status = 'pending' and attempts < 5 and next_attempt_at <= now()
    order by received_at
    limit ${limit}`

  let processed = 0
  let failed = 0

  for (const event of events) {
    try {
      // Bestandsmeldungen tragen keine Order-ID — eigener Zweig vor der
      // Order-Verarbeitung, sonst würden sie als "ohne Order-ID" übersprungen.
      if (event.topic.startsWith('inventory_levels/')) {
        const { verarbeiteInventarWebhook } = await import('./inventar')
        const meldung = await verarbeiteInventarWebhook(event.payload)
        await sql`update shopify_webhook_events
                  set status = 'done', processed_at = now(), error = ${meldung}
                  where id = ${event.id}`
        processed++
        continue
      }

      const gid = event.shopify_order_id
      if (!gid) {
        await sql`update shopify_webhook_events
                  set status = 'skipped', processed_at = now(),
                      error = 'Keine Order-ID im Payload'
                  where id = ${event.id}`
        continue
      }

      // Immer den aktuellen Stand von Shopify holen: Webhooks können veraltet
      // oder in falscher Reihenfolge ankommen.
      const order = await fetchOrder(gid)
      if (!order) {
        await sql`update shopify_webhook_events
                  set status = 'skipped', processed_at = now(),
                      error = 'Order in Shopify nicht gefunden'
                  where id = ${event.id}`
        continue
      }

      const result = await importShopifyOrder(order, event.id)
      await sql`
        update shopify_webhook_events
        set status = 'done', processed_at = now(), error = ${result.message}
        where id = ${event.id}`
      processed++
    } catch (err) {
      failed++
      // Gleiche Backoff-Staffel wie die Job-Queue statt Sofort-Wiederholung.
      await sql`
        update shopify_webhook_events
        set attempts = attempts + 1,
            error = ${err instanceof Error ? err.message : String(err)},
            status = case when attempts + 1 >= 5 then 'failed'::webhook_status
                          else 'pending'::webhook_status end,
            next_attempt_at = now() + make_interval(
              mins => (array[1, 5, 15, 60, 180])[least(attempts + 1, 5)])
        where id = ${event.id}`
    }
  }

  return { processed, failed }
}

/** Stellt ein fehlgeschlagenes Webhook-Event zur erneuten Verarbeitung ein. */
export async function retryWebhookEvent(eventId: string): Promise<void> {
  await sql`
    update shopify_webhook_events
    set status = 'pending', attempts = 0, error = null, next_attempt_at = now()
    where id = ${eventId} and status in ('failed', 'skipped')`
}

/**
 * Abgleich mit Shopify als Sicherheitsnetz: holt geänderte Orders und legt
 * fehlende an. Fängt Webhooks ab, die nie ankamen.
 */
export async function reconcileOrders(): Promise<{ checked: number; imported: number }> {
  const [state] = await sql<{ value: string }[]>`
    select value #>> '{}' as value from shopify_sync_state where key = 'last_reconciliation_at'`
  const since = new Date(state?.value ?? Date.now() - 24 * 60 * 60 * 1000)

  const { fetchOrdersUpdatedSince } = await import('./shopify')
  const orders = await fetchOrdersUpdatedSince(since)

  let imported = 0
  for (const order of orders) {
    const result = await importShopifyOrder(order)
    if (result.created) imported++
  }

  await sql`
    update shopify_sync_state
    set value = to_jsonb(${new Date().toISOString()}::text), updated_at = now()
    where key = 'last_reconciliation_at'`

  return { checked: orders.length, imported }
}
