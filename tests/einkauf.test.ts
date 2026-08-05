import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { TransactionSql } from 'postgres'
import {
  assertLedgerConsistent,
  closeDb,
  expectError,
  makeProduct,
  onHand,
  uomStueck,
  withRollback,
} from './helpers.ts'

after(closeDb)

async function purchaseScenario(
  t: TransactionSql,
  opts: { billPolicy?: 'ordered' | 'received'; leadDays?: number } = {},
) {
  const uom = await uomStueck(t)
  const [vendor] = await t<{ id: string }[]>`
    insert into partners (name, is_vendor, email) values ('Bauteile GmbH', true, 'v@example.com')
    returning id`

  const [tpl] = await t<{ id: string }[]>`
    insert into product_templates (name, uom_id, can_be_purchased, route_buy, bill_policy)
    values ('Switch MX', ${uom}, true, true, ${opts.billPolicy ?? 'received'}::bill_policy)
    returning id`
  await t`select generate_variants(${tpl.id})`
  const [variant] = await t<{ id: string }[]>`
    select id from product_variants where template_id = ${tpl.id} limit 1`

  await t`insert into vendor_prices (vendor_id, template_id, price, lead_time_days)
          values (${vendor.id}, ${tpl.id}, 0.35, ${opts.leadDays ?? 5})`

  const [order] = await t<{ id: string }[]>`
    insert into purchase_orders (number, vendor_id) values (next_sequence('purchase'), ${vendor.id})
    returning id`
  const [line] = await t<{ id: string }[]>`
    insert into purchase_order_lines (order_id, variant_id, name, qty, uom_id, price_unit)
    values (${order.id}, ${variant.id}, 'Switch MX', 100, ${uom}, 0.35)
    returning id`

  return { vendorId: vendor.id, variantId: variant.id, orderId: order.id, lineId: line.id, uom }
}

