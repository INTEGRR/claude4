/**
 * Vorsteuer-Standard nach Lieferantenland (0121, UX-Audit): Lieferanten im
 * Ausland stellen keine deutsche Umsatzsteuer in Rechnung — die Bestellzeile
 * bekommt 0 %. Inland wie bisher: Produktsteuer, ohne Produktsteuer 19 %.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_einkauf_vorsteuer_check'
const ADMIN = { name: 'vorsteuer-test', role: 'admin' as const }
let h: Harness
let variante = ''

before(async () => {
  h = await harnessStart(DATENBANK)
  const [stueck] = await h.sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await h.sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, can_be_purchased, route_buy)
    values ('Vorsteuer-Testteil', ${stueck.id}, true, true) returning id`
  await h.sql`select generate_variants(${tpl.id})`
  const [v] = await h.sql<{ id: string }[]>`select id from product_variants where template_id = ${tpl.id}`
  variante = v.id
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

async function zeileBei(land: string | null): Promise<{ satz: number; steuer: string | null }> {
  const [l] = await h.sql<{ id: string }[]>`
    insert into partners (name, is_vendor, email, country_code)
    values (${`Lieferant ${land ?? 'ohne Land'}`}, true, ${`l-${land ?? 'x'}@example.com`}, ${land ?? ''}) returning id`
  const po = (await aktionAusfuehrenGeprueft('einkauf.bestellung_anlegen', { parameter: { vendor_id: l.id } }, ADMIN)).recordId!
  await aktionAusfuehrenGeprueft('einkauf.position_hinzufuegen',
    { recordId: po, parameter: { variant_id: variante, qty: 10, price_unit: 5 } }, ADMIN)
  const [z] = await h.sql<{ satz: number; steuer: string | null }[]>`
    select tax_rate as satz, tax_id as steuer from purchase_order_lines where order_id = ${po}`
  return { satz: Number(z.satz), steuer: z.steuer }
}

describe('Vorsteuer-Standard nach Lieferantenland', () => {
  test('Drittland (CN) → 0 %', async () => {
    const z = await zeileBei('CN')
    assert.equal(z.satz, 0)
    assert.equal(z.steuer, null)
  })

  test('EU-Ausland (AT) → 0 % (innergemeinschaftlicher Erwerb)', async () => {
    assert.equal((await zeileBei('AT')).satz, 0)
  })

  test('Inland (DE) und leeres Land → 19 % wie bisher', async () => {
    assert.equal((await zeileBei('DE')).satz, 19)
    assert.equal((await zeileBei(null)).satz, 19)
  })
})
