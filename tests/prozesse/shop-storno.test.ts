/**
 * Storno führt Shopify (0110, Entscheidungslog 2026-10-02): KRNL storniert
 * Shop-Aufträge nicht selbst und meldet nichts an den Shop. Der Shop-Storno
 * (Webhook) storniert hier und zieht alles Nachgelagerte mit — Lieferung,
 * offene Druckaufträge, wartende Shop-Rückmeldungen, DHL-Label; liegt ein
 * ausgebuchtes Paket womöglich noch im Haus, bekommt das Lager eine Aufgabe.
 * Aufträge, die nicht aus dem Shop kommen, storniert KRNL wie bisher.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_shop_storno_check'
const ADMIN = { name: 'storno-test', role: 'admin' as const }
let h: Harness
let nr = 0

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

/** Bestätigter Auftrag mit versandbereiter Lieferung — wahlweise als Shop-Auftrag. */
async function auftrag(sku: string, shop: boolean): Promise<{ auftrag: string; picking: string; gid: string }> {
  const sql = h.sql
  const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, weight_g)
    values (${`Stornotest ${sku}`}, ${stueck.id}, 400) returning id`
  await sql`select generate_variants(${tpl.id})`
  const [variante] = await sql<{ id: string }[]>`
    update product_variants set sku = ${sku} where template_id = ${tpl.id} returning id`
  const [ort] = await sql<{ id: string }[]>`select id from stock_locations where full_path = 'WH/Stock'`
  const [zaehlung] = await sql<{ id: string }[]>`
    insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
    values (${ort.id}, ${variante.id}, 3, 0) returning id`
  await sql`select inventory_apply(${zaehlung.id}, 'test')`
  const [kunde] = await sql<{ id: string }[]>`
    insert into partners (name, is_customer, street, house_number, zip, city, country_code)
    values (${`Kunde ${sku}`}, true, 'Hauptstraße', '1', '10115', 'Berlin', 'DE') returning id`

  const angelegt = await aktionAusfuehrenGeprueft(
    'verkauf.auftrag_anlegen', { parameter: { partner_id: kunde.id } }, ADMIN)
  const id = angelegt.recordId!
  await aktionAusfuehrenGeprueft(
    'verkauf.position_hinzufuegen',
    { recordId: id, parameter: { variant_id: variante.id, qty: 1, price_unit: 10 } },
    ADMIN,
  )
  await aktionAusfuehrenGeprueft('verkauf.bestaetigen', { recordId: id }, ADMIN)
  const gid = `gid://shopify/Order/8800${++nr}`
  if (shop) {
    await sql`update sales_orders set source = 'shopify', shopify_order_id = ${gid},
                shopify_order_name = ${`#ST-${nr}`} where id = ${id}`
  }
  const [p] = await sql<{ id: string }[]>`
    select id from stock_pickings where origin_model = 'sales_order' and origin_id = ${id}`
  return { auftrag: id, picking: p.id, gid }
}

/** Der Shop-Storno, wie ihn der Webhook verarbeitet (bestehender Auftrag). */
async function stornoImShop(gid: string, name = '#ST'): Promise<string> {
  const { importShopifyOrder } = await import('../../src/modules/integrationen/import.ts')
  const r = await importShopifyOrder({
    id: gid,
    name,
    cancelledAt: '2026-10-02T09:00:00Z',
    displayFinancialStatus: 'REFUNDED',
  } as never)
  return r.message
}

const zeile = async <T>(abfrage: Promise<T[]>) => (await abfrage)[0]

