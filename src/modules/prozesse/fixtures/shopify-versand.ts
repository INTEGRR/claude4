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

export async function bestellungEinspeisen(ctx: FixtureKontext, sql: Sql): Promise<string> {
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

/**
 * BUG/00003: bezahlte Bestellung über einen Artikel, der auf Bestellung
 * gefertigt wird (route_manufacture + route_mto + Stückliste). Die
 * Bestätigung legt den Fertigungsauftrag automatisch an; die Lieferung
 * bleibt unreserviert stehen (kein Erzeugnis-Bestand) — der Beleg steht
 * im Prozess an der Bestellung, der Fertigungszweig wartet sichtbar.
 */
async function mtoBestellungEinspeisen(ctx: FixtureKontext, sql: Sql): Promise<string> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from sales_orders
    where shopify_order_id like 'gid://shopify/Order/9300%'`
  const nummer = 9300000 + Number(n)
  const gid = `gid://shopify/Order/${nummer}`

  // Frischer MTO-Artikel je Lauf (Staging-wiederholbar), OHNE Fertigbestand:
  // Stückliste 1 × Ersatzteil, Backflush — gefertigt wird erst auf Bestellung.
  const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, list_price, weight_g,
                                   route_manufacture, route_mto)
    values (${`Prozesstest MTO-Artikel ${nummer}`}, ${stueck.id}, 149, 400, true, true)
    returning id`
  await sql`select generate_variants(${tpl.id})`
  const [variante] = await sql<{ id: string }[]>`
    select id from product_variants where template_id = ${tpl.id} and active limit 1`
  await sql`update product_variants set sku = ${`PT-MTO-${nummer}`} where id = ${variante.id}`
  // Für den Packtisch-Lauf: die SKU ist der Scan-Schlüssel.
  ctx.p4MtoSku = `PT-MTO-${nummer}`
  const [bom] = await sql<{ id: string }[]>`
    insert into boms (template_id, qty, uom_id) values (${tpl.id}, 1, ${stueck.id}) returning id`
  await sql`
    insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id, issue_method)
    select ${bom.id}, 10, ${ctx.teilId}, 1, pt.uom_id, 'backflush'
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.id = ${ctx.teilId}`

  const { fakeOrderHinterlegen } = await import('../../integrationen/shopify-fake.ts')
  fakeOrderHinterlegen({
    id: gid,
    name: `#P4M-${nummer}`,
    createdAt: '2026-01-04T10:00:00Z',
    cancelledAt: null,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    email: 'prozesstest@example.com',
    tags: [],
    totalPriceSet: { shopMoney: { amount: '149.00', currencyCode: 'EUR' } },
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
          title: `Prozesstest MTO-Artikel ${nummer}`,
          sku: `PT-MTO-${nummer}`,
          quantity: 1,
          currentQuantity: 1,
          variant: { id: `gid://shopify/ProductVariant/${nummer}` },
          originalUnitPriceSet: { shopMoney: { amount: '149.00' } },
        },
      ],
    },
  } as never)

  await sql`
    insert into shopify_webhook_events (webhook_id, topic, shopify_order_id, payload)
    values (${`prozesstest-m-${nummer}`}, 'orders/paid', ${gid}, ${sql.json({ id: gid })})
    on conflict (webhook_id) do nothing`
  const { processPendingWebhooks } = await import('../../integrationen/import.ts')
  await processPendingWebhooks(10)

  const [auftrag] = await sql<{ id: string }[]>`
    select id from sales_orders where shopify_order_id = ${gid} and state = 'sale'`
  assert.ok(auftrag, 'die bezahlte MTO-Bestellung muss bestätigt sein')
  ctx.p4MtoAuftragId = auftrag.id

  // Die Bestätigung hat den Fertigungsauftrag angelegt (MTO-Automatik) …
  const [mo] = await sql<{ id: string; state: string }[]>`
    select id, state from manufacturing_orders where sales_order_id = ${auftrag.id}`
  assert.ok(mo, 'MTO muss den Fertigungsauftrag anlegen')
  assert.equal(mo.state, 'confirmed')
  ctx.p4MtoMoId = mo.id

  // … und die Lieferung wartet unreserviert (kein Erzeugnis auf Lager).
  const [picking] = await sql<{ id: string; state: string }[]>`
    select id, state from stock_pickings
    where origin_model = 'sales_order' and origin_id = ${auftrag.id}`
  assert.ok(picking, 'die Lieferung muss existieren')
  assert.equal(picking.state, 'confirmed', 'ohne Erzeugnis-Bestand keine Reservierung')
  return picking.id
}

