import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { TransactionSql } from 'postgres'
import { closeDb, expectError, makeProduct, stockUp, uomStueck, withRollback } from './helpers.ts'

after(closeDb)

/** Bewerteter Bestand einer Variante: Menge, Wert, Durchschnittspreis. */
async function wert(t: TransactionSql, variantId: string) {
  const [row] = await t<{ qty: number; total: number; mac: number }[]>`
    select valued_qty as qty, valuation_total as total, moving_avg_cost as mac
    from product_variants where id = ${variantId}`
  return { qty: Number(row.qty), total: Number(row.total), mac: Number(row.mac) }
}

/** Bestätigte Bestellung mit einer Zeile; liefert Eingangs-Picking und Bewegung. */
async function bestellung(
  t: TransactionSql,
  opts: { preis: number; menge: number; waehrung?: string; kurs?: number; gewicht?: number },
) {
  const uom = await uomStueck(t)
  const variantId = await makeProduct(t, `Bewert-${Math.random().toString(36).slice(2, 7)}`, {
    weightG: opts.gewicht ?? 100,
  })
  await t`update product_templates pt set can_be_purchased = true, route_buy = true
          from product_variants pv where pv.template_id = pt.id and pv.id = ${variantId}`

  const [vendor] = await t<{ id: string }[]>`
    insert into partners (name, is_vendor) values ('Bewert-Lieferant', true) returning id`
  if (opts.waehrung && opts.kurs) {
    // Kurs für heute setzen: er gewinnt gegen etwaige ältere Kurse in der
    // Datenbank, damit der Test nicht vom Bestand abhängt.
    await t`insert into exchange_rates (currency, rate, valid_from)
            values (${opts.waehrung}, ${opts.kurs}, current_date)
            on conflict (currency, valid_from) do update set rate = excluded.rate`
  }
  const [po] = await t<{ id: string }[]>`
    insert into purchase_orders (number, vendor_id, currency)
    values (next_sequence('purchase'), ${vendor.id}, ${opts.waehrung ?? 'EUR'})
    returning id`
  await t`select purchase_snapshot_rate(${po.id})`
  await t`insert into purchase_order_lines (order_id, variant_id, name, qty, uom_id, price_unit)
          values (${po.id}, ${variantId}, 'Ware', ${opts.menge}, ${uom}, ${opts.preis})`

  const [res] = await t<{ confirm_purchase_order: string }[]>`
    select confirm_purchase_order(${po.id})`
  return { variantId, poId: po.id, pickingId: res.confirm_purchase_order, uom }
}