describe('Storno führt Shopify', () => {
  test('KRNL lehnt Storno und Reaktivierung eines Shop-Auftrags ab', async () => {
    const a = await auftrag('ST-ABL', true)
    await assert.rejects(
      aktionAusfuehrenGeprueft('verkauf.stornieren', { recordId: a.auftrag }, ADMIN),
      /im Shopify-Admin stornieren/,
    )
    const stand = await zeile(h.sql<{ state: string }[]>`select state from sales_orders where id = ${a.auftrag}`)
    assert.equal(stand.state, 'sale', 'nichts storniert')

    await stornoImShop(a.gid)
    await assert.rejects(
      aktionAusfuehrenGeprueft('verkauf.zurueck_auf_angebot', { recordId: a.auftrag }, ADMIN),
      /im Shopify-Admin stornieren/,
      'ein im Shop stornierter Auftrag lebt in KRNL nicht wieder auf',
    )
  })

  test('Shop-Storno: Lieferung, nur-Label und Packzettel werden mit storniert', async () => {
    const a = await auftrag('ST-LBL', true)
    const formular = new FormData()
    formular.set('nicht_ausbuchen', 'on')
    await aktionAusfuehrenGeprueft('versand.label_erstellen', { recordId: a.picking, formData: formular }, ADMIN)
    const [druck] = await h.sql<{ id: string }[]>`
      insert into druckauftraege (art, picking_id) values ('packzettel', ${a.picking})
      returning id`

    const meldung = await stornoImShop(a.gid)
    assert.match(meldung, /storniert/)

    const auftragStand = await zeile(h.sql<{ state: string }[]>`select state from sales_orders where id = ${a.auftrag}`)
    assert.equal(auftragStand.state, 'cancel')
    const lieferung = await zeile(h.sql<{ state: string }[]>`select state from stock_pickings where id = ${a.picking}`)
    assert.equal(lieferung.state, 'cancel')
    const sendung = await zeile(h.sql<{ state: string }[]>`select state from shipments where picking_id = ${a.picking}`)
    assert.equal(sendung.state, 'cancelled', 'das DHL-Label ist storniert')
    const zettel = await zeile(h.sql<{ status: string; fehler: string | null }[]>`
      select status, fehler from druckauftraege where id = ${druck.id}`)
    assert.equal(zettel.status, 'fehler')
    assert.match(zettel.fehler ?? '', /storniert/)

    const [{ n }] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from integration_jobs where kind = 'shopify_order_cancel'`
    assert.equal(n, 0, 'KRNL meldet keinen Storno an Shopify')
  })

  test('ausgebucht, aber nicht übergeben: Shop-Rückmeldung verworfen, Aufgabe fürs Lager', async () => {
    const a = await auftrag('ST-AUS', true)
    await aktionAusfuehrenGeprueft('versand.label_erstellen', { recordId: a.picking }, ADMIN)
    const [{ wartend }] = await h.sql<{ wartend: number }[]>`
      select count(*)::int as wartend from integration_jobs j
      join shipments s on s.id::text = j.payload ->> 'shipment_id'
      where j.kind = 'shopify_fulfillment_create' and j.status = 'pending' and s.picking_id = ${a.picking}`
    assert.equal(wartend, 1, 'das Label hat ausgebucht und die Rückmeldung eingereiht')

    await stornoImShop(a.gid, '#ST-AUS')

    const lieferung = await zeile(h.sql<{ state: string }[]>`select state from stock_pickings where id = ${a.picking}`)
    assert.equal(lieferung.state, 'done', 'Ausgebuchtes bleibt — Korrektur per Retoure')
    const sendung = await zeile(h.sql<{ state: string }[]>`select state from shipments where picking_id = ${a.picking}`)
    assert.equal(sendung.state, 'created', 'ob das Paket schon weg ist, entscheidet das Lager')
    const job = await zeile(h.sql<{ status: string; last_result: string | null }[]>`
      select j.status, j.last_result from integration_jobs j
      join shipments s on s.id::text = j.payload ->> 'shipment_id'
      where j.kind = 'shopify_fulfillment_create' and s.picking_id = ${a.picking}`)
    assert.equal(job.status, 'done')
    assert.match(job.last_result ?? '', /Übersprungen: Auftrag storniert/)

    const aufgaben = await h.sql<{ titel: string; rolle: string }[]>`
      select titel, rolle::text as rolle from aufgaben where titel like ${'%nicht verschicken%'} and status = 'offen'`
    assert.equal(aufgaben.length, 1)
    assert.equal(aufgaben[0].rolle, 'lager')

    // Ein zweiter Webhook (Erstattung nach dem Storno) legt nichts doppelt an.
    await stornoImShop(a.gid, '#ST-AUS')
    const [{ n }] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from aufgaben where titel like ${'%nicht verschicken%'}`
    assert.equal(n, 1)
  })

  test('manueller Auftrag: Storno in KRNL wie bisher — samt Label', async () => {
    const a = await auftrag('ST-MAN', false)
    const formular = new FormData()
    formular.set('nicht_ausbuchen', 'on')
    await aktionAusfuehrenGeprueft('versand.label_erstellen', { recordId: a.picking, formData: formular }, ADMIN)
    await aktionAusfuehrenGeprueft('verkauf.stornieren', { recordId: a.auftrag }, ADMIN)

    const stand = await zeile(h.sql<{ state: string }[]>`select state from sales_orders where id = ${a.auftrag}`)
    assert.equal(stand.state, 'cancel')
    const sendung = await zeile(h.sql<{ state: string }[]>`select state from shipments where picking_id = ${a.picking}`)
    assert.equal(sendung.state, 'cancelled')
    // Und zurück auf Angebot geht für manuelle Aufträge weiterhin.
    await aktionAusfuehrenGeprueft('verkauf.zurueck_auf_angebot', { recordId: a.auftrag }, ADMIN)
  })
})
