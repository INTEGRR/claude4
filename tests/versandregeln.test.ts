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
  waehleKartonage,
  wendeRegelnAn,
} from '../src/modules/versand/regeln-logik.ts'
import { brauchtZoll, productForCountry, zoneForCountry } from '../src/modules/versand/dhl-codes.ts'
import {
  assertLedgerConsistent,
  closeDb,
  db,
  locationId,
  makeProduct,
  onHand,
  operationTypeId,
  stockUp,
  uomStueck,
  withRollback,
} from './helpers.ts'

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

/** Der Lesbarkeit halber in „Stück je Kleinpaket" — intern ist es der Kehrwert. */
const zeile = (sku: string, qty: number, kleinpaket = true, jeKleinpaket = 1) => ({
  sku, qty, kleinpaket, platzbedarf: 1 / jeKleinpaket,
})

const karton = (
  name: string,
  capacity: number,
  maxContentG: number,
  kleinpaket = false,
  tareG = 0,
) => ({ id: name, name, capacity, maxContentG, kleinpaket, tareG })

describe('Versandregeln: Logik', () => {
  test('Kleinpaket-Kapazität zählt anteilig über gemischte Positionen', () => {
    // Ein Keycap-Set (max 2) plus drei Kabel (max 10): 0,5 + 0,3 = 0,8 — passt.
    assert.equal(passtInsKleinpaket([zeile('KC-1', 1, true, 2), zeile('KAB-1', 3, true, 10)], 300), true)
    // Drei Sets à max 2: 1,5 — passt nicht.
    assert.equal(passtInsKleinpaket([zeile('KC-1', 3, true, 2)], 300), false)
    // Zwei verschiedene Produkte, die je allein ein Kleinpaket füllen (max 1):
    // zusammen 2,0 — passt nicht.
    assert.equal(passtInsKleinpaket([zeile('KC-1', 1, true, 1), zeile('KAB-1', 1, true, 1)], 300), false)
    // Dieselben zwei, aber jedes füllt nur ein halbes: 0,5 + 0,5 = 1,0 — passt.
    assert.equal(passtInsKleinpaket([zeile('KC-1', 1, true, 2), zeile('KAB-1', 1, true, 2)], 300), true)
    assert.equal(passtInsKleinpaket([], 300), false)
  })

  test('eine einzige nicht kleinpaketfähige Position kippt die ganze Sendung', () => {
    // Zubehör (true) zusammen mit einer Tastatur (false): Paket, nicht Kleinpaket.
    assert.equal(
      passtInsKleinpaket([zeile('KC-1', 1, true, 2), zeile('TAST-W', 1, false)], 400),
      false,
    )
    // Und die Regel greift dann auch nicht — es bleibt bei der Länder-Automatik.
    const ergebnis = wendeRegelnAn(
      [regel({ name: 'Kleinpaket', requireKleinpaketFit: true, dhlProduct: 'V62KP' })],
      kontext({ weightG: 1400, zeilen: [zeile('KC-1', 1, true, 2), zeile('TAST-W', 1, false)] }),
    )
    assert.equal(ergebnis.product, null)
  })

  test('Gewicht ist ein hartes K.-o., auch ohne Höchstgewicht in der Regel', () => {
    // Flags und Platz stimmen, aber 1,4 kg sprengen das Kleinpaket (1 kg).
    assert.equal(passtInsKleinpaket([zeile('KC-1', 1, true, 2)], 1400), false)
    assert.equal(passtInsKleinpaket([zeile('KC-1', 1, true, 2)], 1000), true)

    // Regel ohne maxWeightG darf trotzdem kein Kleinpaket vorschlagen.
    const ohneGrenze = regel({ name: 'Kleinpaket', requireKleinpaketFit: true, dhlProduct: 'V62KP' })
    assert.equal(
      wendeRegelnAn([ohneGrenze], kontext({ weightG: 1400, zeilen: [zeile('KC-1', 1, true, 2)] })).product,
      null,
    )
    assert.equal(
      wendeRegelnAn([ohneGrenze], kontext({ weightG: 600, zeilen: [zeile('KC-1', 1, true, 2)] })).product,
      'V62KP',
    )
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

  test('Kartonage: die kleinste passende gewinnt', () => {
    const kartons = [
      karton('Kleinpaket-Karton', 1, 1000, true, 40),
      karton('Tastaturkarton', 3, 5000, false, 180),
      karton('Großkarton', 8, 20000, false, 400),
    ]
    // Ein halbes Kleinpaket Zubehör → kleinster Karton.
    assert.equal(waehleKartonage(kartons, [zeile('KC-1', 1, true, 2)], 300)?.name, 'Kleinpaket-Karton')
    // Eine Tastatur (Platzbedarf 3) → mittlerer Karton.
    assert.equal(waehleKartonage(kartons, [zeile('TAST-W', 1, false, 1 / 3)], 1200)?.name, 'Tastaturkarton')
    // Passt vom Platz, aber zu schwer für den kleinen → nächstgrößerer.
    assert.equal(waehleKartonage(kartons, [zeile('KC-1', 1, true, 2)], 4000)?.name, 'Tastaturkarton')
    // Nichts passt (zu schwer für alles) bzw. keine Kartonagen gepflegt.
    assert.equal(waehleKartonage(kartons, [zeile('KC-1', 1, true, 2)], 99000), null)
    assert.equal(waehleKartonage([], [zeile('KC-1', 1, true, 2)], 300), null)
  })

  test('Leergewicht des Kartons zählt zum Versandgewicht — und kann das Kleinpaket kippen', () => {
    const kartons = [
      karton('Kleinpaket-Karton', 1, 1000, true, 60),
      karton('Tastaturkarton', 3, 5000, false, 180),
    ]
    const kleinpaketRegel = regel({
      name: 'Kleinpaket', requireKleinpaketFit: true, dhlProduct: 'V62KP',
    })

    // 900 g Ware + 60 g Karton = 960 g → bleibt Kleinpaket.
    const knappDrunter = wendeRegelnAn([kleinpaketRegel], kontext({
      weightG: 900, kartonagen: kartons, zeilen: [zeile('KC-1', 1, true, 2)],
    }))
    assert.equal(knappDrunter.versandgewichtG, 960)
    assert.equal(knappDrunter.kartonage?.name, 'Kleinpaket-Karton')
    assert.equal(knappDrunter.product, 'V62KP')

    // 980 g Ware + 60 g Karton = 1040 g → genau der Fall, der bei DHL
    // durchfällt. Ohne Kartonagen hätte das Warengewicht noch gepasst.
    const knappDrueber = wendeRegelnAn([kleinpaketRegel], kontext({
      weightG: 980, kartonagen: kartons, zeilen: [zeile('KC-1', 1, true, 2)],
    }))
    assert.equal(knappDrueber.versandgewichtG, 1040)
    assert.equal(knappDrueber.passtInsKleinpaket, false)
    assert.equal(knappDrueber.product, null)
  })

  test('nicht kleinpaket-taugliche Kartonage schließt das Kleinpaket aus', () => {
    // Platz und Gewicht wären in Ordnung, aber der einzige passende Karton
    // ist nicht als Kleinpaket zugelassen.
    const ergebnis = wendeRegelnAn(
      [regel({ name: 'Kleinpaket', requireKleinpaketFit: true, dhlProduct: 'V62KP' })],
      kontext({
        weightG: 300,
        kartonagen: [karton('Universalkarton', 1, 1000, false, 50)],
        zeilen: [zeile('KC-1', 1, true, 2)],
      }),
    )
    assert.equal(ergebnis.kartonage?.name, 'Universalkarton')
    assert.equal(ergebnis.passtInsKleinpaket, false)
    assert.equal(ergebnis.product, null)
  })

  test('ohne gepflegte Kartonagen bleibt alles wie bisher', () => {
    const ergebnis = wendeRegelnAn(
      [regel({ name: 'Kleinpaket', requireKleinpaketFit: true, dhlProduct: 'V62KP' })],
      kontext({ weightG: 300, zeilen: [zeile('KC-1', 1, true, 2)] }),
    )
    assert.equal(ergebnis.kartonage, null)
    assert.equal(ergebnis.versandgewichtG, 300)
    assert.equal(ergebnis.product, 'V62KP')
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

  test('Produkte tragen Kleinpaket-Flag und Platzbedarf (Standard: aus, 1)', async () => {
    await withRollback(async (t) => {
      const variantId = await makeProduct(t, 'Kleinpaket-Testprodukt')
      const [spalten] = await t<{ kleinpaket: boolean; platzbedarf: number }[]>`
        select pt.kleinpaket, pt.platzbedarf
        from product_variants pv join product_templates pt on pt.id = pv.template_id
        where pv.id = ${variantId}`
      assert.equal(spalten.kleinpaket, false)
      assert.equal(Number(spalten.platzbedarf), 1)
    })
  })

  test('Verbrauch bucht eine Kartonage als Bewegung — und nur einmal', async () => {
    await withRollback(async (t) => {
      // Karton als ganz normaler Bestandsartikel mit Anfangsbestand.
      const kartonVariant = await makeProduct(t, 'Kleinpaket-Karton', { weightG: 60 })
      await stockUp(t, kartonVariant, 100)
      const [kartonage] = await t<{ id: string }[]>`
        insert into packagings (name, variant_id, capacity, max_content_g, kleinpaket)
        values ('Kleinpaket-Karton', ${kartonVariant}, 1, 1000, true)
        returning id`

      // Eine erledigte Lieferung mit einer Sendung darauf.
      const ware = await makeProduct(t, 'Versandware')
      await stockUp(t, ware, 10)
      const lager = await locationId(t, 'WH/Stock')
      const kunden = await locationId(t, 'Partner/Kunden')
      const typ = await operationTypeId(t, 'delivery')
      const [picking] = await t<{ id: string }[]>`
        insert into stock_pickings (number, operation_type_id, state)
        values (next_sequence('delivery'), ${typ}, 'draft') returning id`
      const uom = await uomStueck(t)
      const [move] = await t<{ id: string }[]>`
        insert into stock_moves (picking_id, variant_id, uom_id, qty,
                                 src_location_id, dest_location_id, state)
        values (${picking.id}, ${ware}, ${uom}, 1, ${lager}, ${kunden}, 'confirmed')
        returning id`
      await t`select move_done(${move.id})`
      const [shipment] = await t<{ id: string }[]>`
        insert into shipments (picking_id, billing_number, weight_g, packaging_id, shipment_number)
        values (${picking.id}, '12345678900101', 360, ${kartonage.id}, 'TEST-1')
        returning id`

      const vorher = await onHand(t, kartonVariant)
      await t`select packaging_consume(${shipment.id})`
      assert.equal(await onHand(t, kartonVariant), vorher - 1)

      // Zweiter Aufruf (Wiederholung, Job-Nachlauf) darf nicht doppelt buchen.
      await t`select packaging_consume(${shipment.id})`
      assert.equal(await onHand(t, kartonVariant), vorher - 1)

      const [gebucht] = await t<{ packaging_move_id: string | null }[]>`
        select packaging_move_id from shipments where id = ${shipment.id}`
      assert.ok(gebucht.packaging_move_id, 'Die Bewegung muss an der Sendung hängen')

      await assertLedgerConsistent(t)
    })
  })

  test('ohne Kartonage an der Sendung wird nichts gebucht', async () => {
    await withRollback(async (t) => {
      const typ = await operationTypeId(t, 'delivery')
      const [picking] = await t<{ id: string }[]>`
        insert into stock_pickings (number, operation_type_id, state)
        values (next_sequence('delivery'), ${typ}, 'draft') returning id`
      const [shipment] = await t<{ id: string }[]>`
        insert into shipments (picking_id, billing_number, weight_g, shipment_number)
        values (${picking.id}, '12345678900101', 500, 'TEST-2') returning id`
      const [ergebnis] = await t<{ packaging_consume: string | null }[]>`
        select packaging_consume(${shipment.id})`
      assert.equal(ergebnis.packaging_consume, null)
    })
  })
})
