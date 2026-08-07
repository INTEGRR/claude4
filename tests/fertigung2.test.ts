import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { TransactionSql } from 'postgres'
import {
  assertLedgerConsistent,
  closeDb,
  expectError,
  makeProduct,
  onHand,
  stockUp,
  uomStueck,
  withRollback,
} from './helpers.ts'

after(closeDb)

/**
 * Fertigung II: Phantom-Baugruppen, Arbeitsgänge und Backflush.
 *
 * Der reale Fall: die Tastatur enthält ein "Gehäuse-Set" — eine Baugruppe, die
 * nie einzeln im Regal liegt, sondern aus Oberschale, Unterschale und
 * Schraubensatz besteht. Für den Fertigungsauftrag müssen die drei Teile im
 * Bedarf stehen, nicht das Set.
 */
let counter = 0

type Szenario = Awaited<ReturnType<typeof phantomScenario>>

async function phantomScenario(t: TransactionSql) {
  const uom = await uomStueck(t)
  const suffix = `P${++counter}`

  // Endprodukt mit Fertigungs-Stückliste
  const tastatur = await makeProduct(t, `Tastatur ${suffix}`)
  const [tpl] = await t<{ template_id: string }[]>`
    select template_id from product_variants where id = ${tastatur}`

  // Baugruppe "Gehäuse-Set" — bekommt eine Kit-Stückliste (Odoo: phantom)
  const set = await makeProduct(t, `Gehäuse-Set ${suffix}`)
  const [setTpl] = await t<{ template_id: string }[]>`
    select template_id from product_variants where id = ${set}`

  const oben = await makeProduct(t, `Oberschale ${suffix}`)
  const unten = await makeProduct(t, `Unterschale ${suffix}`)
  const schrauben = await makeProduct(t, `Schrauben ${suffix}`)
  const platine = await makeProduct(t, `Platine ${suffix}`)

  const [kit] = await t<{ id: string }[]>`
    insert into boms (template_id, qty, uom_id, bom_type)
    values (${setTpl.template_id}, 1, ${uom}, 'kit') returning id`
  await t`
    insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id, issue_method)
    values (${kit.id}, 10, ${oben}, 1, ${uom}, 'backflush'),
           (${kit.id}, 20, ${unten}, 1, ${uom}, 'backflush'),
           (${kit.id}, 30, ${schrauben}, 8, ${uom}, 'backflush')`

  const [bom] = await t<{ id: string }[]>`
    insert into boms (template_id, qty, uom_id) values (${tpl.template_id}, 1, ${uom}) returning id`
  await t`
    insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id, issue_method)
    values (${bom.id}, 10, ${platine}, 1, ${uom}, 'manual'),
           (${bom.id}, 20, ${set}, 1, ${uom}, 'backflush')`

  return { uom, tastatur, set, kit: kit.id, bom: bom.id, oben, unten, schrauben, platine }
}

/** Bucht Bestand für alle Einzelteile und legt Einstandspreise fest. */
async function stockComponents(t: TransactionSql, s: Szenario, cost: Record<string, number>) {
  for (const [variant, preis] of Object.entries(cost)) {
    await t`
      update product_templates set standard_cost = ${preis}
      where id = (select template_id from product_variants where id = ${variant})`
    await stockUp(t, variant, 100)
  }
  // Altbestand bewerten, damit die Abgänge nicht mit 0 € laufen.
  for (const variant of Object.keys(cost)) {
    await t`select valuation_initialize(${variant}, 'test')`
  }
}

async function workCenter(t: TransactionSql, costPerHour: number, efficiency = 100) {
  const [wc] = await t<{ id: string }[]>`
    insert into work_centers (code, name, cost_per_hour, time_efficiency)
    values (${`WC${++counter}`}, ${`Montage ${counter}`}, ${costPerHour}, ${efficiency})
    returning id`
  return wc.id
}

