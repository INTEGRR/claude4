/**
 * Fehlender Wechselkurs rechnet nicht mehr still 1:1 (0122, UX-Audit): ohne
 * hinterlegten Kurs keine Bestätigung einer Fremdwährungs-Bestellung und
 * keine Zahlung in Fremdwährung — mit Kurs wird er wie bisher eingefroren.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_wechselkurs_strikt_check'
const ADMIN = { name: 'kurs-test', role: 'admin' as const }
let h: Harness

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

async function chfBestellung(): Promise<string> {
  const sql = h.sql
  await sql`delete from exchange_rates where currency = 'CHF'`
  const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, can_be_purchased, route_buy)
    values ('Kurstest-Teil', ${stueck.id}, true, true) returning id`
  await sql`select generate_variants(${tpl.id})`
  const [v] = await sql<{ id: string }[]>`select id from product_variants where template_id = ${tpl.id}`
  const [l] = await sql<{ id: string }[]>`
    insert into partners (name, is_vendor, email, country_code)
    values ('Kurstest AG', true, 'kurs@example.com', 'CH') returning id`
  const po = (await aktionAusfuehrenGeprueft('einkauf.bestellung_anlegen', { parameter: { vendor_id: l.id } }, ADMIN)).recordId!
  await sql`update purchase_orders set currency = 'CHF' where id = ${po}`
  await aktionAusfuehrenGeprueft('einkauf.position_hinzufuegen',
    { recordId: po, parameter: { variant_id: v.id, qty: 4, price_unit: 25 } }, ADMIN)
  return po
}

describe('Wechselkurs strikt', () => {
  test('ohne CHF-Kurs keine Bestätigung, mit Kurs wird er eingefroren', async () => {
    const po = await chfBestellung()
    await assert.rejects(aktionAusfuehrenGeprueft('einkauf.bestaetigen', { recordId: po }, ADMIN), /Kein Wechselkurs für CHF/)
    const [entwurf] = await h.sql<{ state: string }[]>`select state::text from purchase_orders where id = ${po}`
    assert.equal(entwurf.state, 'draft', 'bleibt Entwurf')

    await h.sql`insert into exchange_rates (currency, rate, valid_from, source) values ('CHF', 1.05, current_date, 'manuell')`
    await aktionAusfuehrenGeprueft('einkauf.bestaetigen', { recordId: po }, ADMIN)
    const [best] = await h.sql<{ rate: number }[]>`select exchange_rate as rate from purchase_orders where id = ${po}`
    assert.equal(Number(best.rate), 1.05)
  })

  test('Zahlung in Fremdwährung ohne Kurs wird abgelehnt, in Euro nicht', async () => {
    await h.sql`delete from exchange_rates where currency = 'GBP'`
    await assert.rejects(h.sql`select zahlung_erfassen('aus', 100, 'GBP')`, /Kein Wechselkurs für GBP/)
    const [z] = await h.sql<{ id: string }[]>`select zahlung_erfassen('aus', 100, 'EUR') as id`
    assert.ok(z.id)
  })

  test('exchange_rate_kurs liefert NULL statt 1, exchange_rate_at bleibt Schätzung', async () => {
    await h.sql`delete from exchange_rates where currency = 'GBP'`
    const [r] = await h.sql<{ kurs: number | null; schaetzung: number }[]>`
      select exchange_rate_kurs('GBP') as kurs, exchange_rate_at('GBP') as schaetzung`
    assert.equal(r.kurs, null)
    assert.equal(Number(r.schaetzung), 1)
  })
})
