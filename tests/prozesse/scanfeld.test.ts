/**
 * Das eine Scanfeld (Entscheidungslog 2026-10-01): die gescannte Nummer
 * entscheidet den Ablauf. Lieferung (Packzettel, Auftrags- oder
 * Shop-Nummer) → Packablauf; Wareneingang → Checkliste; Fertigungsauftrag →
 * Komponenten-Checkliste. Eine Lieferung wird nie bloß als Transfer
 * geliefert — sonst ginge Ware ohne Label raus.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_scanfeld_check'
const ADMIN = { name: 'scanfeld-test', role: 'admin' as const }
const ALLE = { picking: true, mo: true, versand: true }
let h: Harness
const beleg: Record<string, string> = {}

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

async function artikel(sku: string, menge: number, fertigung = false): Promise<string> {
  const [stueck] = await h.sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await h.sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, weight_g, route_manufacture)
    values (${`Scanfeld ${sku}`}, ${stueck.id}, 300, ${fertigung}) returning id`
  await h.sql`select generate_variants(${tpl.id})`
  const [v] = await h.sql<{ id: string }[]>`
    update product_variants set sku = ${sku} where template_id = ${tpl.id} returning id`
  if (menge) {
    const [ort] = await h.sql<{ id: string }[]>`select id from stock_locations where full_path = 'WH/Stock'`
    const [z] = await h.sql<{ id: string }[]>`
      insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
      values (${ort.id}, ${v.id}, ${menge}, 0) returning id`
    await h.sql`select inventory_apply(${z.id}, 'test')`
  }
  return v.id
}

const laden = async (code: string, rechte = ALLE) => {
  const { scanBelegLaden } = await import('../../src/modules/scanner-beleg.ts')
  return scanBelegLaden(code, rechte)
}

describe('Ein Scanfeld: die Nummer entscheidet', () => {
  test('Vorbereitung: Lieferung, Wareneingang, Fertigungsauftrag', async () => {
    const teil = await artikel('SF-TEIL', 5)
    const [kunde] = await h.sql<{ id: string }[]>`
      insert into partners (name, is_customer, street, house_number, zip, city, country_code)
      values ('Scanfeld Kunde', true, 'Weg', '2', '10115', 'Berlin', 'DE') returning id`
    const auftrag = (await aktionAusfuehrenGeprueft(
      'verkauf.auftrag_anlegen', { parameter: { partner_id: kunde.id } }, ADMIN)).recordId!
    await aktionAusfuehrenGeprueft('verkauf.position_hinzufuegen',
      { recordId: auftrag, parameter: { variant_id: teil, qty: 1, price_unit: 10 } }, ADMIN)
    await aktionAusfuehrenGeprueft('verkauf.bestaetigen', { recordId: auftrag }, ADMIN)
    const [l] = await h.sql<{ number: string }[]>`
      select number from stock_pickings where origin_model = 'sales_order' and origin_id = ${auftrag}`
    const [so] = await h.sql<{ number: string }[]>`select number from sales_orders where id = ${auftrag}`
    beleg.lieferung = l.number
    beleg.auftrag = so.number

    const [lieferant] = await h.sql<{ id: string }[]>`
      insert into partners (name, is_vendor) values ('Scanfeld Lieferant', true) returning id`
    const bestellung = (await aktionAusfuehrenGeprueft(
      'einkauf.bestellung_anlegen', { parameter: { vendor_id: lieferant.id } }, ADMIN)).recordId!
    await aktionAusfuehrenGeprueft('einkauf.position_hinzufuegen',
      { recordId: bestellung, parameter: { variant_id: teil, qty: 4, price_unit: 2 } }, ADMIN)
    await aktionAusfuehrenGeprueft('einkauf.bestaetigen', { recordId: bestellung }, ADMIN)
    const [eingang] = await h.sql<{ number: string }[]>`
      select p.number from stock_pickings p join operation_types ot on ot.id = p.operation_type_id
      where ot.kind = 'receipt' and p.origin_id = ${bestellung}`
    beleg.eingang = eingang.number

    const produkt = await artikel('SF-PROD', 0, true)
    const [stueck] = await h.sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
    const [bom] = await h.sql<{ id: string }[]>`
      insert into boms (template_id, qty, uom_id)
      select template_id, 1, ${stueck.id} from product_variants where id = ${produkt} returning id`
    await h.sql`insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
                values (${bom.id}, 10, ${teil}, 1, ${stueck.id})`
    const mo = (await aktionAusfuehrenGeprueft(
      'fertigung.auftrag_anlegen', { parameter: { variant_id: produkt, qty: 1 } }, ADMIN)).recordId!
    await aktionAusfuehrenGeprueft('fertigung.bestaetigen', { recordId: mo }, ADMIN)
    const [m] = await h.sql<{ number: string }[]>`select number from manufacturing_orders where id = ${mo}`
    beleg.mo = m.number
  })

  test('Packzettel (Lieferung) → Packablauf, nicht Transfer-Buchung', async () => {
    const r = await laden(beleg.lieferung)
    assert.ok(r.ok && 'versand' in r.antwort, JSON.stringify(r))
    if (r.ok && 'versand' in r.antwort) {
      assert.equal(r.antwort.versand.number, beleg.lieferung)
      assert.deepEqual(r.antwort.versand.lines.map((x) => x.sku), ['SF-TEIL'])
    }
  })

  test('auch per Auftragsnummer und in US-Tastaturbelegung', async () => {
    const perAuftrag = await laden(beleg.auftrag)
    assert.ok(perAuftrag.ok && 'versand' in perAuftrag.antwort)
    const us = await laden(beleg.lieferung.replaceAll('/', '-'))
    assert.ok(us.ok && 'versand' in us.antwort, 'WH-OUT-… vom US-Scanner')
  })

  test('Lieferung ohne Versand-Rechte: Klartext statt Transfer', async () => {
    const r = await laden(beleg.lieferung, { picking: true, mo: true, versand: false })
    assert.deepEqual(r.ok ? null : [r.status, /Schreibrechte im Versand/.test(r.error)], [403, true])
  })

  test('Wareneingang → Checkliste, Fertigungsauftrag → Komponenten-Checkliste', async () => {
    const e = await laden(beleg.eingang)
    assert.ok(e.ok && !('versand' in e.antwort) && e.antwort.type === 'picking', JSON.stringify(e))
    if (e.ok && !('versand' in e.antwort)) assert.equal(e.antwort.label, 'Wareneingang')
    const m = await laden(beleg.mo)
    assert.ok(m.ok && !('versand' in m.antwort) && m.antwort.type === 'mo', JSON.stringify(m))
  })

  test('Unbekanntes bleibt ein Klartext-404', async () => {
    const r = await laden('GIBT-ES-NICHT-42')
    assert.deepEqual(r.ok ? null : r.status, 404)
  })
})
