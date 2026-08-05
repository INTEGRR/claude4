import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { TransactionSql } from 'postgres'
import {
  assertLedgerConsistent,
  closeDb,
  expectError,
  freeToUse,
  locationId,
  makeProduct,
  onHand,
  stockUp,
  uomStueck,
  withRollback,
} from './helpers.ts'

after(closeDb)

/**
 * Baut das reale Szenario nach: eine Tastatur mit Farbvarianten und einer
 * Stückliste, in der die Gehäuse-Positionen je Farbe gefiltert sind.
 */
async function keyboardScenario(t: TransactionSql) {
  const uom = await uomStueck(t)

  // Endprodukt mit Attribut Farbe (Weiß / Schwarz)
  const [tpl] = await t<{ id: string }[]>`
    insert into product_templates (name, uom_id, route_manufacture, route_mto, can_be_sold)
    values ('Tastatur', ${uom}, true, true, true) returning id`
  const [attr] = await t<{ id: string }[]>`
    insert into product_attributes (name) values ('Farbe') returning id`
  const values = await t<{ id: string; name: string }[]>`
    insert into product_attribute_values (attribute_id, name)
    values (${attr.id}, 'Weiß'), (${attr.id}, 'Schwarz')
    returning id, name`
  const [line] = await t<{ id: string }[]>`
    insert into product_template_attribute_lines (template_id, attribute_id)
    values (${tpl.id}, ${attr.id}) returning id`
  const ptavs = await t<{ id: string; name: string }[]>`
    insert into product_template_attribute_values (line_id, value_id)
    select ${line.id}, id from product_attribute_values where attribute_id = ${attr.id}
    returning id, (select name from product_attribute_values v where v.id = value_id) as name`
  await t`select generate_variants(${tpl.id})`

  const variants = await t<{ id: string; display_name: string }[]>`
    select id, display_name from product_variants
    where template_id = ${tpl.id} and active order by display_name`
  const weiss = variants.find((v) => v.display_name.includes('Weiß'))!
  const schwarz = variants.find((v) => v.display_name.includes('Schwarz'))!

  // Komponenten
  const gehaeuseWeiss = await makeProduct(t, 'Gehäuse weiß')
  const gehaeuseSchwarz = await makeProduct(t, 'Gehäuse schwarz')
  const platine = await makeProduct(t, 'Platine')
  const switches = await makeProduct(t, 'Switches')

  // Stückliste auf Vorlagen-Ebene (eine BoM für alle Varianten)
  const [bom] = await t<{ id: string }[]>`
    insert into boms (template_id, qty, uom_id) values (${tpl.id}, 1, ${uom}) returning id`

  // Ungefilterte Positionen: gelten für ALLE Varianten
  await t`insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
          values (${bom.id}, 10, ${platine}, 1, ${uom}),
                 (${bom.id}, 20, ${switches}, 87, ${uom})`

  // Gefilterte Positionen: je Farbe genau ein Gehäuse
  const [lineWeiss] = await t<{ id: string }[]>`
    insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
    values (${bom.id}, 30, ${gehaeuseWeiss}, 1, ${uom}) returning id`
  const [lineSchwarz] = await t<{ id: string }[]>`
    insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
    values (${bom.id}, 31, ${gehaeuseSchwarz}, 1, ${uom}) returning id`

  const ptavWeiss = ptavs.find((p) => p.name === 'Weiß')!
  const ptavSchwarz = ptavs.find((p) => p.name === 'Schwarz')!
  await t`insert into bom_line_variant_filters (bom_line_id, ptav_id)
          values (${lineWeiss.id}, ${ptavWeiss.id}), (${lineSchwarz.id}, ${ptavSchwarz.id})`

  return {
    tplId: tpl.id,
    bomId: bom.id,
    weiss: weiss.id,
    schwarz: schwarz.id,
    gehaeuseWeiss,
    gehaeuseSchwarz,
    platine,
    switches,
    uom,
  }
}

