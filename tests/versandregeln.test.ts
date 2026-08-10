/**
 * Versandregeln: die reine Logik (Kleinpaket-Kapazität, SKU-Muster, Zonen,
 * Stapeln der Aktionen) plus die Startregeln aus Migration 0032.
 */
import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  type RegelKontext,
  type Versandregel,
  billingNumberForProduct,
  passtInsKleinpaket,
  skuPasst,
  wendeRegelnAn,
} from '../src/modules/versand/regeln-logik.ts'
import { brauchtZoll, productForCountry, zoneForCountry } from '../src/modules/versand/dhl-codes.ts'
import { closeDb, db, makeProduct, withRollback } from './helpers.ts'

after(closeDb)

function regel(teil: Partial<Versandregel>): Versandregel {
  return {
    id: 'r', name: teil.name ?? 'Regel',
    minWeightG: null, maxWeightG: null, zone: null, skus: null, skuScope: 'any',
    requireKleinpaketFit: false, dhlProduct: null, billingNumber: null,
    insuranceFromValue: null,
    ...teil,
  }
}

function kontext(teil: Partial<RegelKontext>): RegelKontext {
  return { weightG: 500, zone: 'de', orderValue: 100, zeilen: [], ...teil }
}

const zeile = (sku: string, qty: number, kleinpaket = true, max = 1) => ({
  sku, qty, kleinpaket, kleinpaketMaxQty: max,
})

describe('Versandregeln: Logik', () => {
  test('Kleinpaket-Kapazität zählt anteilig über gemischte Positionen', () => {
    // Ein Keycap-Set (max 2) plus drei Kabel (max 10): 0,5 + 0,3 = 0,8 — passt.
    assert.equal(passtInsKleinpaket([zeile('KC-1', 1, true, 2), zeile('KAB-1', 3, true, 10)]), true)
    // Drei Sets à max 2: 1,5 — passt nicht.
    assert.equal(passtInsKleinpaket([zeile('KC-1', 3, true, 2)]), false)
    // Eine nicht kleinpaketfähige Position kippt alles.
    assert.equal(passtInsKleinpaket([zeile('KC-1', 1, true, 2), zeile('TAST-W', 1, false)]), false)
    assert.equal(passtInsKleinpaket([]), false)
  })

  test('SKU-Muster: * als Platzhalter, Groß/Klein egal, sonst exakt', () => {
    assert.equal(skuPasst('KC-*', 'kc-weiss'), true)
    assert.equal(skuPasst('KC-*', 'KAB-1'), false)
    assert.equal(skuPasst('TAST-W', 'TAST-W'), true)
    assert.equal(skuPasst('TAST-W', 'TAST-W2'), false)
    // Regex-Sonderzeichen in SKUs sind Literale, keine Syntax.
    assert.equal(skuPasst('A+B', 'A+B'), true)
  })

  test('Zonen und Rückfall-Produkt: CH und GB sind Drittland', () => {
    assert.equal(zoneForCountry('DE'), 'de')
    assert.equal(zoneForCountry('AT'), 'eu')
    assert.equal(zoneForCountry('CH'), 'world')
    assert.equal(zoneForCountry('GB'), 'world')
    assert.equal(zoneForCountry('USA'), 'world')
    assert.equal(productForCountry('AT'), 'V54EPAK')
    assert.equal(productForCountry('CH'), 'V53WPAK')
    assert.equal(brauchtZoll('CH'), true)
    assert.equal(brauchtZoll('FR'), false)
  })

  test('erste passende Regel je Aktion gewinnt, weitere stapeln', () => {
    const regeln = [
      regel({ name: 'Kleinpaket', zone: 'de', requireKleinpaketFit: true, dhlProduct: 'V62KP' }),
      regel({ name: 'Versichern', insuranceFromValue: 500 }),
      regel({ name: 'Später', zone: 'de', dhlProduct: 'V01PAK', billingNumber: '22222222220101' }),
    ]
    const ergebnis = wendeRegelnAn(regeln, kontext({
      orderValue: 800,
      zeilen: [zeile('KC-1', 1, true, 2)],
    }))
    assert.equal(ergebnis.product, 'V62KP')
    assert.equal(ergebnis.productRegel, 'Kleinpaket')
    // Versicherung kommt aus Regel 2, die Abrechnungsnummer aus Regel 3 —
    // obwohl Regel 1 das Produkt schon bestimmt hat.
    assert.equal(ergebnis.insuredValue, 800)
    assert.equal(ergebnis.insuranceRegel, 'Versichern')
    assert.equal(ergebnis.billingNumber, '22222222220101')
  })

  test('Versicherungsschwelle unterhalb des Warenwerts greift nicht', () => {
    const ergebnis = wendeRegelnAn(
      [regel({ name: 'Versichern', insuranceFromValue: 500 })],
      kontext({ orderValue: 300 }),
    )
    assert.equal(ergebnis.insuredValue, null)
  })

  test('Gewichts- und SKU-Bedingungen (any/all)', () => {
    const nurZubehoer = regel({ name: 'Z', skus: ['KC-*', 'KAB-*'], skuScope: 'all', dhlProduct: 'V62KP' })
    const gemischt = kontext({ zeilen: [zeile('KC-1', 1), zeile('TAST-W', 1, false)] })
    const reinesZubehoer = kontext({ zeilen: [zeile('KC-1', 1), zeile('KAB-2', 1)] })
    assert.equal(wendeRegelnAn([nurZubehoer], gemischt).product, null)
    assert.equal(wendeRegelnAn([nurZubehoer], reinesZubehoer).product, 'V62KP')

    const schwer = regel({ name: 'S', minWeightG: 5000, dhlProduct: 'V01PAK' })
    assert.equal(wendeRegelnAn([schwer], kontext({ weightG: 800 })).product, null)
    assert.equal(wendeRegelnAn([schwer], kontext({ weightG: 6000 })).product, 'V01PAK')
  })

  test('Abrechnungsnummer: Verfahren folgt dem Produkt, Teilnahme bleibt', () => {
    assert.equal(billingNumberForProduct('V62KP', '33333333330102'), '33333333336202')
    assert.equal(billingNumberForProduct('V01PAK', '33333333330102'), '33333333330102')
    assert.equal(billingNumberForProduct('V54EPAK', '33333333330102'), '33333333335402')
    // Unbekanntes Produkt oder falsches Format: unverändert lassen.
    assert.equal(billingNumberForProduct('V99XXX', '33333333330102'), '33333333330102')
    assert.equal(billingNumberForProduct('V62KP', 'kaputt'), 'kaputt')
  })
})