describe('Bestandsbewertung (0018)', () => {
  test('Wareneingang bewertet zum Bestellpreis', async () => {
    await withRollback(async (t) => {
      const s = await bestellung(t, { preis: 2.5, menge: 100 })
      await t`select picking_validate(${s.pickingId})`

      const w = await wert(t, s.variantId)
      assert.equal(w.qty, 100)
      assert.equal(w.total, 250)
      assert.equal(w.mac, 2.5)
    })
  })

  test('gleitender Durchschnitt mischt zwei Zugänge korrekt', async () => {
    await withRollback(async (t) => {
      // 100 Stück à 2,00 €
      const s = await bestellung(t, { preis: 2.0, menge: 100 })
      await t`select picking_validate(${s.pickingId})`

      // 100 Stück à 3,00 € desselben Artikels
      const uom = await uomStueck(t)
      const [vendor] = await t<{ id: string }[]>`
        select vendor_id as id from purchase_orders where id = ${s.poId}`
      const [po2] = await t<{ id: string }[]>`
        insert into purchase_orders (number, vendor_id)
        values (next_sequence('purchase'), ${vendor.id}) returning id`
      await t`insert into purchase_order_lines (order_id, variant_id, name, qty, uom_id, price_unit)
              values (${po2.id}, ${s.variantId}, 'Ware', 100, ${uom}, 3.00)`
      const [res2] = await t<{ confirm_purchase_order: string }[]>`
        select confirm_purchase_order(${po2.id})`
      await t`select picking_validate(${res2.confirm_purchase_order})`

      const w = await wert(t, s.variantId)
      assert.equal(w.qty, 200)
      assert.equal(w.total, 500)
      assert.equal(w.mac, 2.5, '(200 + 300) / 200 = 2,50 €')
    })
  })

  test('Abgang bewertet zum Durchschnitt und lässt ihn stehen', async () => {
    await withRollback(async (t) => {
      const s = await bestellung(t, { preis: 4.0, menge: 50 })
      await t`select picking_validate(${s.pickingId})`

      // 20 Stück ausliefern
      const [dot] = await t<{ id: string; src: string; dest: string }[]>`
        select id, default_src_id as src, default_dest_id as dest
        from operation_types where kind = 'delivery' limit 1`
      const [lief] = await t<{ id: string }[]>`
        insert into stock_pickings (number, operation_type_id, state)
        values (next_sequence('delivery'), ${dot.id}, 'draft') returning id`
      await t`insert into stock_moves (picking_id, variant_id, uom_id, qty, src_location_id, dest_location_id)
              values (${lief.id}, ${s.variantId}, ${s.uom}, 20, ${dot.src}, ${dot.dest})`
      await t`select picking_confirm(${lief.id})`
      await t`select picking_validate(${lief.id})`

      const w = await wert(t, s.variantId)
      assert.equal(w.qty, 30)
      assert.equal(w.total, 120, '30 × 4,00 €')
      assert.equal(w.mac, 4, 'Durchschnitt bleibt beim Abgang unverändert')

      const [abgang] = await t<{ value: number; unit_cost: number }[]>`
        select value, unit_cost from stock_valuation_layers
        where variant_id = ${s.variantId} and layer_type = 'issue'`
      assert.equal(Number(abgang.value), -80, 'Warenabgang zum Durchschnitt bewertet')
      assert.equal(Number(abgang.unit_cost), 4)
    })
  })

  test('Fremdwährung: Einkauf in USD wird zum Kurs eingebucht', async () => {
    await withRollback(async (t) => {
      // 1 USD = 0,90 EUR
      const s = await bestellung(t, { preis: 10, menge: 10, waehrung: 'USD', kurs: 0.9 })
      const [po] = await t<{ exchange_rate: number }[]>`
        select exchange_rate from purchase_orders where id = ${s.poId}`
      assert.equal(Number(po.exchange_rate), 0.9, 'Kurs beim Bestätigen eingefroren')

      await t`select picking_validate(${s.pickingId})`
      const w = await wert(t, s.variantId)
      assert.equal(w.mac, 9, '10 USD × 0,90 = 9,00 €')
      assert.equal(w.total, 90)
    })
  })

  test('interne Umlagerung ändert den Wert nicht', async () => {
    await withRollback(async (t) => {
      const s = await bestellung(t, { preis: 5, menge: 10 })
      await t`select picking_validate(${s.pickingId})`
      const vorher = await wert(t, s.variantId)

      const [ziel] = await t<{ id: string }[]>`
        insert into stock_locations (warehouse_id, parent_id, name, full_path, type)
        select warehouse_id, id, 'Regal B', '', 'internal' from stock_locations
        where full_path = 'WH/Stock' returning id`
      const [quelle] = await t<{ id: string }[]>`
        select id from stock_locations where full_path = 'WH/Stock'`
      const [iot] = await t<{ id: string }[]>`
        select id from operation_types where kind = 'internal' limit 1`
      const [transfer] = await t<{ id: string }[]>`
        insert into stock_pickings (number, operation_type_id, state)
        values (next_sequence('internal'), ${iot.id}, 'draft') returning id`
      await t`insert into stock_moves (picking_id, variant_id, uom_id, qty, src_location_id, dest_location_id)
              values (${transfer.id}, ${s.variantId}, ${s.uom}, 4, ${quelle.id}, ${ziel.id})`
      await t`select picking_confirm(${transfer.id})`
      await t`select picking_validate(${transfer.id})`

      const nachher = await wert(t, s.variantId)
      assert.deepEqual(nachher, vorher, 'Umlagerung ist wertneutral')
    })
  })

  test('Nebenkosten nach Gewicht verteilen und den Einstand heben', async () => {
    await withRollback(async (t) => {
      // Zwei Positionen mit unterschiedlichem Gewicht in einem Eingang
      const uom = await uomStueck(t)
      const leicht = await makeProduct(t, 'Leichtteil', { weightG: 100 })
      const schwer = await makeProduct(t, 'Schwerteil', { weightG: 300 })
      await t`update product_templates set can_be_purchased = true, route_buy = true
              where id in (select template_id from product_variants where id in (${leicht}, ${schwer}))`
      const [vendor] = await t<{ id: string }[]>`
        insert into partners (name, is_vendor) values ('Frachtlieferant', true) returning id`
      const [po] = await t<{ id: string }[]>`
        insert into purchase_orders (number, vendor_id)
        values (next_sequence('purchase'), ${vendor.id}) returning id`
      await t`insert into purchase_order_lines (order_id, variant_id, name, qty, uom_id, price_unit)
              values (${po.id}, ${leicht}, 'Leicht', 10, ${uom}, 1),
                     (${po.id}, ${schwer}, 'Schwer', 10, ${uom}, 1)`
      const [res] = await t<{ confirm_purchase_order: string }[]>`
        select confirm_purchase_order(${po.id})`
      await t`select picking_validate(${res.confirm_purchase_order})`

      // 400 € Fracht auf Gesamtgewicht 10×100 + 10×300 = 4000 g
      const [lc] = await t<{ id: string }[]>`
        insert into landed_costs (number, picking_id, cost_type, basis, amount)
        values (next_sequence('landed'), ${res.confirm_purchase_order}, 'freight', 'weight', 400)
        returning id`
      await t`select landed_cost_post(${lc.id}, 'test')`

      const wLeicht = await wert(t, leicht)
      const wSchwer = await wert(t, schwer)
      // Leicht: 1000/4000 = 25 % → 100 €; Schwer: 3000/4000 = 75 % → 300 €
      assert.equal(wLeicht.total, 10 + 100, 'Ware 10 € + Fracht 100 €')
      assert.equal(wSchwer.total, 10 + 300, 'Ware 10 € + Fracht 300 €')
      assert.equal(wLeicht.mac, 11, 'Einstand steigt von 1,00 auf 11,00 €')
      assert.equal(wSchwer.mac, 31)
    })
  })

  test('Nebenkosten nach Wert verteilen', async () => {
    await withRollback(async (t) => {
      const uom = await uomStueck(t)
      const guenstig = await makeProduct(t, 'Günstig', { weightG: 100 })
      const teuer = await makeProduct(t, 'Teuer', { weightG: 100 })
      await t`update product_templates set can_be_purchased = true
              where id in (select template_id from product_variants where id in (${guenstig}, ${teuer}))`
      const [vendor] = await t<{ id: string }[]>`
        insert into partners (name, is_vendor) values ('Zolllieferant', true) returning id`
      const [po] = await t<{ id: string }[]>`
        insert into purchase_orders (number, vendor_id)
        values (next_sequence('purchase'), ${vendor.id}) returning id`
      await t`insert into purchase_order_lines (order_id, variant_id, name, qty, uom_id, price_unit)
              values (${po.id}, ${guenstig}, 'Günstig', 10, ${uom}, 1),
                     (${po.id}, ${teuer}, 'Teuer', 10, ${uom}, 9)`
      const [res] = await t<{ confirm_purchase_order: string }[]>`
        select confirm_purchase_order(${po.id})`
      await t`select picking_validate(${res.confirm_purchase_order})`

      // 100 € Zoll auf Warenwert 10 + 90 = 100 €
      const [lc] = await t<{ id: string }[]>`
        insert into landed_costs (number, picking_id, cost_type, basis, amount)
        values (next_sequence('landed'), ${res.confirm_purchase_order}, 'customs_duty', 'value', 100)
        returning id`
      await t`select landed_cost_post(${lc.id}, 'test')`

      assert.equal((await wert(t, guenstig)).total, 10 + 10, '10 % Anteil')
      assert.equal((await wert(t, teuer)).total, 90 + 90, '90 % Anteil')
    })
  })

  test('Nebenkosten stornieren nimmt den Wert wieder heraus', async () => {
    await withRollback(async (t) => {
      const s = await bestellung(t, { preis: 5, menge: 10, gewicht: 200 })
      await t`select picking_validate(${s.pickingId})`
      const vorher = await wert(t, s.variantId)

      const [lc] = await t<{ id: string }[]>`
        insert into landed_costs (number, picking_id, amount, is_estimate)
        values (next_sequence('landed'), ${s.pickingId}, 50, true) returning id`
      await t`select landed_cost_post(${lc.id}, 'test')`
      assert.equal((await wert(t, s.variantId)).total, vorher.total + 50)

      await t`select landed_cost_cancel(${lc.id}, 'test')`
      assert.equal((await wert(t, s.variantId)).total, vorher.total, 'Schätzung zurückgenommen')
    })
  })

  test('Wertschichten sind unveränderlich', async () => {
    await withRollback(async (t) => {
      const s = await bestellung(t, { preis: 3, menge: 5 })
      await t`select picking_validate(${s.pickingId})`
      await expectError(
        t,
        (sp) => sp`update stock_valuation_layers set value = 999 where variant_id = ${s.variantId}`,
        /unveränderlich/,
      )
      await expectError(
        t,
        (sp) => sp`delete from stock_valuation_layers where variant_id = ${s.variantId}`,
        /unveränderlich/,
      )
    })
  })

  test('Fertigung: Materialwert wandert ins Fertigprodukt', async () => {
    await withRollback(async (t) => {
      const uom = await uomStueck(t)
      const komponente = await makeProduct(t, 'Wert-Komponente')
      await stockUp(t, komponente, 100)
      // Komponente mit 2 € bewerten
      await t`select valuation_apply(${komponente}, null, 'revaluation', 0, null, 200, 'Anfangswert')`
      await t`update product_variants set valued_qty = 100,
                moving_avg_cost = 2, valuation_total = 200 where id = ${komponente}`

      const fertig = await makeProduct(t, 'Wert-Produkt')
      await t`update product_templates pt set route_manufacture = true
              from product_variants pv where pv.template_id = pt.id and pv.id = ${fertig}`
      const [bom] = await t<{ id: string }[]>`
        insert into boms (template_id, qty, uom_id)
        select template_id, 1, ${uom} from product_variants where id = ${fertig} returning id`
      await t`insert into bom_lines (bom_id, component_variant_id, qty, uom_id)
              values (${bom.id}, ${komponente}, 5, ${uom})`

      const [mo] = await t<{ create_manufacturing_order: string }[]>`
        select create_manufacturing_order(${fertig}, 2)`
      await t`select mo_confirm(${mo.create_manufacturing_order})`
      await t`select mo_produce(${mo.create_manufacturing_order})`

      // 10 Komponenten à 2 € = 20 € Materialwert sind abgegangen
      const wKomp = await wert(t, komponente)
      assert.equal(wKomp.qty, 90)
      assert.equal(wKomp.total, 180)

      const [verbrauch] = await t<{ value: number }[]>`
        select sum(value) as value from stock_valuation_layers
        where variant_id = ${komponente} and layer_type = 'production'`
      assert.equal(Number(verbrauch.value), -20, 'Materialabgang zum Durchschnitt')
    })
  })
})
