/**
 * Auftragspositionen ändern. 0120 (UX-Audit): eine schon gelieferte oder
 * abgerechnete Zeile bleibt — Korrektur über Retoure bzw. Gutschrift.
 * Option (c), 0129 (Entscheidungslog 2026-10-17): Shop-Aufträge ändert
 * Shopify, Aufträge in KRNL nur, solange nichts geliefert ist. Änderungen von
 * Hand am bestätigten Auftrag ziehen Lieferung und Fertigung nach — derselbe
 * Weg wie Shop-Änderungen (sales_order_lieferung_angleichen).
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_verkauf_positionen_check'
const ADMIN = { name: 'positionen-test', role: 'admin' as const }
let h: Harness

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

/** Auftrag mit zwei Positionen; Bestand reicht nur für die erste. */
async function auftrag(sku: string): Promise<{ id: string; zeilen: string[]; picking: string | null }> {
  const sql = h.sql
  const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const varianten: string[] = []
  for (const s of [`${sku}-A`, `${sku}-B`]) {
    const [tpl] = await sql<{ id: string }[]>`
      insert into product_templates (name, uom_id, weight_g)
      values (${`Positionstest ${s}`}, ${stueck.id}, 300) returning id`
    await sql`select generate_variants(${tpl.id})`
    const [v] = await sql<{ id: string }[]>`
      update product_variants set sku = ${s} where template_id = ${tpl.id} returning id`
    varianten.push(v.id)
  }
  const [ort] = await sql<{ id: string }[]>`select id from stock_locations where full_path = 'WH/Stock'`
  const [z] = await sql<{ id: string }[]>`
    insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
    values (${ort.id}, ${varianten[0]}, 5, 0) returning id`
  await sql`select inventory_apply(${z.id}, 'test')`
  const [kunde] = await sql<{ id: string }[]>`
    insert into partners (name, is_customer, street, house_number, zip, city, country_code)
    values (${`Kunde ${sku}`}, true, 'Weg', '1', '10115', 'Berlin', 'DE') returning id`
  const id = (await aktionAusfuehrenGeprueft(
    'verkauf.auftrag_anlegen', { parameter: { partner_id: kunde.id } }, ADMIN)).recordId!
  for (const v of varianten) {
    await aktionAusfuehrenGeprueft('verkauf.position_hinzufuegen',
      { recordId: id, parameter: { variant_id: v, qty: 1, price_unit: 20 } }, ADMIN)
  }
  const zeilen = (await sql<{ id: string }[]>`
    select id from sales_order_lines where order_id = ${id} order by sequence`).map((r) => r.id)
  return { id, zeilen, picking: null }
}

