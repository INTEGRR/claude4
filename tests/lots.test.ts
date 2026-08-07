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
import { parseLotSpec } from '../src/modules/shared/form.ts'

after(closeDb)

/** Los-Ledger-Invariante: Los-Bestand == Zuordnungen erledigter Bewegungen. */
async function assertLotLedgerConsistent(t: TransactionSql): Promise<void> {
  const rows = await t<{ lot_id: string; diff: number }[]>`
    with ledger as (
      select m.dest_location_id as location_id, m.variant_id, a.lot_id, sum(a.qty) as qty
      from move_lot_assignments a join stock_moves m on m.id = a.move_id
      where m.state = 'done' group by 1, 2, 3
      union all
      select m.src_location_id, m.variant_id, a.lot_id, -sum(a.qty)
      from move_lot_assignments a join stock_moves m on m.id = a.move_id
      where m.state = 'done' group by 1, 2, 3
    ), summed as (
      select location_id, variant_id, lot_id, sum(qty) as qty from ledger group by 1, 2, 3
    )
    select coalesce(q.lot_id, s.lot_id) as lot_id,
           abs(coalesce(q.on_hand, 0) - coalesce(s.qty, 0)) as diff
    from stock_lot_quants q
    full outer join summed s
      on s.location_id = q.location_id and s.variant_id = q.variant_id and s.lot_id = q.lot_id
    where abs(coalesce(q.on_hand, 0) - coalesce(s.qty, 0)) > 0.0001`
  assert.equal(rows.length, 0, 'Los-Ledger-Invariante verletzt')
}

/** Serienverfolgtes Produkt + bestätigter Wareneingang über ein Picking. */
async function trackedReceipt(t: TransactionSql, tracking: 'lot' | 'serial', menge: number) {
  const uom = await uomStueck(t)
  const variantId = await makeProduct(t, `Track-${tracking}-${Math.random().toString(36).slice(2, 6)}`)
  await t`update product_templates pt set tracking = ${tracking}
          from product_variants pv where pv.template_id = pt.id and pv.id = ${variantId}`

  const [ot] = await t<{ id: string; src: string; dest: string }[]>`
    select id, default_src_id as src, default_dest_id as dest
    from operation_types where kind = 'receipt' limit 1`
  const [picking] = await t<{ id: string }[]>`
    insert into stock_pickings (number, operation_type_id, state)
    values (next_sequence('receipt'), ${ot.id}, 'draft') returning id`
  const [move] = await t<{ id: string }[]>`
    insert into stock_moves (picking_id, variant_id, uom_id, qty, src_location_id, dest_location_id)
    values (${picking.id}, ${variantId}, ${uom}, ${menge}, ${ot.src}, ${ot.dest})
    returning id`
  await t`select picking_confirm(${picking.id})`
  return { variantId, pickingId: picking.id, moveId: move.id, uom }
}

