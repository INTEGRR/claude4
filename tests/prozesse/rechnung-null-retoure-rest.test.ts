/**
 * UX-Audit-Fixes gegen die echte Datenbank:
 *  - 0124: eine Rechnung über 0,00 € ist ausgeglichen (bezahlt), nicht offen,
 *    und wird nicht gemahnt;
 *  - 0125: retoure_anlegen prüft die Restmenge auch innerhalb eines Aufrufs
 *    (dieselbe Zeile zweimal), retoure_restmenge steuert den Knopf am Auftrag.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_null_retoure_check'
const ADMIN = { name: 'null-retoure-test', role: 'admin' as const }
let h: Harness

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

/** Bestätigter, vollständig gelieferter Auftrag über eine Position. */
async function gelieferterAuftrag(sku: string, preis: number, shop: boolean): Promise<{ id: string; zeile: string; picking: string }> {
  const sql = h.sql
  const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, weight_g) values (${`Nulltest ${sku}`}, ${stueck.id}, 200) returning id`
  await sql`select generate_variants(${tpl.id})`
  const [v] = await sql<{ id: string }[]>`update product_variants set sku = ${sku} where template_id = ${tpl.id} returning id`
  const [ort] = await sql<{ id: string }[]>`select id from stock_locations where full_path = 'WH/Stock'`
  const [z] = await sql<{ id: string }[]>`
    insert into inventory_counts (location_id, variant_id, counted_qty, book_qty) values (${ort.id}, ${v.id}, 5, 0) returning id`
  await sql`select inventory_apply(${z.id}, 'test')`
  const [kunde] = await sql<{ id: string }[]>`
    insert into partners (name, is_customer, is_company, street, house_number, zip, city, country_code)
    values (${`Firma ${sku}`}, true, true, 'Weg', '1', '10115', 'Berlin', 'DE') returning id`
  const id = (await aktionAusfuehrenGeprueft('verkauf.auftrag_anlegen', { parameter: { partner_id: kunde.id } }, ADMIN)).recordId!
  await aktionAusfuehrenGeprueft('verkauf.position_hinzufuegen',
    { recordId: id, parameter: { variant_id: v.id, qty: 1, price_unit: preis } }, ADMIN)
  await aktionAusfuehrenGeprueft('verkauf.bestaetigen', { recordId: id }, ADMIN)
  if (shop) {
    await sql`update sales_orders set source = 'shopify', shopify_order_id = ${`gid://shopify/Order/77${sku.length}${Date.now() % 100000}`},
                shopify_order_name = ${`#NR-${sku}`} where id = ${id}`
  }
  const [p] = await sql<{ id: string }[]>`select id from stock_pickings where origin_model = 'sales_order' and origin_id = ${id}`
  await sql`select picking_validate(${p.id}, '{}'::jsonb, false)`
  const [zeile] = await sql<{ id: string }[]>`select id from sales_order_lines where order_id = ${id}`
  return { id, zeile: zeile.id, picking: p.id }
}

describe('Rechnung über 0,00 €', () => {
  test('ist sofort ausgeglichen und nicht mahnbar', async () => {
    const a = await gelieferterAuftrag('NULL-1', 0, false)
    let [r] = await h.sql<{ id: string }[]>`
      select id from kundenrechnungen where sales_order_id = ${a.id} and art = 'rechnung'`
    if (!r) [r] = await h.sql<{ id: string }[]>`select kundenrechnung_aus_lieferung(${a.picking}, 'test') as id`
    const [k] = await h.sql<{ status: string; brutto: number }[]>`
      select status::text, brutto from kundenrechnungen where id = ${r.id}`
    assert.equal(Number(k.brutto), 0)
    assert.equal(k.status, 'bezahlt')

    // Auch eine (Alt-)Rechnung, die offen steht, mahnt KRNL ohne offenen Betrag nicht.
    await h.sql`update kundenrechnungen set status = 'offen', faellig_am = current_date - 30 where id = ${r.id}`
    await assert.rejects(h.sql`select kundenrechnung_mahnen(${r.id}, 'test')`, /keinen offenen Betrag/)
  })
})

describe('Retoure: Restmenge', () => {
  test('dieselbe Zeile zweimal im selben Aufruf übersteigt die Liefermenge nicht', async () => {
    const a = await gelieferterAuftrag('RET-1', 49, true)
    const [rest] = await h.sql<{ rest: number }[]>`select retoure_restmenge(${a.id}) as rest`
    assert.equal(Number(rest.rest), 1)
    await assert.rejects(
      h.sql`select retoure_anlegen(${a.id}, ${h.sql.json([{ zeile: a.zeile, menge: 1 }, { zeile: a.zeile, menge: 1 }])}::jsonb)`,
      /höchstens 0 zurücksendbar/,
    )
    await h.sql`select retoure_anlegen(${a.id}, ${h.sql.json([{ zeile: a.zeile, menge: 1 }])}::jsonb)`
    const [danach] = await h.sql<{ rest: number }[]>`select retoure_restmenge(${a.id}) as rest`
    assert.equal(Number(danach.rest), 0, 'nichts mehr rücksendbar — der Knopf verschwindet')
  })
})
