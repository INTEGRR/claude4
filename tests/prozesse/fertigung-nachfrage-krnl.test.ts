/**
 * Nachfrage an die Fertigung auch bei von Hand gebuchter Lieferung
 * (Entscheidungslog 2026-10-17, UX-Audit): Wird die letzte Lieferung eines
 * Verkaufsauftrags in KRNL gebucht, obwohl sein Fertigungsauftrag noch offen
 * ist, entsteht dieselbe Nachfrage wie beim Versand außerhalb von KRNL —
 * aber nicht, solange eine Restlieferung offen ist (dann gehört der
 * Fertigungsauftrag zu ihr).
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'
import { fertigungsNachfragenNachziehen } from '../../src/modules/verkauf/extern-versand.ts'

const DATENBANK = 'erp_fertigung_nachfrage_check'
const ADMIN = { name: 'nachfrage-test', role: 'admin' as const }
let h: Harness

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

async function mtoAuftrag(): Promise<{ id: string; nummer: string }> {
  const sql = h.sql
  const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [komp] = await sql<{ id: string }[]>`
    insert into product_templates (name, uom_id) values ('Nachfrage Komponente', ${stueck.id}) returning id`
  await sql`select generate_variants(${komp.id})`
  const [kv] = await sql<{ id: string }[]>`select id from product_variants where template_id = ${komp.id}`
  const [tpl] = await sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, route_manufacture, route_mto)
    values ('Nachfrage Gerät', ${stueck.id}, true, true) returning id`
  await sql`select generate_variants(${tpl.id})`
  const [v] = await sql<{ id: string }[]>`update product_variants set sku = 'NF-GERAET' where template_id = ${tpl.id} returning id`
  const [bom] = await sql<{ id: string }[]>`insert into boms (template_id, qty, uom_id) values (${tpl.id}, 1, ${stueck.id}) returning id`
  await sql`insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id) values (${bom.id}, 10, ${kv.id}, 1, ${stueck.id})`

  const [kunde] = await sql<{ id: string }[]>`insert into partners (name, is_customer) values ('Nachfrage-Kunde', true) returning id`
  const id = (await aktionAusfuehrenGeprueft('verkauf.auftrag_anlegen', { parameter: { partner_id: kunde.id } }, ADMIN)).recordId!
  await aktionAusfuehrenGeprueft('verkauf.position_hinzufuegen',
    { recordId: id, parameter: { variant_id: v.id, qty: 2, price_unit: 100 } }, ADMIN)
  await aktionAusfuehrenGeprueft('verkauf.bestaetigen', { recordId: id }, ADMIN)
  const [so] = await sql<{ number: string }[]>`select number from sales_orders where id = ${id}`
  return { id, nummer: so.number }
}

async function offeneLieferung(auftrag: string): Promise<{ picking: string; move: string }> {
  const [p] = await h.sql<{ picking: string; move: string }[]>`
    select p.id as picking, m.id as move from stock_pickings p
    join stock_moves m on m.picking_id = p.id
    where p.origin_model = 'sales_order' and p.origin_id = ${auftrag} and p.state not in ('done', 'cancel')
    order by p.created_at limit 1`
  return p
}

const nachfragen = async (nummer: string) =>
  h.sql<{ id: string; titel: string; status: string; erstellt_von: string }[]>`
    select id, titel, status, erstellt_von from aufgaben
    where rolle = 'fertigung' and titel like ${`%zu ${nummer}%`} order by created_at`

describe('Nachfrage an die Fertigung bei von Hand gebuchter Lieferung', () => {
  let a: { id: string; nummer: string }

  test('Teillieferung mit offener Restlieferung → keine Nachfrage', async () => {
    a = await mtoAuftrag()
    const [mo] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from manufacturing_orders where sales_order_id = ${a.id} and state not in ('done', 'cancel')`
    assert.ok(mo.n > 0, 'der MTO-Auftrag hat einen offenen Fertigungsauftrag')
    const l = await offeneLieferung(a.id)
    await aktionAusfuehrenGeprueft('lager.transfer_buchen',
      { recordId: l.picking, parameter: { mengen: { [l.move]: 1 }, backorder: true } }, ADMIN)
    assert.equal((await nachfragen(a.nummer)).length, 0, 'der Fertigungsauftrag gehört zur Restlieferung')
  })

  test('letzte Lieferung gebucht, Fertigung offen → Nachfrage sofort, ohne Doppel', async () => {
    const rest = await offeneLieferung(a.id)
    await aktionAusfuehrenGeprueft('lager.transfer_buchen',
      { recordId: rest.picking, parameter: { mengen: { [rest.move]: 1 }, backorder: false } }, ADMIN)
    const n = await nachfragen(a.nummer)
    assert.equal(n.length, 1)
    assert.match(n[0].titel, /^Versendet ohne Fertigmeldung: Fertigung /)
    assert.equal(n[0].status, 'offen')
    assert.equal(n[0].erstellt_von, 'system')

    assert.equal(await fertigungsNachfragenNachziehen(h.sql), 0, 'der Abgleich legt keine zweite an')
    await assert.rejects(
      aktionAusfuehrenGeprueft('aufgaben.erledigen', { parameter: { aufgabe: n[0].id } }, ADMIN),
      /am Fertigungsauftrag beantwortet/,
      'abhaken allein beantwortet die Frage nicht',
    )
  })

  test('Fertigungsauftrag storniert → Nachfrage abgehakt', async () => {
    const mos = await h.sql<{ id: string }[]>`
      select id from manufacturing_orders where sales_order_id = ${a.id} and state not in ('done', 'cancel')`
    for (const m of mos) await aktionAusfuehrenGeprueft('fertigung.stornieren', { recordId: m.id }, ADMIN)
    const n = await nachfragen(a.nummer)
    assert.equal(n[0].status, 'erledigt')
  })
})