describe('Phantom-Baugruppen', () => {
  test('die Baugruppe wird in ihre Bestandteile aufgelöst', async () => {
    await withRollback(async (t) => {
      const s = await phantomScenario(t)

      const rows = await t<
        { component_variant_id: string; qty: number; phantom_path: string | null }[]
      >`select component_variant_id, qty, phantom_path
        from bom_explode(${s.bom}, ${s.tastatur}, 3)`

      const ids = rows.map((r) => r.component_variant_id)
      assert.ok(!ids.includes(s.set), 'das Set selbst taucht nicht auf')
      assert.equal(rows.length, 4, 'Platine + Ober- + Unterschale + Schrauben')
      assert.equal(Number(rows.find((r) => r.component_variant_id === s.schrauben)!.qty), 24, '8 × 3')
      assert.equal(Number(rows.find((r) => r.component_variant_id === s.platine)!.qty), 3)

      const oberschale = rows.find((r) => r.component_variant_id === s.oben)!
      assert.ok(oberschale.phantom_path?.includes('Gehäuse-Set'), 'Herkunft ist nachvollziehbar')
      assert.equal(rows.find((r) => r.component_variant_id === s.platine)!.phantom_path, null)
    })
  })

  test('der Fertigungsauftrag bucht die Bestandteile, nicht die Baugruppe', async () => {
    await withRollback(async (t) => {
      const s = await phantomScenario(t)
      const [mo] = await t<{ create_manufacturing_order: string }[]>`
        select create_manufacturing_order(${s.tastatur}, 2)`

      const moves = await t<
        { variant_id: string; qty: number; issue_method: string; phantom_path: string | null }[]
      >`select variant_id, qty, issue_method, phantom_path from stock_moves
        where production_id = ${mo.create_manufacturing_order}`

      assert.equal(moves.length, 4)
      assert.ok(!moves.some((m) => m.variant_id === s.set))
      assert.equal(Number(moves.find((m) => m.variant_id === s.schrauben)!.qty), 16)
      assert.equal(
        moves.find((m) => m.variant_id === s.platine)!.issue_method,
        'manual',
        'die Verbrauchsart der Stücklistenposition wird übernommen',
      )
      assert.ok(moves.find((m) => m.variant_id === s.unten)!.phantom_path)
    })
  })

  test('Baugruppe in Baugruppe wird über beide Stufen aufgelöst', async () => {
    await withRollback(async (t) => {
      const s = await phantomScenario(t)

      // Der Schraubensatz wird selbst zur Baugruppe: 4 Schrauben + 4 Muttern.
      const mutter = await makeProduct(t, `Mutter ${counter}`)
      const [schraubenTpl] = await t<{ template_id: string }[]>`
        select template_id from product_variants where id = ${s.schrauben}`
      const [kit2] = await t<{ id: string }[]>`
        insert into boms (template_id, qty, uom_id, bom_type)
        values (${schraubenTpl.template_id}, 8, ${s.uom}, 'kit') returning id`
      const schraube = await makeProduct(t, `Einzelschraube ${counter}`)
      await t`insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
              values (${kit2.id}, 10, ${schraube}, 8, ${s.uom}),
                     (${kit2.id}, 20, ${mutter}, 8, ${s.uom})`

      const rows = await t<{ component_variant_id: string; qty: number; phantom_path: string }[]>`
        select component_variant_id, qty, phantom_path from bom_explode(${s.bom}, ${s.tastatur}, 1)`

      const ids = rows.map((r) => r.component_variant_id)
      assert.ok(!ids.includes(s.schrauben), 'der Schraubensatz ist aufgelöst')
      assert.ok(ids.includes(schraube) && ids.includes(mutter))
      assert.equal(Number(rows.find((r) => r.component_variant_id === schraube)!.qty), 8)

      const pfad = rows.find((r) => r.component_variant_id === mutter)!.phantom_path
      assert.ok(pfad.includes('Gehäuse-Set') && pfad.includes('Schrauben'), `Pfad über beide Stufen: ${pfad}`)
    })
  })

  test('eine zirkuläre Baugruppe wird abgefangen statt endlos aufzulösen', async () => {
    await withRollback(async (t) => {
      const s = await phantomScenario(t)
      // Das Set enthält sich selbst — ein Pflegefehler, der nicht die
      // Datenbank blockieren darf.
      await t`insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
              values (${s.kit}, 40, ${s.set}, 1, ${s.uom})`

      await expectError(
        t,
        (sp) => sp`select * from bom_explode(${s.bom}, ${s.tastatur}, 1)`,
        /zu tief verschachtelt/,
      )
    })
  })
})

