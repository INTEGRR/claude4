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

/**
 * Klärfall provozieren: eine bezahlte Bestellung mit UNBEKANNTER SKU. Der
 * Import legt den Auftrag OHNE die Position an (Entwurf, kein Picking) und
 * schreibt die Klärzeile — der Prozess wartet am matching-Schritt. Liefert
 * bewusst KEINE Beleg-ID; die kommt nach der Auflösung (Heilung).
 */
async function klaerfallProvozieren(ctx: FixtureKontext, sql: Sql): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from sales_orders
    where shopify_order_id like 'gid://shopify/Order/9200%'`
  const nummer = 9200000 + Number(n)
  const gid = `gid://shopify/Order/${nummer}`

  // Frischer Artikel je Lauf (Staging-wiederholbar): ohne SKU und ohne
  // Shop-Verknüpfung — die Auflösung soll BEIDES an der Variante hinterlegen.
  const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, list_price, weight_g)
    values (${`Prozesstest Klärartikel ${nummer}`}, ${stueck.id}, 99, 150) returning id`
  await sql`select generate_variants(${tpl.id})`
  const [variante] = await sql<{ id: string }[]>`
    select id from product_variants where template_id = ${tpl.id} and active limit 1`
  ctx.klaerArtikelId = variante.id
  const [ort] = await sql<{ id: string }[]>`
    select id from stock_locations where full_path = 'WH/Stock'`
  const [zaehlung] = await sql<{ id: string }[]>`
    insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
    values (${ort.id}, ${variante.id}, 5, 0) returning id`
  await sql`select inventory_apply(${zaehlung.id}, 'prozesstest')`

  const { fakeOrderHinterlegen } = await import('../../integrationen/shopify-fake.ts')
  fakeOrderHinterlegen({
    id: gid,
    name: `#P4K-${nummer}`,
    createdAt: '2026-01-02T10:00:00Z',
    cancelledAt: null,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    email: 'prozesstest@example.com',
    tags: [],
    totalPriceSet: { shopMoney: { amount: '19.90', currencyCode: 'EUR' } },
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
          title: `Prozesstest Klärartikel ${nummer}`,
          sku: `PT-KLAER-${nummer}`,
          quantity: 1,
          currentQuantity: 1,
          variant: { id: `gid://shopify/ProductVariant/${nummer}` },
          originalUnitPriceSet: { shopMoney: { amount: '19.90' } },
        },
      ],
    },
  } as never)

  await sql`
    insert into shopify_webhook_events (webhook_id, topic, shopify_order_id, payload)
    values (${`prozesstest-k-${nummer}`}, 'orders/paid', ${gid}, ${sql.json({ id: gid })})
    on conflict (webhook_id) do nothing`
  const { processPendingWebhooks } = await import('../../integrationen/import.ts')
  await processPendingWebhooks(10)

  const [auftrag] = await sql<{ id: string; state: string }[]>`
    select id, state from sales_orders where shopify_order_id = ${gid}`
  assert.ok(auftrag, 'die Bestellung muss trotz Klärfall als Auftrag ankommen')
  assert.equal(auftrag.state, 'draft', 'mit offenem Klärfall wird nicht bestätigt')
  const pickings = await sql<{ id: string }[]>`
    select id from stock_pickings
    where origin_model = 'sales_order' and origin_id = ${auftrag.id}`
  assert.equal(pickings.length, 0, 'ohne Bestätigung keine Lieferung')
  ctx.p4KlaerOrderGid = gid
}

/** Nach der Auflösung: die Heilung hat bestätigt — die Lieferung ist der Beleg. */
async function belegNachKlaerung(ctx: FixtureKontext, sql: Sql): Promise<string> {
  const [auftrag] = await sql<{ id: string; state: string }[]>`
    select id, state from sales_orders where shopify_order_id = ${ctx.p4KlaerOrderGid}`
  assert.equal(auftrag.state, 'sale', 'die Auflösung muss den Auftrag heilen und bestätigen')
  ctx.p4KlaerAuftragId = auftrag.id
  const [picking] = await sql<{ id: string }[]>`
    select id from stock_pickings
    where origin_model = 'sales_order' and origin_id = ${auftrag.id}`
  assert.ok(picking, 'nach der Heilung muss die Lieferung existieren')
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
    {
      name: 'unbekannte SKU: Klärfall auflösen heilt den Auftrag, dann Versand',
      pfad: ['bestellung', 'klaerung', 'label', 'buchen', 'fulfillment'],
      ereignisse: {
        bestellung: klaerfallProvozieren,
        // Folge-Auslöser des matching-Schritts: liefert den geheilten Beleg.
        klaerung: belegNachKlaerung,
      },
      eingaben: {
        klaerung: (ctx) => ({ variant_id: ctx.klaerArtikelId }),
        buchen: { mengen: {}, lose: {}, backorder: false },
      },
      pruefen: async (sql, ctx, pickingId) => {
        const [picking] = await sql<{ state: string }[]>`
          select state from stock_pickings where id = ${pickingId}`
        assert.equal(picking.state, 'done')

        // Die Klärzeile ist aufgelöst UND als Position übernommen …
        const [zeile] = await sql<
          { resolved_at: string | null; attached_at: string | null }[]
        >`
          select resolved_at, attached_at from shopify_unmatched_lines
          where shopify_order_id = ${ctx.p4KlaerOrderGid}`
        assert.ok(zeile.resolved_at, 'die Klärzeile muss aufgelöst sein')
        assert.ok(zeile.attached_at, 'die Klärzeile muss als Position nachgezogen sein')

        // … mit dem ECHTEN Shop-Preis, nicht dem Listenpreis.
        const [position] = await sql<{ price_unit: number; qty: number }[]>`
          select price_unit, qty from sales_order_lines
          where order_id = ${ctx.p4KlaerAuftragId} and variant_id = ${ctx.klaerArtikelId}`
        assert.ok(position, 'die geklärte Position muss am Auftrag hängen')
        assert.equal(Number(position.price_unit), 19.9)

        // Die Zuordnung ist an der Variante gemerkt — der nächste Import passt.
        const [variante] = await sql<
          { sku: string | null; shopify_variant_id: string | null }[]
        >`
          select sku, shopify_variant_id from product_variants
          where id = ${ctx.klaerArtikelId}`
        assert.ok(variante.sku?.startsWith('PT-KLAER-'), 'SKU muss übernommen sein')
        assert.ok(variante.shopify_variant_id, 'Shop-Verknüpfung muss übernommen sein')
      },
    },
  ],
}