describe('Lose & Seriennummern (0017)', () => {
  test('parseLotSpec: Serien- und Losformate', () => {
    assert.deepEqual(parseLotSpec('SN-1, SN-2', 'serial'), [
      { name: 'SN-1', qty: 1 },
      { name: 'SN-2', qty: 1 },
    ])
    assert.deepEqual(parseLotSpec('CHARGE-A:10, CHARGE-B:2,5', 'lot'), [
      { name: 'CHARGE-A', qty: 10 },
      { name: 'CHARGE-B', qty: 2.5 },
    ])
    assert.throws(() => parseLotSpec('ohne-menge', 'lot'), /NAME:MENGE/)
  })

  test('Wareneingang ohne Angabe legt Seriennummern automatisch an (1 je Stück)', async () => {
    await withRollback(async (t) => {
      const s = await trackedReceipt(t, 'serial', 3)
      await t`select picking_validate(${s.pickingId})`

      const lots = await t<{ name: string; qty: number }[]>`
        select sl.name, a.qty from move_lot_assignments a
        join stock_lots sl on sl.id = a.lot_id where a.move_id = ${s.moveId}`
      assert.equal(lots.length, 3, 'drei automatische Seriennummern')
      assert.ok(lots.every((l) => Number(l.qty) === 1))
      assert.equal(await onHand(t, s.variantId), 3)
      await assertLedgerConsistent(t)
      await assertLotLedgerConsistent(t)
    })
  })

  test('explizite Seriennummern werden übernommen; Menge ≠ 1 ist gesperrt', async () => {
    await withRollback(async (t) => {
      const s = await trackedReceipt(t, 'serial', 2)
      await t`select set_move_lots(${s.moveId},
        ${t.json([{ name: 'KB-0001', qty: 1 }, { name: 'KB-0002', qty: 1 }])})`
      await t`select picking_validate(${s.pickingId})`

      const [lot] = await t<{ count: number }[]>`
        select count(*)::int as count from stock_lots sl
        where sl.variant_id = ${s.variantId} and sl.name in ('KB-0001', 'KB-0002')`
      assert.equal(lot.count, 2)

      await expectError(
        t,
        (sp) => sp`select set_move_lots(${s.moveId}, ${sp.json([{ name: 'X', qty: 2 }])})`,
        /Menge 1|nur vor der Buchung/,
      )
    })
  })

  test('Loszuordnung muss zur gebuchten Menge passen', async () => {
    await withRollback(async (t) => {
      const s = await trackedReceipt(t, 'lot', 10)
      await t`select set_move_lots(${s.moveId}, ${t.json([{ name: 'CHARGE-A', qty: 4 }])})`
      await expectError(
        t,
        (sp) => sp`select picking_validate(${s.pickingId})`,
        /Loszuordnung .* entspricht nicht/,
      )
    })
  })

  test('Auslieferung zieht automatisch FIFO vom ältesten Los', async () => {
    await withRollback(async (t) => {
      const uom = await uomStueck(t)
      // Zwei Chargen einbuchen (A zuerst → älter)
      const s = await trackedReceipt(t, 'lot', 6)
      await t`select set_move_lots(${s.moveId}, ${t.json([{ name: 'A', qty: 6 }])})`
      await t`select picking_validate(${s.pickingId})`

      const [ot] = await t<{ id: string; src: string; dest: string }[]>`
        select id, default_src_id as src, default_dest_id as dest
        from operation_types where kind = 'receipt' limit 1`
      const [p2] = await t<{ id: string }[]>`
        insert into stock_pickings (number, operation_type_id, state)
        values (next_sequence('receipt'), ${ot.id}, 'draft') returning id`
      const [m2] = await t<{ id: string }[]>`
        insert into stock_moves (picking_id, variant_id, uom_id, qty, src_location_id, dest_location_id)
        values (${p2.id}, ${s.variantId}, ${uom}, 4, ${ot.src}, ${ot.dest}) returning id`
      await t`select picking_confirm(${p2.id})`
      await t`select set_move_lots(${m2.id}, ${t.json([{ name: 'B', qty: 4 }])})`
      await t`select picking_validate(${p2.id})`

      // Lieferung über 8: erwartet 6 aus A (älter) + 2 aus B.
      const [dot] = await t<{ id: string; src: string; dest: string }[]>`
        select id, default_src_id as src, default_dest_id as dest
        from operation_types where kind = 'delivery' limit 1`
      const [lieferung] = await t<{ id: string }[]>`
        insert into stock_pickings (number, operation_type_id, state)
        values (next_sequence('delivery'), ${dot.id}, 'draft') returning id`
      const [lm] = await t<{ id: string }[]>`
        insert into stock_moves (picking_id, variant_id, uom_id, qty, src_location_id, dest_location_id)
        values (${lieferung.id}, ${s.variantId}, ${uom}, 8, ${dot.src}, ${dot.dest}) returning id`
      await t`select picking_confirm(${lieferung.id})`
      await t`select picking_validate(${lieferung.id})`

      const zuordnung = await t<{ name: string; qty: number }[]>`
        select sl.name, a.qty from move_lot_assignments a
        join stock_lots sl on sl.id = a.lot_id where a.move_id = ${lm.id} order by sl.name`
      assert.deepEqual(
        zuordnung.map((z) => ({ name: z.name, qty: Number(z.qty) })),
        [{ name: 'A', qty: 6 }, { name: 'B', qty: 2 }],
      )
      await assertLotLedgerConsistent(t)
    })
  })

  test('Fertigmeldung mit Seriennummer: Los am Auftrag, Bestand je Los', async () => {
    await withRollback(async (t) => {
      const uom = await uomStueck(t)
      const komponente = await makeProduct(t, 'Los-Komponente')
      await stockUp(t, komponente, 10)

      const fertigVariant = await makeProduct(t, 'Los-Tastatur')
      await t`update product_templates pt set tracking = 'serial', route_manufacture = true
              from product_variants pv where pv.template_id = pt.id and pv.id = ${fertigVariant}`
      const [bom] = await t<{ id: string }[]>`
        insert into boms (template_id, qty, uom_id)
        select pv.template_id, 1, ${uom} from product_variants pv
        where pv.id = ${fertigVariant} returning id`
      await t`insert into bom_lines (bom_id, component_variant_id, qty, uom_id)
              values (${bom.id}, ${komponente}, 2, ${uom})`

      const [mo] = await t<{ create_manufacturing_order: string }[]>`
        select create_manufacturing_order(${fertigVariant}, 1)`
      await t`select mo_confirm(${mo.create_manufacturing_order})`
      await t`select mo_produce(${mo.create_manufacturing_order}, null, '{}', true, 'test', 'SN-KB-100')`

      const [row] = await t<{ name: string }[]>`
        select sl.name from manufacturing_orders mo
        join stock_lots sl on sl.id = mo.lot_producing_id
        where mo.id = ${mo.create_manufacturing_order}`
      assert.equal(row.name, 'SN-KB-100')

      const [lq] = await t<{ on_hand: number }[]>`
        select lq.on_hand from stock_lot_quants lq
        join stock_lots sl on sl.id = lq.lot_id
        join stock_locations loc on loc.id = lq.location_id
        where sl.name = 'SN-KB-100' and loc.full_path = 'WH/Stock'`
      assert.equal(Number(lq.on_hand), 1)
      await assertLedgerConsistent(t)
      await assertLotLedgerConsistent(t)
    })
  })

  test('Altbestand ohne Lose läuft über das Sonderlos ALTBESTAND', async () => {
    await withRollback(async (t) => {
      const uom = await uomStueck(t)
      const variantId = await makeProduct(t, 'Altbestand-Teil')
      await stockUp(t, variantId, 5)  // Bestand VOR Aktivierung der Verfolgung
      await t`update product_templates pt set tracking = 'lot'
              from product_variants pv where pv.template_id = pt.id and pv.id = ${variantId}`

      const [dot] = await t<{ id: string; src: string; dest: string }[]>`
        select id, default_src_id as src, default_dest_id as dest
        from operation_types where kind = 'delivery' limit 1`
      const [lieferung] = await t<{ id: string }[]>`
        insert into stock_pickings (number, operation_type_id, state)
        values (next_sequence('delivery'), ${dot.id}, 'draft') returning id`
      const [lm] = await t<{ id: string }[]>`
        insert into stock_moves (picking_id, variant_id, uom_id, qty, src_location_id, dest_location_id)
        values (${lieferung.id}, ${variantId}, ${uom}, 3, ${dot.src}, ${dot.dest}) returning id`
      await t`select picking_confirm(${lieferung.id})`
      await t`select picking_validate(${lieferung.id})`

      const [zuordnung] = await t<{ name: string; qty: number }[]>`
        select sl.name, a.qty from move_lot_assignments a
        join stock_lots sl on sl.id = a.lot_id where a.move_id = ${lm.id}`
      assert.equal(zuordnung.name, 'ALTBESTAND')
      assert.equal(Number(zuordnung.qty), 3)
      assert.equal(await onHand(t, variantId), 2)
      await assertLedgerConsistent(t)
    })
  })
})