describe('Einkauf: Bestellablauf', () => {
  test('Bestätigen legt den Wareneingang an', async () => {
    await withRollback(async (t) => {
      const s = await purchaseScenario(t, { leadDays: 7 })
      const [res] = await t<{ confirm_purchase_order: string }[]>`
        select confirm_purchase_order(${s.orderId}, 'tester')`

      const [po] = await t<{ state: string; expected_arrival: string }[]>`
        select state, expected_arrival from purchase_orders where id = ${s.orderId}`
      assert.equal(po.state, 'purchase')
      assert.ok(po.expected_arrival, 'erwartete Ankunft aus der Lieferzeit gesetzt')

      const [pick] = await t<{ state: string; origin_label: string }[]>`
        select state, origin_label from stock_pickings where id = ${res.confirm_purchase_order}`
      assert.equal(pick.state, 'assigned', 'Eingänge sind sofort bereit')

      const moves = await t`select id from stock_moves where picking_id = ${res.confirm_purchase_order}`
      assert.equal(moves.length, 1)
    })
  })

  test('Wareneingang füllt die erhaltene Menge', async () => {
    await withRollback(async (t) => {
      const s = await purchaseScenario(t)
      const [res] = await t<{ confirm_purchase_order: string }[]>`
        select confirm_purchase_order(${s.orderId})`
      await t`select picking_validate(${res.confirm_purchase_order})`

      const [line] = await t<{ qty_received: number }[]>`
        select qty_received from purchase_order_lines where id = ${s.lineId}`
      assert.equal(Number(line.qty_received), 100)
      assert.equal(await onHand(t, s.variantId), 100)

      const [po] = await t<{ billing_status: string }[]>`
        select billing_status from purchase_orders where id = ${s.orderId}`
      assert.equal(po.billing_status, 'waiting', 'jetzt abrechenbar')
      await assertLedgerConsistent(t)
    })
  })

  test('Teillieferung erzeugt einen Rückstand und zählt korrekt', async () => {
    await withRollback(async (t) => {
      const s = await purchaseScenario(t)
      const [res] = await t<{ confirm_purchase_order: string }[]>`
        select confirm_purchase_order(${s.orderId})`
      const [move] = await t<{ id: string }[]>`
        select id from stock_moves where picking_id = ${res.confirm_purchase_order}`

      const [bo] = await t<{ picking_validate: string }[]>`
        select picking_validate(${res.confirm_purchase_order}, ${t.json({ [move.id]: 60 })}, true)`

      const [line] = await t<{ qty_received: number }[]>`
        select qty_received from purchase_order_lines where id = ${s.lineId}`
      assert.equal(Number(line.qty_received), 60)
      assert.equal(await onHand(t, s.variantId), 60)

      // Rückstand nachliefern
      await t`select picking_validate(${bo.picking_validate})`
      const [after] = await t<{ qty_received: number }[]>`
        select qty_received from purchase_order_lines where id = ${s.lineId}`
      assert.equal(Number(after.qty_received), 100)
      await assertLedgerConsistent(t)
    })
  })

  test('Einkaufseinheit wird in die Lagereinheit umgerechnet', async () => {
    await withRollback(async (t) => {
      const uom = await uomStueck(t)
      const [dutzend] = await t<{ id: string }[]>`select id from uoms where name = 'Dutzend'`
      const [vendor] = await t<{ id: string }[]>`
        insert into partners (name, is_vendor) values ('Kabelwerk', true) returning id`
      const [tpl] = await t<{ id: string }[]>`
        insert into product_templates (name, uom_id, purchase_uom_id, can_be_purchased)
        values ('Kabel', ${uom}, ${dutzend.id}, true) returning id`
      await t`select generate_variants(${tpl.id})`
      const [variant] = await t<{ id: string }[]>`
        select id from product_variants where template_id = ${tpl.id} limit 1`

      const [order] = await t<{ id: string }[]>`
        insert into purchase_orders (number, vendor_id)
        values (next_sequence('purchase'), ${vendor.id}) returning id`
      await t`insert into purchase_order_lines (order_id, variant_id, name, qty, uom_id, price_unit)
              values (${order.id}, ${variant.id}, 'Kabel', 2, ${dutzend.id}, 6)`

      const [res] = await t<{ confirm_purchase_order: string }[]>`
        select confirm_purchase_order(${order.id})`
      await t`select picking_validate(${res.confirm_purchase_order})`

      assert.equal(await onHand(t, variant.id), 24, '2 Dutzend = 24 Stück im Lager')

      const [line] = await t<{ qty_received: number }[]>`
        select qty_received from purchase_order_lines where order_id = ${order.id}`
      assert.equal(Number(line.qty_received), 2, 'erhaltene Menge in der Einkaufseinheit')
      await assertLedgerConsistent(t)
    })
  })

  test('Sperren verhindert Änderungen, Entsperren gibt sie frei', async () => {
    await withRollback(async (t) => {
      const s = await purchaseScenario(t)
      await t`select confirm_purchase_order(${s.orderId})`
      await t`select purchase_order_lock(${s.orderId})`

      const [locked] = await t<{ state: string }[]>`
        select state from purchase_orders where id = ${s.orderId}`
      assert.equal(locked.state, 'done', 'Odoo nutzt done als Gesperrt-Status')

      await expectError(
        t,
        (sp) => sp`select purchase_order_guard_editable(${s.orderId})`,
        /gesperrt/,
      )

      await t`select purchase_order_unlock(${s.orderId})`
      await t`select purchase_order_guard_editable(${s.orderId})`
    })
  })

  test('Storno nach Wareneingang wird abgelehnt', async () => {
    await withRollback(async (t) => {
      const s = await purchaseScenario(t)
      const [res] = await t<{ confirm_purchase_order: string }[]>`
        select confirm_purchase_order(${s.orderId})`
      await t`select picking_validate(${res.confirm_purchase_order})`

      await expectError(t, (sp) => sp`select cancel_purchase_order(${s.orderId})`, /Retoure/)
    })
  })

  test('Storno vor Wareneingang bricht den Eingang ab', async () => {
    await withRollback(async (t) => {
      const s = await purchaseScenario(t)
      const [res] = await t<{ confirm_purchase_order: string }[]>`
        select confirm_purchase_order(${s.orderId})`
      await t`select cancel_purchase_order(${s.orderId}, 'tester')`

      const [po] = await t<{ state: string }[]>`select state from purchase_orders where id = ${s.orderId}`
      assert.equal(po.state, 'cancel')
      const [pick] = await t<{ state: string }[]>`
        select state from stock_pickings where id = ${res.confirm_purchase_order}`
      assert.equal(pick.state, 'cancel')
    })
  })
})