describe('Versandregeln: Migration', () => {
  test('Startregeln liegen vor (Kleinpaket vor den Zonenregeln)', async () => {
    const [kleinpaket] = await db()<{ sequence: number }[]>`
      select sequence from shipping_rules
      where dhl_product = 'V62KP' and require_kleinpaket_fit
      order by sequence limit 1`
    const [zonen] = await db()<{ sequence: number }[]>`
      select min(sequence)::int as sequence from shipping_rules
      where dhl_product in ('V54EPAK', 'V53WPAK')`
    assert.ok(kleinpaket, 'Kleinpaket-Startregel fehlt')
    assert.ok(Number(kleinpaket.sequence) < Number(zonen.sequence),
      'Die Kleinpaket-Regel muss vor den Zonenregeln stehen')
  })

  test('Produkte tragen das Kleinpaket-Flag (Standard: aus)', async () => {
    await withRollback(async (t) => {
      const variantId = await makeProduct(t, 'Kleinpaket-Testprodukt')
      const [spalten] = await t<{ kleinpaket: boolean; kleinpaket_max_qty: number }[]>`
        select pt.kleinpaket, pt.kleinpaket_max_qty
        from product_variants pv join product_templates pt on pt.id = pv.template_id
        where pv.id = ${variantId}`
      assert.equal(spalten.kleinpaket, false)
      assert.equal(Number(spalten.kleinpaket_max_qty), 1)
    })
  })
})