describe('Stückliste: Auf Varianten anwenden', () => {
  test('die weiße Variante bekommt nur das weiße Gehäuse', async () => {
    await withRollback(async (t) => {
      const s = await keyboardScenario(t)

      const comps = await t<{ component_variant_id: string }[]>`
        select component_variant_id from bom_components_for_variant(${s.bomId}, ${s.weiss})`
      const ids = comps.map((c) => c.component_variant_id)

      assert.equal(ids.length, 3, 'Platine + Switches + ein Gehäuse')
      assert.ok(ids.includes(s.gehaeuseWeiss), 'weißes Gehäuse ist dabei')
      assert.ok(!ids.includes(s.gehaeuseSchwarz), 'schwarzes Gehäuse ist NICHT dabei')
      assert.ok(ids.includes(s.platine) && ids.includes(s.switches), 'ungefilterte Positionen gelten immer')
    })
  })

  test('die schwarze Variante bekommt nur das schwarze Gehäuse', async () => {
    await withRollback(async (t) => {
      const s = await keyboardScenario(t)
      const comps = await t<{ component_variant_id: string }[]>`
        select component_variant_id from bom_components_for_variant(${s.bomId}, ${s.schwarz})`
      const ids = comps.map((c) => c.component_variant_id)

      assert.ok(ids.includes(s.gehaeuseSchwarz))
      assert.ok(!ids.includes(s.gehaeuseWeiss))
    })
  })

  test('der Fertigungsauftrag friert die gefilterte Stückliste ein', async () => {
    await withRollback(async (t) => {
      const s = await keyboardScenario(t)
      const [mo] = await t<{ create_manufacturing_order: string }[]>`
        select create_manufacturing_order(${s.weiss}, 2)`

      const comps = await t<{ variant_id: string; qty: number }[]>`
        select variant_id, qty from stock_moves where production_id = ${mo.create_manufacturing_order}`

      assert.equal(comps.length, 3)
      const gehaeuse = comps.find((c) => c.variant_id === s.gehaeuseWeiss)
      assert.ok(gehaeuse, 'weißes Gehäuse im Auftrag')
      assert.equal(Number(gehaeuse.qty), 2, 'Menge skaliert mit der Fertigungsmenge')
      assert.equal(Number(comps.find((c) => c.variant_id === s.switches)!.qty), 174, '87 x 2')
      assert.ok(!comps.some((c) => c.variant_id === s.gehaeuseSchwarz))
    })
  })
})

