/**
 * Das Label bucht aus (0103, Entscheidungslog 2026-10-01): „Label erstellen"
 * und der Massendruck buchen Warenausgang und Shop-Rückmeldung mit — „nur
 * Label" ist die Ausnahme per Haken. Gelabelte, nicht ausgebuchte
 * Lieferungen lassen sich nachbuchen, und nach einem Storno bekommt eine
 * ausgebuchte Lieferung ein Ersatz-Label, dessen Nummer an den Shop geht.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_label_ausbuchen_check'
const ADMIN = { name: 'label-test', role: 'admin' as const }
let h: Harness
let nr = 0

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

/** Eine versandbereite Lieferung zu einer Shop-Bestellung. */
async function lieferung(sku: string): Promise<string> {
  const sql = h.sql
  const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, weight_g)
    values (${`Labeltest ${sku}`}, ${stueck.id}, 500) returning id`
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
    values (${`Kunde ${sku}`}, true, 'Hauptstraße', '1', '10115', 'Berlin', 'DE')
    returning id`
  const angelegt = await aktionAusfuehrenGeprueft(
    'verkauf.auftrag_anlegen', { parameter: { partner_id: kunde.id } }, ADMIN)
  const auftrag = angelegt.recordId!
  await aktionAusfuehrenGeprueft(
    'verkauf.position_hinzufuegen',
    { recordId: auftrag, parameter: { variant_id: variante.id, qty: 1, price_unit: 10 } },
    ADMIN,
  )
  await aktionAusfuehrenGeprueft('verkauf.bestaetigen', { recordId: auftrag }, ADMIN)
  await sql`update sales_orders set shopify_order_id = ${`gid://shopify/Order/7700${++nr}`} where id = ${auftrag}`
  const [p] = await sql<{ id: string; state: string }[]>`
    select id, state from stock_pickings
    where origin_model = 'sales_order' and origin_id = ${auftrag}`
  assert.equal(p.state, 'assigned', 'die Lieferung muss versandbereit sein')
  return p.id
}

const zustand = async (picking: string) =>
  (await h.sql<{ state: string }[]>`select state from stock_pickings where id = ${picking}`)[0].state

/** Eingereihte Shop-Rückmeldungen je Sendung der Lieferung. */
async function rueckmeldungen(picking: string): Promise<number> {
  const [{ n }] = await h.sql<{ n: number }[]>`
    select count(*)::int as n from integration_jobs j
    join shipments s on s.id::text = j.payload ->> 'shipment_id'
    where j.kind = 'shopify_fulfillment_create' and s.picking_id = ${picking}`
  return n
}

describe('Label bucht aus', () => {
  const l: Record<string, string> = {}

  test('Label erstellen: Warenausgang gebucht, Shop-Rückmeldung eingereiht', async () => {
    l.eins = await lieferung('LA-1')
    const r = await aktionAusfuehrenGeprueft('versand.label_erstellen', { recordId: l.eins }, ADMIN)
    assert.match(r.text ?? '', /ausgebucht, Shop-Rückmeldung eingereiht/)
    assert.equal(await zustand(l.eins), 'done')
    assert.equal(await rueckmeldungen(l.eins), 1)
  })

  test('„nur Label" bleibt reserviert — „Gelabelte ausbuchen" holt es nach', async () => {
    l.zwei = await lieferung('LA-2')
    const formular = new FormData()
    formular.set('nicht_ausbuchen', 'on')
    const r = await aktionAusfuehrenGeprueft('versand.label_erstellen', { recordId: l.zwei, formData: formular }, ADMIN)
    assert.match(r.text ?? '', /nicht ausgebucht \(nur Label\)/)
    assert.equal(await zustand(l.zwei), 'assigned')
    assert.equal(await rueckmeldungen(l.zwei), 0, 'ohne Ausbuchen keine Shop-Rückmeldung')

    const { gelabeltNichtAusgebucht } = await import('../../src/modules/versand/gelabelt.ts')
    assert.deepEqual((await gelabeltNichtAusgebucht()).map((g) => g.picking_id), [l.zwei])

    const auswahl = new FormData()
    auswahl.append('ids', l.zwei)
    const nach = await aktionAusfuehrenGeprueft('versand.gelabelte_ausbuchen', { formData: auswahl }, ADMIN)
    assert.deepEqual(nach.daten, { ausgebucht: 1, fehler: 0 })
    assert.equal(await zustand(l.zwei), 'done')
    assert.equal(await rueckmeldungen(l.zwei), 1)
    await assert.rejects(
      aktionAusfuehrenGeprueft('versand.gelabelte_ausbuchen', {}, ADMIN),
      /Keine Lieferung mit Label/,
    )
  })

  test('Massendruck bucht jede Lieferung aus — mit Haken nur Labels', async () => {
    const a = await lieferung('LA-MD-A')
    const b = await lieferung('LA-MD-B')
    const r = await aktionAusfuehrenGeprueft(
      'versand.massendruck', { parameter: { sku: 'LA-MD-' } }, ADMIN)
    assert.match(r.text ?? '', /2 Labels erstellt — 2 ausgebucht/)
    assert.deepEqual([await zustand(a), await zustand(b)], ['done', 'done'])

    const c = await lieferung('LA-MN-C')
    const formular = new FormData()
    formular.set('sku', 'LA-MN-')
    formular.set('nicht_ausbuchen', 'on')
    const nur = await aktionAusfuehrenGeprueft('versand.massendruck', { formData: formular }, ADMIN)
    assert.match(nur.text ?? '', /nicht ausgebucht \(nur Labels\)/)
    assert.equal(await zustand(c), 'assigned')
  })

  test('Ersatz-Label nach Storno: die neue Sendungsnummer geht an den Shop', async () => {
    await assert.rejects(
      aktionAusfuehrenGeprueft('versand.label_erstellen', { recordId: l.eins }, ADMIN),
      /bereits abgeschlossen/,
      'ohne Storno kein zweites Label für eine ausgebuchte Lieferung',
    )
    const [alt] = await h.sql<{ id: string }[]>`
      update shipments set shopify_fulfillment_id = 'gid://shopify/Fulfillment/4711'
      where picking_id = ${l.eins} returning id`
    await aktionAusfuehrenGeprueft('versand.label_stornieren', { recordId: alt.id }, ADMIN)

    const r = await aktionAusfuehrenGeprueft('versand.label_erstellen', { recordId: l.eins }, ADMIN)
    assert.match(r.text ?? '', /schon ausgebucht — die neue Sendungsnummer geht an den Shop/)
    const [neu] = await h.sql<{ shopify_fulfillment_id: string | null; state: string }[]>`
      select shopify_fulfillment_id, state from shipments
      where picking_id = ${l.eins} and id <> ${alt.id}`
    assert.equal(neu.shopify_fulfillment_id, 'gid://shopify/Fulfillment/4711', 'Tracking-Nachtrag statt neuem Fulfillment')
    assert.equal(await rueckmeldungen(l.eins), 2)
    assert.equal(await zustand(l.eins), 'done')
  })
})
