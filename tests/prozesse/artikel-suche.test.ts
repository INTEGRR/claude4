/**
 * Artikelsuche (Entscheidungslog 2026-11-28): eine Regel für alle
 * Suchfelder — jedes Wort, Schreibweise und Reihenfolge egal, in Name,
 * Artikelnummer und Barcode. Dazu das Scan-Feld und der Inventur-Filter.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'
import { artikelPasst, produktPasst } from '../../src/modules/shared/artikel-suche.ts'

const DATENBANK = 'erp_artikelsuche_check'
const ADMIN = { name: 'suche-test', role: 'admin' as const }
let h: Harness
let sql: Harness['sql']

before(async () => {
  h = await harnessStart(DATENBANK)
  sql = (await import('../../src/db/client.ts')).sql as never
  for (const [name, sku, barcode] of [
    ['Native 1800 Case Black', 'CS-1800-BLK-001', '4260000000013'],
    ['Native 1800 Case Green', 'CS-1800-GRE-001', null],
    ['Gateron 100% Switch_Tester', 'SW-T-001', null],
  ] as const) {
    await aktionAusfuehrenGeprueft('produkte.produkt_anlegen', {
      parameter: { name, sku, verkaufbar: false, einkaufbar: true, route: 'kaufen', attribute: [] },
    }, ADMIN)
    if (barcode) await h.sql`update product_variants set barcode = ${barcode} where sku = ${sku}`
  }
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

describe('Artikelsuche', () => {
  const finde = async (q: string) =>
    (await sql<{ name: string }[]>`
      select pt.name from product_variants pv join product_templates pt on pt.id = pv.template_id
      where pv.active and ${artikelPasst(q)} and pt.name not like 'Fracht%' order by 1`).map((r) => r.name)

  test('Schreibweise und Wortreihenfolge sind egal; Nummer und Barcode zählen', async () => {
    for (const q of ['case black', 'CASE BLACK', 'black case', 'cs-1800-blk', 'CS-1800-BLK-001', '4260000000013', 'blk native']) {
      assert.deepEqual(await finde(q), ['Native 1800 Case Black'], q)
    }
    assert.deepEqual(await finde('1800 case'), ['Native 1800 Case Black', 'Native 1800 Case Green'])
    assert.deepEqual(await finde('case rot'), [], 'jedes Wort muss vorkommen')
    assert.ok((await finde('')).length >= 3, 'leere Eingabe = alles')
  })

  test('Platzhalterzeichen der Eingabe gelten wörtlich', async () => {
    assert.deepEqual(await finde('100%'), ['Gateron 100% Switch_Tester'])
    assert.deepEqual(await finde('switch_tester'), ['Gateron 100% Switch_Tester'])
    assert.deepEqual(await finde('c_se'), [], '_ ist kein Platzhalter')
  })

  test('Produktliste: findet auch über die Artikelnummer einer Variante', async () => {
    const produkte = async (q: string) =>
      (await sql<{ name: string }[]>`
        select pt.name from product_templates pt where pt.active and ${produktPasst(q)} order by 1`).map((r) => r.name)
    assert.deepEqual(await produkte('cs-1800-gre'), ['Native 1800 Case Green'])
    assert.deepEqual(await produkte('GREEN case'), ['Native 1800 Case Green'])
  })

  test('Variantennamen folgen einer Umbenennung des Produkts', async () => {
    await h.sql`update product_templates set name = 'Native 1800 Gehäuse Schwarz' where name = 'Native 1800 Case Black'`
    assert.deepEqual(await finde('gehäuse schwarz'), ['Native 1800 Gehäuse Schwarz'])
    const [v] = await h.sql<{ display_name: string }[]>`select display_name from product_variants where sku = 'CS-1800-BLK-001'`
    assert.equal(v.display_name, 'Native 1800 Gehäuse Schwarz')
  })
})