describe('Einkauf: Lieferantenrechnungen', () => {
  test('Politik "nach erhaltener Menge" blockt die Rechnung vor dem Eingang', async () => {
    await withRollback(async (t) => {
      const s = await purchaseScenario(t, { billPolicy: 'received' })
      await t`select confirm_purchase_order(${s.orderId})`

      await expectError(t, (sp) => sp`select create_vendor_bill(${s.orderId})`, /Nichts abzurechnen/)
    })
  })

  test('Politik "nach bestellter Menge" erlaubt die Rechnung sofort', async () => {
    await withRollback(async (t) => {
      const s = await purchaseScenario(t, { billPolicy: 'ordered' })
      await t`select confirm_purchase_order(${s.orderId})`

      const [bill] = await t<{ create_vendor_bill: string }[]>`
        select create_vendor_bill(${s.orderId})`
      const [line] = await t<{ qty: number }[]>`
        select qty from vendor_bill_lines where bill_id = ${bill.create_vendor_bill}`
      assert.equal(Number(line.qty), 100, 'volle bestellte Menge')
    })
  })

  test('Rechnung über die Teilmenge, buchen und bezahlen', async () => {
    await withRollback(async (t) => {
      const s = await purchaseScenario(t, { billPolicy: 'received' })
      const [res] = await t<{ confirm_purchase_order: string }[]>`
        select confirm_purchase_order(${s.orderId})`
      const [move] = await t<{ id: string }[]>`
        select id from stock_moves where picking_id = ${res.confirm_purchase_order}`
      await t`select picking_validate(${res.confirm_purchase_order}, ${t.json({ [move.id]: 60 })}, true)`

      const [bill] = await t<{ create_vendor_bill: string }[]>`select create_vendor_bill(${s.orderId})`
      const billId = bill.create_vendor_bill

      const [bl] = await t<{ qty: number }[]>`select qty from vendor_bill_lines where bill_id = ${billId}`
      assert.equal(Number(bl.qty), 60, 'nur die erhaltene Menge')

      await t`update vendor_bills set bill_date = current_date where id = ${billId}`
      await t`select post_vendor_bill(${billId}, 'tester')`

      const [line] = await t<{ qty_billed: number }[]>`
        select qty_billed from purchase_order_lines where id = ${s.lineId}`
      assert.equal(Number(line.qty_billed), 60)

      const [po] = await t<{ billing_status: string }[]>`
        select billing_status from purchase_orders where id = ${s.orderId}`
      assert.equal(po.billing_status, 'fully_billed', 'erhaltene Menge ist voll berechnet')

      await t`select pay_vendor_bill(${billId})`
      const [paid] = await t<{ state: string }[]>`select state from vendor_bills where id = ${billId}`
      assert.equal(paid.state, 'paid')
    })
  })

  test('Rechnung ohne Datum lässt sich nicht buchen', async () => {
    await withRollback(async (t) => {
      const s = await purchaseScenario(t, { billPolicy: 'ordered' })
      await t`select confirm_purchase_order(${s.orderId})`
      const [bill] = await t<{ create_vendor_bill: string }[]>`select create_vendor_bill(${s.orderId})`

      await expectError(
        t,
        (sp) => sp`select post_vendor_bill(${bill.create_vendor_bill})`,
        /Rechnungsdatum/,
      )
    })
  })

  test('Gutschrift nimmt die abgerechnete Menge zurück', async () => {
    await withRollback(async (t) => {
      const s = await purchaseScenario(t, { billPolicy: 'ordered' })
      await t`select confirm_purchase_order(${s.orderId})`
      const [bill] = await t<{ create_vendor_bill: string }[]>`select create_vendor_bill(${s.orderId})`
      await t`update vendor_bills set bill_date = current_date where id = ${bill.create_vendor_bill}`
      await t`select post_vendor_bill(${bill.create_vendor_bill})`

      const [credit] = await t<{ cancel_vendor_bill: string }[]>`
        select cancel_vendor_bill(${bill.create_vendor_bill}, 'tester')`
      await t`update vendor_bills set bill_date = current_date where id = ${credit.cancel_vendor_bill}`
      await t`select post_vendor_bill(${credit.cancel_vendor_bill})`

      const [line] = await t<{ qty_billed: number }[]>`
        select qty_billed from purchase_order_lines where id = ${s.lineId}`
      assert.equal(Number(line.qty_billed), 0, 'Gutschrift gleicht die Rechnung aus')

      const [po] = await t<{ billing_status: string }[]>`
        select billing_status from purchase_orders where id = ${s.orderId}`
      assert.equal(po.billing_status, 'waiting', 'wieder abzurechnen')
    })
  })
})