/** Der Fertigungszweig: der Auftrag wird fertig gemeldet, das Erzeugnis liegt bereit. */
async function fertigungBereitstellen(ctx: FixtureKontext, sql: Sql): Promise<void> {
  const { aktionAusfuehrenGeprueft } = await import('../torwaechter.ts')
  await aktionAusfuehrenGeprueft(
    'fertigung.fertig_melden',
    { parameter: { mengen: {}, backorder: true }, recordId: ctx.p4MtoMoId },
    { name: 'prozesstest', role: 'admin' },
  )
  const [mo] = await sql<{ state: string }[]>`
    select state from manufacturing_orders where id = ${ctx.p4MtoMoId}`
  assert.equal(mo.state, 'done', 'der Fertigungsauftrag muss fertig sein')

  // Die Fertigmeldung reserviert die wartende Lieferung des Auftrags VON
  // SELBST (mo_produce) — der Beleg rückt im Prozess auf die Verfügbarkeit,
  // angeboten wird direkt das Label.
  const [picking] = await sql<{ state: string }[]>`
    select state from stock_pickings
    where origin_model = 'sales_order' and origin_id = ${ctx.p4MtoAuftragId}`
  assert.equal(picking.state, 'assigned', 'die Fertigmeldung muss die Lieferung reservieren')
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
    {
      // BUG/00003: fertigen auf Bestellung — der sichtbare Fertigungszweig.
      // 'verfuegbarkeit' fehlt im Pfad: die Fertigmeldung reserviert die
      // Lieferung selbst (mo_produce), der Beleg steht danach schon dort.
      name: 'Produktionsartikel: Fertigungsauftrag entsteht, dann Versand',
      pfad: ['bestellung', 'fertigen', 'label', 'buchen', 'fulfillment'],
      ereignisse: {
        bestellung: mtoBestellungEinspeisen,
        fertigen: fertigungBereitstellen,
      },
      eingaben: {
        buchen: { mengen: {}, lose: {}, backorder: false },
      },
      pruefen: async (sql, ctx, pickingId) => {
        const [picking] = await sql<{ state: string }[]>`
          select state from stock_pickings where id = ${pickingId}`
        assert.equal(picking.state, 'done')

        // Komponenten sind per Backflush verbraucht, der Auftrag ist geliefert.
        const verbraucht = await sql<{ qty_done: number }[]>`
          select qty_done from stock_moves
          where production_id = ${ctx.p4MtoMoId} and variant_id = ${ctx.teilId}
            and state = 'done'`
        assert.ok(verbraucht.length > 0, 'die Komponente muss verbraucht sein')
        const [auftrag] = await sql<{ delivery_status: string | null }[]>`
          select delivery_status from sales_orders where id = ${ctx.p4MtoAuftragId}`
        assert.equal(auftrag.delivery_status, 'full')

        // Und die Shop-Rückmeldung ist durch.
        const [sendung] = await sql<{ shopify_fulfillment_id: string | null }[]>`
          select shopify_fulfillment_id from shipments where picking_id = ${pickingId}`
        assert.ok(sendung?.shopify_fulfillment_id, 'das Fulfillment muss gemeldet sein')
      },
    },
    {
      // Der Packtisch-Weg (0075): EIN Schritt prüft die gescannten SKUs,
      // erstellt das Label, bucht den Warenausgang und reiht die
      // Shop-Rückmeldung ein — der reale Ablauf am Packtisch mit Zettel
      // und Scanner (docs/module/versand.md).
      name: 'Packtisch: MTO-Bestellung, Scan-Abschluss in einem Zug',
      pfad: ['bestellung', 'fertigen', 'packtisch', 'fulfillment'],
      ereignisse: {
        bestellung: mtoBestellungEinspeisen,
        fertigen: fertigungBereitstellen,
      },
      eingaben: {
        packtisch: (ctx) => {
          // Druckbrücke „konfiguriert" stellen, damit der Abschluss auch
          // das Einreihen des Druckauftrags beweist (0077, Pull-Modell).
          process.env.DRUCK_AGENT_TOKEN ??= 'prozesstest-token'
          return { gepackt: { [ctx.p4MtoSku]: 1 } }
        },
      },
      pruefen: async (sql, ctx, pickingId) => {
        // Ein Schritt, drei Wirkungen: Ware raus, Sendung mit Label,
        // Fulfillment gemeldet.
        const [picking] = await sql<{ state: string }[]>`
          select state from stock_pickings where id = ${pickingId}`
        assert.equal(picking.state, 'done')

        const [sendung] = await sql<
          { shipment_number: string; label_pdf: unknown; shopify_fulfillment_id: string | null }[]
        >`
          select shipment_number, label_pdf, shopify_fulfillment_id
          from shipments where picking_id = ${pickingId}`
        assert.ok(sendung, 'die Sendung muss existieren')
        assert.ok(sendung.label_pdf, 'das Label muss gespeichert sein')
        assert.ok(sendung.shopify_fulfillment_id, 'das Fulfillment muss gemeldet sein')

        const [auftrag] = await sql<{ delivery_status: string | null }[]>`
          select delivery_status from sales_orders where id = ${ctx.p4MtoAuftragId}`
        assert.equal(auftrag.delivery_status, 'full')

        // Vierte Wirkung mit gesetztem DRUCK_AGENT_TOKEN: das Label wartet
        // als offener Druckauftrag auf den Agenten der Druckbrücke.
        const [druck] = await sql<{ status: string }[]>`
          select d.status from druckauftraege d
          join shipments s on s.id = d.shipment_id
          where s.picking_id = ${pickingId}`
        assert.ok(druck, 'der Druckauftrag muss eingereiht sein')
        assert.equal(druck.status, 'offen')
      },
    },
  ],
}