describe('Fertigungsauftrag', () => {
  test('verbraucht Komponenten und bucht das Fertigprodukt zu', async () => {
    await withRollback(async (t) => {
      const s = await keyboardScenario(t)
      await stockUp(t, s.platine, 10)
      await stockUp(t, s.switches, 500)
      await stockUp(t, s.gehaeuseWeiss, 10)

      const [mo] = await t<{ create_manufacturing_order: string }[]>`
        select create_manufacturing_order(${s.weiss}, 3)`
      const moId = mo.create_manufacturing_order

      await t`select mo_confirm(${moId})`
      // Reservierung mindert die frei verfügbare Menge
      assert.equal(await freeToUse(t, s.platine), 7)

      await t`select mo_produce(${moId})`

      assert.equal(await onHand(t, s.platine), 7, '3 Platinen verbraucht')
      assert.equal(await onHand(t, s.switches), 500 - 261, '87 x 3 Switches verbraucht')
      assert.equal(await onHand(t, s.gehaeuseWeiss), 7)
      assert.equal(await onHand(t, s.gehaeuseSchwarz), 0, 'schwarzes Gehäuse unangetastet')
      assert.equal(await onHand(t, s.weiss), 3, 'drei fertige Tastaturen')

      const [state] = await t<{ state: string }[]>`
        select state from manufacturing_orders where id = ${moId}`
      assert.equal(state.state, 'done')
      await assertLedgerConsistent(t)
    })
  })

  test('Teilproduktion erzeugt einen Rückstands-Auftrag', async () => {
    await withRollback(async (t) => {
      const s = await keyboardScenario(t)
      await stockUp(t, s.platine, 10)
      await stockUp(t, s.switches, 900)
      await stockUp(t, s.gehaeuseWeiss, 10)

      const [mo] = await t<{ create_manufacturing_order: string }[]>`
        select create_manufacturing_order(${s.weiss}, 5)`
      const moId = mo.create_manufacturing_order
      await t`select mo_confirm(${moId})`

      const [res] = await t<{ mo_produce: string | null }[]>`
        select mo_produce(${moId}, 3)`
      assert.ok(res.mo_produce, 'Rückstand angelegt')

      const [orig] = await t<{ qty_produced: number; state: string }[]>`
        select qty_produced, state from manufacturing_orders where id = ${moId}`
      assert.equal(Number(orig.qty_produced), 3)
      assert.equal(orig.state, 'done')

      const [back] = await t<{ qty_to_produce: number; state: string }[]>`
        select qty_to_produce, state from manufacturing_orders where id = ${res.mo_produce}`
      assert.equal(Number(back.qty_to_produce), 2, 'Restmenge im Rückstand')
      assert.equal(back.state, 'confirmed')

      assert.equal(await onHand(t, s.weiss), 3)
      assert.equal(await onHand(t, s.platine), 7, 'nur 3 Platinen verbraucht')
      await assertLedgerConsistent(t)
    })
  })

  test('abweichender Ist-Verbrauch wird gebucht und protokolliert', async () => {
    await withRollback(async (t) => {
      const s = await keyboardScenario(t)
      await stockUp(t, s.platine, 10)
      await stockUp(t, s.switches, 500)
      await stockUp(t, s.gehaeuseWeiss, 10)

      const [mo] = await t<{ create_manufacturing_order: string }[]>`
        select create_manufacturing_order(${s.weiss}, 1)`
      const moId = mo.create_manufacturing_order
      await t`select mo_confirm(${moId})`

      const [switchMove] = await t<{ id: string }[]>`
        select id from stock_moves where production_id = ${moId} and variant_id = ${s.switches}`

      // Zwei Switches sind beim Einbau kaputtgegangen: 89 statt 87
      await t`select mo_produce(${moId}, 1, ${t.json({ [switchMove.id]: 89 })})`

      assert.equal(await onHand(t, s.switches), 411, '89 Switches verbraucht')

      const [logEntry] = await t<{ message: string }[]>`
        select message from audit_log
        where model = 'manufacturing_order' and record_id = ${moId} and kind = 'note'`
      assert.match(logEntry.message, /Abweichender Verbrauch/)
      await assertLedgerConsistent(t)
    })
  })

  test('gesperrte Stücklisten verhindern abweichenden Verbrauch', async () => {
    await withRollback(async (t) => {
      const s = await keyboardScenario(t)
      await t`update boms set consumption = 'blocked' where id = ${s.bomId}`
      await stockUp(t, s.platine, 10)
      await stockUp(t, s.switches, 500)
      await stockUp(t, s.gehaeuseWeiss, 10)

      const [mo] = await t<{ create_manufacturing_order: string }[]>`
        select create_manufacturing_order(${s.weiss}, 1)`
      await t`select mo_confirm(${mo.create_manufacturing_order})`
      const [move] = await t<{ id: string }[]>`
        select id from stock_moves where production_id = ${mo.create_manufacturing_order}
        and variant_id = ${s.platine}`

      await expectError(
        t,
        (sp) => sp`select mo_produce(${mo.create_manufacturing_order}, 1, ${sp.json({ [move.id]: 2 })})`,
        /gesperrt/,
      )
    })
  })
})

describe('Demontage', () => {
  test('zerlegt ein Produkt in die Komponenten der richtigen Variante', async () => {
    await withRollback(async (t) => {
      const s = await keyboardScenario(t)
      await stockUp(t, s.weiss, 2)
      const stock = await locationId(t, 'WH/Stock')

      const [ub] = await t<{ id: string }[]>`
        insert into unbuild_orders (number, variant_id, bom_id, qty, src_location_id, dest_location_id)
        values (next_sequence('unbuild'), ${s.weiss}, ${s.bomId}, 1, ${stock}, ${stock})
        returning id`
      await t`select unbuild_apply(${ub.id})`

      assert.equal(await onHand(t, s.weiss), 1, 'eine Tastatur zerlegt')
      assert.equal(await onHand(t, s.platine), 1)
      assert.equal(await onHand(t, s.switches), 87)
      assert.equal(await onHand(t, s.gehaeuseWeiss), 1, 'weißes Gehäuse zurück')
      assert.equal(await onHand(t, s.gehaeuseSchwarz), 0, 'kein schwarzes Gehäuse entstanden')
      await assertLedgerConsistent(t)
    })
  })

  test('warnt bei fehlendem Bestand', async () => {
    await withRollback(async (t) => {
      const s = await keyboardScenario(t)
      const stock = await locationId(t, 'WH/Stock')
      const [ub] = await t<{ id: string }[]>`
        insert into unbuild_orders (number, variant_id, bom_id, qty, src_location_id, dest_location_id)
        values (next_sequence('unbuild'), ${s.weiss}, ${s.bomId}, 1, ${stock}, ${stock})
        returning id`

      await expectError(t, (sp) => sp`select unbuild_apply(${ub.id})`, /Bestand reicht nicht/)
      // Mit Bestätigung geht es trotzdem (Odoo-Verhalten)
      await t`select unbuild_apply(${ub.id}, true)`
      assert.equal(await onHand(t, s.platine), 1)
    })
  })
})