describe('Backflush und manueller Verbrauch', () => {
  test('manuelle Positionen verlangen eine Erfassung', async () => {
    await withRollback(async (t) => {
      const s = await phantomScenario(t)
      await stockComponents(t, s, { [s.platine]: 12, [s.oben]: 5, [s.unten]: 5, [s.schrauben]: 0.1 })

      const [mo] = await t<{ create_manufacturing_order: string }[]>`
        select create_manufacturing_order(${s.tastatur}, 1)`
      await t`select mo_confirm(${mo.create_manufacturing_order}, 'test')`

      await expectError(
        t,
        (sp) => sp`select mo_produce(${mo.create_manufacturing_order}, 1)`,
        /muss der Verbrauch erfasst werden/,
      )
    })
  })

  test('Backflush-Positionen laufen automatisch mit', async () => {
    await withRollback(async (t) => {
      const s = await phantomScenario(t)
      await stockComponents(t, s, { [s.platine]: 12, [s.oben]: 5, [s.unten]: 5, [s.schrauben]: 0.1 })

      const [mo] = await t<{ create_manufacturing_order: string }[]>`
        select create_manufacturing_order(${s.tastatur}, 2)`
      const moId = mo.create_manufacturing_order
      await t`select mo_confirm(${moId}, 'test')`

      const [platineMove] = await t<{ id: string }[]>`
        select id from stock_moves where production_id = ${moId} and variant_id = ${s.platine}`

      // Nur die manuelle Position wird erfasst — die drei Backflush-Positionen
      // verbraucht die Fertigmeldung von selbst.
      await t`select mo_produce(${moId}, 2, ${t.json({ [platineMove.id]: 2 })}, true, 'test')`

      assert.equal(await onHand(t, s.schrauben), 100 - 16, '8 Schrauben je Stück, automatisch')
      assert.equal(await onHand(t, s.oben), 98)
      assert.equal(await onHand(t, s.platine), 98)
      assert.equal(await onHand(t, s.tastatur), 2)
      await assertLedgerConsistent(t)
    })
  })
})

