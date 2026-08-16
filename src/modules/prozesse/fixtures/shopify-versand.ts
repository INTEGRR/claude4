import assert from 'node:assert/strict'
import type { Sql } from 'postgres'
import type { FixtureKontext, ProzessFixture } from './typen.ts'

/**
 * P4: Shop-Bestellung → Versand — der erste Prozess mit Außenwelt.
 *
 * Das Ereignis „Bestellung eingegangen" wird eingespeist wie im Betrieb:
 * eine Zeile in shopify_webhook_events plus die Bestellung im Shopify-Fake
 * (der Import verwirft den Webhook-Payload und holt die Wahrheit per
 * fetchOrder). Verarbeitung, Bestätigung, Lieferung, Label, Warenausgang
 * und die Shop-Rückmeldung laufen dann über exakt die Produktionswege.
 *
 * Die externen Module werden bewusst DYNAMISCH importiert: die Fixtures
 * lädt auch scripts/prozessdaten.ts unter blankem Node (ohne Loader) — die
 * Auslöser laufen aber nur im Harness, wo der Loader server-only stubt.
 */

async function bestellungEinspeisen(ctx: FixtureKontext, sql: Sql): Promise<string> {
  // Wiederholbar (Staging!): jede Einspeisung bekommt die nächste freie Nummer.
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from sales_orders
    where shopify_order_id like 'gid://shopify/Order/9100%'`
  const nummer = 9100000 + Number(n)
  const gid = `gid://shopify/Order/${nummer}`

  const { fakeOrderHinterlegen } = await import('../../integrationen/shopify-fake.ts')
  fakeOrderHinterlegen({
    id: gid,
    name: `#P4-${nummer}`,
    createdAt: '2026-01-01T10:00:00Z',
    cancelledAt: null,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    email: 'prozesstest@example.com',
    tags: [],
    totalPriceSet: { shopMoney: { amount: '59.80', currencyCode: 'EUR' } },
    customer: {
      id: 'gid://shopify/Customer/424242',
      firstName: 'Paula',
      lastName: 'Prozess',
      defaultEmailAddress: { emailAddress: 'prozesstest@example.com' },
    },
    shippingAddress: {
      name: 'Paula Prozess',
      address1: 'Teststraße 1',
      address2: null,
      zip: '10115',
      city: 'Berlin',
      countryCodeV2: 'DE',
      phone: null,
    },
    lineItems: {
      nodes: [
        {
          title: 'Prozesstest Ersatzteil',
          sku: 'PT-TEIL',
          quantity: 2,
          currentQuantity: 2,
          variant: { id: `gid://shopify/ProductVariant/${nummer}` },
          originalUnitPriceSet: { shopMoney: { amount: '29.90' } },
        },
      ],
    },
  } as never)

  // Die Webhook-Zeile exakt so, wie die Route sie schreibt.
  await sql`
    insert into shopify_webhook_events (webhook_id, topic, shopify_order_id, payload)
    values (${`prozesstest-${nummer}`}, 'orders/paid', ${gid}, ${sql.json({ id: gid })})
    on conflict (webhook_id) do nothing`

  const { processPendingWebhooks } = await import('../../integrationen/import.ts')
  let status = 'pending'
  let fehler: string | null = null
  for (let runde = 0; runde < 3 && status === 'pending'; runde++) {
    await processPendingWebhooks(10)
    const [ev] = await sql<{ status: string; error: string | null }[]>`
      select status, error from shopify_webhook_events
      where webhook_id = ${`prozesstest-${nummer}`}`
    status = ev.status
    fehler = ev.error
  }
  assert.equal(status, 'done', `Webhook-Verarbeitung: ${status}${fehler ? ` — ${fehler}` : ''}`)

  const [auftrag] = await sql<{ id: string; state: string }[]>`
    select id, state from sales_orders where shopify_order_id = ${gid}`
  assert.ok(auftrag, 'die Bestellung muss als Verkaufsauftrag ankommen')
  assert.equal(auftrag.state, 'sale', 'bezahlte Bestellung wird sofort bestätigt')
  ctx.p4AuftragId = auftrag.id

  const [picking] = await sql<{ id: string }[]>`
    select id from stock_pickings
    where origin_model = 'sales_order' and origin_id = ${auftrag.id}`
  assert.ok(picking, 'die Bestätigung erzeugt die Lieferung')
  return picking.id
}

export const SHOPIFY_VERSAND: ProzessFixture = {
  prozess: 'shopify_bestellung_versand',
  benoetigt: ['basis'],
  laeufe: [
    {
      name: 'bezahlte Bestellung bis zur Shop-Rückmeldung',
      // 'verfuegbarkeit' fehlt bewusst: mit Bestand reserviert schon die
      // Bestätigung (at_confirm) — der Beleg steht danach AUF dem Schritt,
      // der Prozess bietet direkt das Label an. Der Schritt bleibt der Weg
      // für Bestellungen ohne Bestand.
      pfad: ['bestellung', 'label', 'buchen', 'fulfillment'],
      ereignisse: { bestellung: bestellungEinspeisen },
      eingaben: {
        buchen: { mengen: {}, lose: {}, backorder: false },
      },
      pruefen: async (sql, ctx, pickingId) => {
        const [picking] = await sql<{ state: string }[]>`
          select state from stock_pickings where id = ${pickingId}`
        assert.equal(picking.state, 'done')

        // Das Label kam aus dem DHL-Fake und hängt als Sendung am Vorgang …
        const [sendung] = await sql<
          { shipment_number: string; shopify_fulfillment_id: string | null }[]
        >`
          select shipment_number, shopify_fulfillment_id
          from shipments where picking_id = ${pickingId}`
        assert.ok(sendung, 'die Sendung muss existieren')
        assert.match(sendung.shipment_number, /^\d{20}$/)
        // … und die Shop-Rückmeldung (Outbox-Job mit Shopify-Fake) ist durch.
        assert.ok(sendung.shopify_fulfillment_id, 'das Fulfillment muss gemeldet sein')

        // Keine offene Klärzeile — die SKU hat gepasst.
        const [{ offen }] = await sql<{ offen: number }[]>`
          select count(*)::int as offen from shopify_unmatched_lines
          where resolved_at is null`
        assert.equal(offen, 0)

        // Der Auftrag ist vollständig geliefert.
        const [auftrag] = await sql<{ delivery_status: string | null }[]>`
          select delivery_status from sales_orders where id = ${ctx.p4AuftragId}`
        assert.equal(auftrag.delivery_status, 'full')
      },
    },
  ],
}