describe('Verkauf mit Fertigung (MTO)', () => {
  test('Bestätigen erzeugt Lieferung und Fertigungsauftrag', async () => {
    await withRollback(async (t) => {
      const s = await keyboardScenario(t)
      const [partner] = await t<{ id: string }[]>`
        insert into partners (name, is_customer) values ('Testkunde', true) returning id`
      const [order] = await t<{ id: string }[]>`
        insert into sales_orders (number, partner_id) values (next_sequence('sale'), ${partner.id})
        returning id`
      await t`insert into sales_order_lines (order_id, variant_id, name, qty, uom_id, price_unit)
              values (${order.id}, ${s.weiss}, 'Tastatur Weiß', 2, ${s.uom}, 149)`

      await t`select confirm_sales_order(${order.id}, 'tester')`

      const [so] = await t<{ state: string }[]>`select state from sales_orders where id = ${order.id}`
      assert.equal(so.state, 'sale')

      const pickings = await t<{ id: string }[]>`
        select id from stock_pickings where origin_model = 'sales_order' and origin_id = ${order.id}`
      assert.equal(pickings.length, 1, 'genau eine Lieferung')

      const mos = await t<{ id: string; qty_to_produce: number; state: string }[]>`
        select id, qty_to_produce, state from manufacturing_orders where sales_order_id = ${order.id}`
      assert.equal(mos.length, 1, 'genau ein Fertigungsauftrag')
      assert.equal(Number(mos[0].qty_to_produce), 2)
      assert.equal(mos[0].state, 'confirmed', 'MTO-Aufträge starten bestätigt')

      // Der Fertigungsauftrag trägt die gefilterte Stückliste
      const comps = await t<{ variant_id: string }[]>`
        select variant_id from stock_moves where production_id = ${mos[0].id}`
      assert.ok(comps.some((c) => c.variant_id === s.gehaeuseWeiss))
      assert.ok(!comps.some((c) => c.variant_id === s.gehaeuseSchwarz))
    })
  })

  test('Lagerprodukt ohne Fertigungsroute erzeugt nur eine Lieferung', async () => {
    await withRollback(async (t) => {
      const uom = await uomStueck(t)
      const kabel = await makeProduct(t, 'USB-Kabel')
      const [partner] = await t<{ id: string }[]>`
        insert into partners (name, is_customer) values ('Kunde B', true) returning id`
      const [order] = await t<{ id: string }[]>`
        insert into sales_orders (number, partner_id) values (next_sequence('sale'), ${partner.id})
        returning id`
      await t`insert into sales_order_lines (order_id, variant_id, name, qty, uom_id, price_unit)
              values (${order.id}, ${kabel}, 'USB-Kabel', 1, ${uom}, 9)`

      await t`select confirm_sales_order(${order.id})`

      const mos = await t`select id from manufacturing_orders where sales_order_id = ${order.id}`
      assert.equal(mos.length, 0, 'kein Fertigungsauftrag')
      const pickings = await t`
        select id from stock_pickings where origin_model = 'sales_order' and origin_id = ${order.id}`
      assert.equal(pickings.length, 1)
    })
  })

  test('Fertigmeldung macht die Lieferung versandbereit', async () => {
    await withRollback(async (t) => {
      const s = await keyboardScenario(t)
      await stockUp(t, s.platine, 10)
      await stockUp(t, s.switches, 500)
      await stockUp(t, s.gehaeuseWeiss, 10)

      const [partner] = await t<{ id: string }[]>`
        insert into partners (name, is_customer) values ('Kunde C', true) returning id`
      const [order] = await t<{ id: string }[]>`
        insert into sales_orders (number, partner_id) values (next_sequence('sale'), ${partner.id})
        returning id`
      await t`insert into sales_order_lines (order_id, variant_id, name, qty, uom_id, price_unit)
              values (${order.id}, ${s.weiss}, 'Tastatur Weiß', 1, ${s.uom}, 149)`
      await t`select confirm_sales_order(${order.id})`

      // Vor der Fertigung ist nichts lieferbar
      const [before] = await t<{ state: string }[]>`
        select state from stock_pickings where origin_model = 'sales_order' and origin_id = ${order.id}`
      assert.equal(before.state, 'confirmed', 'noch nicht bereit')

      const [mo] = await t<{ id: string }[]>`
        select id from manufacturing_orders where sales_order_id = ${order.id}`
      await t`select mo_produce(${mo.id})`

      const [after] = await t<{ state: string }[]>`
        select state from stock_pickings where origin_model = 'sales_order' and origin_id = ${order.id}`
      assert.equal(after.state, 'assigned', 'Lieferung ist versandbereit')
      await assertLedgerConsistent(t)
    })
  })

  test('Storno bricht die Lieferung ab, warnt aber bei offener Fertigung', async () => {
    await withRollback(async (t) => {
      const s = await keyboardScenario(t)
      const [partner] = await t<{ id: string }[]>`
        insert into partners (name, is_customer) values ('Kunde D', true) returning id`
      const [order] = await t<{ id: string }[]>`
        insert into sales_orders (number, partner_id) values (next_sequence('sale'), ${partner.id})
        returning id`
      await t`insert into sales_order_lines (order_id, variant_id, name, qty, uom_id, price_unit)
              values (${order.id}, ${s.schwarz}, 'Tastatur Schwarz', 1, ${s.uom}, 149)`
      await t`select confirm_sales_order(${order.id})`
      await t`select cancel_sales_order(${order.id}, 'tester')`

      const [so] = await t<{ state: string }[]>`select state from sales_orders where id = ${order.id}`
      assert.equal(so.state, 'cancel')

      const [pick] = await t<{ state: string }[]>`
        select state from stock_pickings where origin_model = 'sales_order' and origin_id = ${order.id}`
      assert.equal(pick.state, 'cancel', 'Lieferung storniert')

      const [mo] = await t<{ state: string }[]>`
        select state from manufacturing_orders where sales_order_id = ${order.id}`
      assert.equal(mo.state, 'confirmed', 'Fertigungsauftrag bleibt bestehen (Odoo-Verhalten)')

      const [warn] = await t<{ message: string }[]>`
        select message from audit_log
        where model = 'sales_order' and record_id = ${order.id} and kind = 'note'`
      assert.match(warn.message, /offene\(r\) Fertigungsauftrag/)
    })
  })

  test('gelieferte Mengen fließen in den Auftrag zurück', async () => {
    await withRollback(async (t) => {
      const uom = await uomStueck(t)
      const kabel = await makeProduct(t, 'Kabel weiß')
      await stockUp(t, kabel, 10)

      const [partner] = await t<{ id: string }[]>`
        insert into partners (name, is_customer) values ('Kunde E', true) returning id`
      const [order] = await t<{ id: string }[]>`
        insert into sales_orders (number, partner_id) values (next_sequence('sale'), ${partner.id})
        returning id`
      await t`insert into sales_order_lines (order_id, variant_id, name, qty, uom_id, price_unit)
              values (${order.id}, ${kabel}, 'Kabel', 4, ${uom}, 9)`
      await t`select confirm_sales_order(${order.id})`

      const [pick] = await t<{ id: string }[]>`
        select id from stock_pickings where origin_model = 'sales_order' and origin_id = ${order.id}`
      const [move] = await t<{ id: string }[]>`
        select id from stock_moves where picking_id = ${pick.id}`

      // Teillieferung 3 von 4
      await t`select picking_validate(${pick.id}, ${t.json({ [move.id]: 3 })}, true)`

      const [line] = await t<{ qty_delivered: number }[]>`
        select qty_delivered from sales_order_lines where order_id = ${order.id}`
      assert.equal(Number(line.qty_delivered), 3)

      const [so] = await t<{ delivery_status: string }[]>`
        select delivery_status from sales_orders where id = ${order.id}`
      assert.equal(so.delivery_status, 'partial')
      await assertLedgerConsistent(t)
    })
  })
})