describe('Arbeitsgänge und Herstellkosten', () => {
  test('Vorgabezeit skaliert mit der Menge, Rüstzeit fällt einmal an', async () => {
    await withRollback(async (t) => {
      const s = await phantomScenario(t)
      const wc = await workCenter(t, 60)
      await t`insert into bom_operations (bom_id, sequence, name, work_center_id,
                                          duration_minutes, setup_minutes)
              values (${s.bom}, 10, 'Montage', ${wc}, 15, 20)`

      const [mo] = await t<{ create_manufacturing_order: string }[]>`
        select create_manufacturing_order(${s.tastatur}, 4)`
      const [op] = await t<{ duration_expected: number; cost_per_hour: number }[]>`
        select duration_expected, cost_per_hour from mo_operations
        where mo_id = ${mo.create_manufacturing_order}`

      assert.equal(Number(op.duration_expected), 80, '20 Min. Rüsten + 4 × 15 Min.')
      assert.equal(Number(op.cost_per_hour), 60, 'Stundensatz ist eingefroren')
    })
  })

  test('ein langsamerer Arbeitsplatz braucht länger', async () => {
    await withRollback(async (t) => {
      const s = await phantomScenario(t)
      const wc = await workCenter(t, 60, 80) // 80 % Leistung
      await t`insert into bom_operations (bom_id, sequence, name, work_center_id, duration_minutes)
              values (${s.bom}, 10, 'Montage', ${wc}, 40)`

      const [mo] = await t<{ create_manufacturing_order: string }[]>`
        select create_manufacturing_order(${s.tastatur}, 1)`
      const [op] = await t<{ duration_expected: number }[]>`
        select duration_expected from mo_operations where mo_id = ${mo.create_manufacturing_order}`

      assert.equal(Number(op.duration_expected), 50, '40 Min. bei 80 % Leistung = 50 Min.')
    })
  })

  test('erfasste Zeit schlägt die Vorgabezeit', async () => {
    await withRollback(async (t) => {
      const s = await phantomScenario(t)
      await stockComponents(t, s, { [s.platine]: 12, [s.oben]: 5, [s.unten]: 5, [s.schrauben]: 0.1 })
      const wc = await workCenter(t, 90)
      await t`insert into bom_operations (bom_id, sequence, name, work_center_id, duration_minutes)
              values (${s.bom}, 10, 'Montage', ${wc}, 30)`

      const [mo] = await t<{ create_manufacturing_order: string }[]>`
        select create_manufacturing_order(${s.tastatur}, 1)`
      const moId = mo.create_manufacturing_order
      await t`select mo_confirm(${moId}, 'test')`

      const [op] = await t<{ id: string }[]>`select id from mo_operations where mo_id = ${moId}`
      await t`select mo_operation_start(${op.id}, 'test')`
      await t`select mo_operation_finish(${op.id}, 20, 'test')`

      const [cost] = await t<{ mo_labor_cost: number }[]>`select mo_labor_cost(${moId})`
      assert.equal(Number(cost.mo_labor_cost), 30, '20 Min. bei 90 €/h = 30 €')
    })
  })

  test('Material und Lohn bilden den Wert des Fertigprodukts', async () => {
    await withRollback(async (t) => {
      const s = await phantomScenario(t)
      // Material je Tastatur: 12 (Platine) + 5 + 5 + 8 × 0,25 = 24 €
      await stockComponents(t, s, { [s.platine]: 12, [s.oben]: 5, [s.unten]: 5, [s.schrauben]: 0.25 })
      const wc = await workCenter(t, 60)
      await t`insert into bom_operations (bom_id, sequence, name, work_center_id, duration_minutes)
              values (${s.bom}, 10, 'Montage', ${wc}, 30)`

      const [mo] = await t<{ create_manufacturing_order: string }[]>`
        select create_manufacturing_order(${s.tastatur}, 2)`
      const moId = mo.create_manufacturing_order
      await t`select mo_confirm(${moId}, 'test')`

      const [platineMove] = await t<{ id: string }[]>`
        select id from stock_moves where production_id = ${moId} and variant_id = ${s.platine}`
      await t`select mo_produce(${moId}, 2, ${t.json({ [platineMove.id]: 2 })}, true, 'test')`

      const [row] = await t<
        { material_cost: number; labor_cost: number; unit_cost: number }[]
      >`select material_cost, labor_cost, unit_cost from manufacturing_orders where id = ${moId}`

      assert.equal(Number(row.material_cost), 48, '2 × 24 € Material')
      // 30 Min./Stück × 2 Stück = 60 Min. bei 60 €/h
      assert.equal(Number(row.labor_cost), 60, 'Lohn aus der Vorgabezeit')
      assert.equal(Number(row.unit_cost), 54, '(48 + 60) / 2')

      // Der Wert landet auch in der Bewertung des Fertigprodukts.
      const [wert] = await t<{ moving_avg_cost: number; valuation_total: number }[]>`
        select moving_avg_cost, valuation_total from product_variants where id = ${s.tastatur}`
      assert.equal(Number(wert.moving_avg_cost), 54)
      assert.equal(Number(wert.valuation_total), 108)
      await assertLedgerConsistent(t)
    })
  })

  test('Teilfertigung verteilt die Lohnkosten und übergibt den Rest', async () => {
    await withRollback(async (t) => {
      const s = await phantomScenario(t)
      await stockComponents(t, s, { [s.platine]: 10, [s.oben]: 0, [s.unten]: 0, [s.schrauben]: 0 })
      const wc = await workCenter(t, 60)
      await t`insert into bom_operations (bom_id, sequence, name, work_center_id, duration_minutes)
              values (${s.bom}, 10, 'Montage', ${wc}, 30)`

      const [mo] = await t<{ create_manufacturing_order: string }[]>`
        select create_manufacturing_order(${s.tastatur}, 4)`
      const moId = mo.create_manufacturing_order
      await t`select mo_confirm(${moId}, 'test')`

      const [platineMove] = await t<{ id: string }[]>`
        select id from stock_moves where production_id = ${moId} and variant_id = ${s.platine}`
      const [ergebnis] = await t<{ mo_produce: string | null }[]>`
        select mo_produce(${moId}, 1, ${t.json({ [platineMove.id]: 1 })}, true, 'test')`

      const [row] = await t<{ labor_cost: number; unit_cost: number }[]>`
        select labor_cost, unit_cost from manufacturing_orders where id = ${moId}`
      assert.equal(Number(row.labor_cost), 30, 'ein Viertel von 120 Min. = 30 Min. = 30 €')
      assert.equal(Number(row.unit_cost), 40, '10 € Material + 30 € Lohn')

      assert.ok(ergebnis.mo_produce, 'Rückstandsauftrag angelegt')
      const [rest] = await t<{ duration_expected: number }[]>`
        select duration_expected from mo_operations where mo_id = ${ergebnis.mo_produce}`
      assert.equal(Number(rest.duration_expected), 90, 'der Rückstand trägt 3 × 30 Min.')
    })
  })

  test('ohne Arbeitsgänge bleibt die Bewertung reines Material', async () => {
    await withRollback(async (t) => {
      const s = await phantomScenario(t)
      await stockComponents(t, s, { [s.platine]: 10, [s.oben]: 1, [s.unten]: 1, [s.schrauben]: 0 })

      const [mo] = await t<{ create_manufacturing_order: string }[]>`
        select create_manufacturing_order(${s.tastatur}, 1)`
      const moId = mo.create_manufacturing_order
      await t`select mo_confirm(${moId}, 'test')`
      const [platineMove] = await t<{ id: string }[]>`
        select id from stock_moves where production_id = ${moId} and variant_id = ${s.platine}`
      await t`select mo_produce(${moId}, 1, ${t.json({ [platineMove.id]: 1 })}, true, 'test')`

      const [row] = await t<{ labor_cost: number; unit_cost: number }[]>`
        select labor_cost, unit_cost from manufacturing_orders where id = ${moId}`
      assert.equal(Number(row.labor_cost), 0)
      assert.equal(Number(row.unit_cost), 12, '10 + 1 + 1')
    })
  })
})

describe('Demontage mit Baugruppen', () => {
  test('die Demontage gibt die Einzelteile zurück, nicht die Baugruppe', async () => {
    await withRollback(async (t) => {
      const s = await phantomScenario(t)
      await stockUp(t, s.tastatur, 5)

      const [stock] = await t<{ id: string }[]>`
        select id from stock_locations where full_path = 'WH/Stock'`
      const [ub] = await t<{ id: string }[]>`
        insert into unbuild_orders (number, variant_id, bom_id, qty, src_location_id, dest_location_id)
        values (next_sequence('unbuild'), ${s.tastatur}, ${s.bom}, 2, ${stock.id}, ${stock.id})
        returning id`
      await t`select unbuild_apply(${ub.id}, false, 'test')`

      assert.equal(await onHand(t, s.tastatur), 3)
      assert.equal(await onHand(t, s.set), 0, 'das Set kommt nie ins Lager')
      assert.equal(await onHand(t, s.oben), 2)
      assert.equal(await onHand(t, s.schrauben), 16)
      await assertLedgerConsistent(t)
    })
  })
})
