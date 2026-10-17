/**
 * Schreibschutz aus dem Status (F6, Entscheidungslog 2026-10-17): Ist ein
 * Beleg abgeschlossen (Endzustand laut ENDZUSTAENDE in format.ts), lehnen die
 * Aktionen „Verantwortlich/Dringend" ab — die Seiten zeigen dann nur noch an.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_schreibschutz_check'
const ADMIN = { name: 'schreibschutz-test', role: 'admin' as const }
let h: Harness

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

async function geraet(): Promise<string> {
  const sql = h.sql
  const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [komp] = await sql<{ id: string }[]>`
    insert into product_templates (name, uom_id) values ('Schutz-Komponente', ${stueck.id}) returning id`
  await sql`select generate_variants(${komp.id})`
  const [kv] = await sql<{ id: string }[]>`select id from product_variants where template_id = ${komp.id}`
  const [tpl] = await sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, route_manufacture) values ('Schutz-Gerät', ${stueck.id}, true) returning id`
  await sql`select generate_variants(${tpl.id})`
  const [v] = await sql<{ id: string }[]>`select id from product_variants where template_id = ${tpl.id}`
  const [bom] = await sql<{ id: string }[]>`insert into boms (template_id, qty, uom_id) values (${tpl.id}, 1, ${stueck.id}) returning id`
  await sql`insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id) values (${bom.id}, 10, ${kv.id}, 1, ${stueck.id})`
  return v.id
}

describe('Schreibschutz aus dem Status', () => {
  test('Fertigungsauftrag: offen änderbar, storniert nicht', async () => {
    const variante = await geraet()
    const mo = (await aktionAusfuehrenGeprueft('fertigung.auftrag_anlegen', { parameter: { variant_id: variante, qty: 1 } }, ADMIN)).recordId!
    await aktionAusfuehrenGeprueft('fertigung.auftrag_details', { recordId: mo, parameter: { priority: true } }, ADMIN)
    const [offen] = await h.sql<{ priority: string }[]>`select priority from manufacturing_orders where id = ${mo}`
    assert.equal(offen.priority, '1', 'im Entwurf änderbar')

    await aktionAusfuehrenGeprueft('fertigung.stornieren', { recordId: mo }, ADMIN)
    await assert.rejects(
      aktionAusfuehrenGeprueft('fertigung.auftrag_details', { recordId: mo, parameter: { priority: false } }, ADMIN),
      /storniert — Verantwortlich und Dringend lassen sich nicht mehr ändern/,
    )
    const [danach] = await h.sql<{ priority: string }[]>`select priority from manufacturing_orders where id = ${mo}`
    assert.equal(danach.priority, '1', 'unverändert')
  })

  test('Transfer: gebucht nicht mehr änderbar', async () => {
    const sql = h.sql
    const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
    const [tpl] = await sql<{ id: string }[]>`
      insert into product_templates (name, uom_id) values ('Schutz-Ware', ${stueck.id}) returning id`
    await sql`select generate_variants(${tpl.id})`
    const [v] = await sql<{ id: string }[]>`select id from product_variants where template_id = ${tpl.id}`
    const [ort] = await sql<{ id: string }[]>`select id from stock_locations where full_path = 'WH/Stock'`
    const [z] = await sql<{ id: string }[]>`
      insert into inventory_counts (location_id, variant_id, counted_qty, book_qty) values (${ort.id}, ${v.id}, 3, 0) returning id`
    await sql`select inventory_apply(${z.id}, 'test')`
    const [kunde] = await sql<{ id: string }[]>`insert into partners (name, is_customer) values ('Schutz-Kunde', true) returning id`
    const auftrag = (await aktionAusfuehrenGeprueft('verkauf.auftrag_anlegen', { parameter: { partner_id: kunde.id } }, ADMIN)).recordId!
    await aktionAusfuehrenGeprueft('verkauf.position_hinzufuegen',
      { recordId: auftrag, parameter: { variant_id: v.id, qty: 1, price_unit: 10 } }, ADMIN)
    await aktionAusfuehrenGeprueft('verkauf.bestaetigen', { recordId: auftrag }, ADMIN)
    const [p] = await sql<{ id: string }[]>`select id from stock_pickings where origin_model = 'sales_order' and origin_id = ${auftrag}`
    await aktionAusfuehrenGeprueft('lager.transfer_details', { recordId: p.id, parameter: { priority: true } }, ADMIN)
    await sql`select picking_validate(${p.id}, '{}'::jsonb, false)`
    await assert.rejects(
      aktionAusfuehrenGeprueft('lager.transfer_details', { recordId: p.id, parameter: { priority: false } }, ADMIN),
      /erledigt — Verantwortlich und Dringend lassen sich nicht mehr ändern/,
    )
  })
})