describe('Auftragspositionen entfernen', () => {
  test('im Entwurf ist jede Position entfernbar', async () => {
    const a = await auftrag('POS-ENTWURF')
    const [r] = await h.sql<{ grund: string | null }[]>`select sales_order_line_entfernbar(${a.zeilen[1]}) as grund`
    assert.equal(r.grund, null)
    await aktionAusfuehrenGeprueft('verkauf.position_entfernen',
      { recordId: a.id, parameter: { line_id: a.zeilen[1] } }, ADMIN)
    const [n] = await h.sql<{ n: number }[]>`select count(*)::int as n from sales_order_lines where order_id = ${a.id}`
    assert.equal(n.n, 1)
  })

  test('nach einer Teillieferung sind die Positionen fest', async () => {
    const a = await auftrag('POS-GELIEFERT')
    await aktionAusfuehrenGeprueft('verkauf.bestaetigen', { recordId: a.id }, ADMIN)
    const [p] = await h.sql<{ id: string }[]>`
      select id from stock_pickings where origin_model = 'sales_order' and origin_id = ${a.id}`
    // Teillieferung: nur Position A ist am Lager (Moves hängen über die Variante an der Zeile).
    const moves = await h.sql<{ id: string; erste: boolean }[]>`
      select sm.id, sm.variant_id = (select variant_id from sales_order_lines where id = ${a.zeilen[0]}) as erste
      from stock_moves sm where sm.picking_id = ${p.id}`
    const erledigt = Object.fromEntries(moves.map((m) => [m.id, m.erste ? 1 : 0]))
    await h.sql`select picking_validate(${p.id}, ${h.sql.json(erledigt)}::jsonb, true)`

    const [geliefert] = await h.sql<{ qty: number }[]>`select qty_delivered as qty from sales_order_lines where id = ${a.zeilen[0]}`
    assert.equal(Number(geliefert.qty), 1, 'Position A ist geliefert')

    await assert.rejects(
      aktionAusfuehrenGeprueft('verkauf.position_entfernen',
        { recordId: a.id, parameter: { line_id: a.zeilen[0] } }, ADMIN),
      /geliefert/,
    )
    const [noch] = await h.sql<{ n: number }[]>`select count(*)::int as n from sales_order_lines where id = ${a.zeilen[0]}`
    assert.equal(noch.n, 1, 'gelieferte Zeile ist noch da')

    // Option (c): auch die nicht gelieferte Zeile bleibt, und nichts kommt dazu.
    await assert.rejects(
      aktionAusfuehrenGeprueft('verkauf.position_entfernen',
        { recordId: a.id, parameter: { line_id: a.zeilen[1] } }, ADMIN),
      /teilgeliefert — Positionen lassen sich nicht mehr ändern/,
    )
    const [v] = await h.sql<{ id: string }[]>`select variant_id as id from sales_order_lines where id = ${a.zeilen[1]}`
    await assert.rejects(
      aktionAusfuehrenGeprueft('verkauf.position_hinzufuegen',
        { recordId: a.id, parameter: { variant_id: v.id, qty: 1, price_unit: 20 } }, ADMIN),
      /geliefert/,
    )
  })

  test('Shop-Auftrag: Positionen ändert Shopify', async () => {
    const a = await auftrag('POS-SHOP')
    await aktionAusfuehrenGeprueft('verkauf.bestaetigen', { recordId: a.id }, ADMIN)
    await h.sql`update sales_orders set source = 'shopify', shopify_order_id = 'gid://shopify/Order/990129' where id = ${a.id}`
    await assert.rejects(
      aktionAusfuehrenGeprueft('verkauf.position_entfernen',
        { recordId: a.id, parameter: { line_id: a.zeilen[1] } }, ADMIN),
      /im Shopify-Admin bearbeiten/,
    )
    const [v] = await h.sql<{ id: string }[]>`select variant_id as id from sales_order_lines where id = ${a.zeilen[0]}`
    await assert.rejects(
      aktionAusfuehrenGeprueft('verkauf.position_hinzufuegen',
        { recordId: a.id, parameter: { variant_id: v.id, qty: 1 } }, ADMIN),
      /im Shopify-Admin bearbeiten/,
    )
    const [n] = await h.sql<{ n: number }[]>`select count(*)::int as n from sales_order_lines where order_id = ${a.id}`
    assert.equal(n.n, 2, 'unverändert')
  })

  test('bestätigter Auftrag: Entfernen und Hinzufügen ziehen die Lieferung nach', async () => {
    const a = await auftrag('POS-ANGLEICH')
    await aktionAusfuehrenGeprueft('verkauf.bestaetigen', { recordId: a.id }, ADMIN)
    const offeneMengen = async () =>
      new Map((await h.sql<{ sku: string; qty: number }[]>`
        select pv.sku, sum(sm.qty)::float as qty from stock_moves sm
        join stock_pickings p on p.id = sm.picking_id
        join product_variants pv on pv.id = sm.variant_id
        where p.origin_model = 'sales_order' and p.origin_id = ${a.id} and sm.state not in ('done', 'cancel')
        group by pv.sku`).map((r) => [r.sku, Number(r.qty)]))
    assert.deepEqual(await offeneMengen(), new Map([['POS-ANGLEICH-A', 1], ['POS-ANGLEICH-B', 1]]))

    await aktionAusfuehrenGeprueft('verkauf.position_entfernen',
      { recordId: a.id, parameter: { line_id: a.zeilen[1] } }, ADMIN)
    assert.deepEqual(await offeneMengen(), new Map([['POS-ANGLEICH-A', 1]]), 'die entfernte Zeile wird nicht mehr geliefert')

    const [v] = await h.sql<{ id: string }[]>`select id from product_variants where sku = 'POS-ANGLEICH-B'`
    await aktionAusfuehrenGeprueft('verkauf.position_hinzufuegen',
      { recordId: a.id, parameter: { variant_id: v.id, qty: 3, price_unit: 20 } }, ADMIN)
    assert.deepEqual(await offeneMengen(), new Map([['POS-ANGLEICH-A', 1], ['POS-ANGLEICH-B', 3]]), 'die neue Zeile wird geliefert')
  })
})
