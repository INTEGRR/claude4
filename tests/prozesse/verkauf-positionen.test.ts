/**
 * Auftragspositionen entfernen (0120, UX-Audit): eine schon gelieferte oder
 * abgerechnete Zeile bleibt — Korrektur über Retoure bzw. Gutschrift. Wie
 * Änderungen nach der Bestätigung grundsätzlich laufen, ist noch offen
 * (docs/vorlagen/auftragsaenderung.md); bis dahin ändert sich sonst nichts.
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

  test('gelieferte Position bleibt, nicht gelieferte darf weiter entfernt werden', async () => {
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
  })
})
