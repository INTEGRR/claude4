import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { TransactionSql } from 'postgres'
import { closeDb, makeProduct, stockUp, uomStueck, withRollback } from './helpers.ts'

after(closeDb)

/** Kunde + Auftrag mit einer Position für ein lagergeführtes Produkt. */
async function saleScenario(
  t: TransactionSql,
  opts: { qty?: number; invoicePolicy?: 'order' | 'delivery' } = {},
) {
  const uom = await uomStueck(t)
  const [customer] = await t<{ id: string }[]>`
    insert into partners (name, is_customer) values ('Beleg-Kunde', true) returning id`
  const variantId = await makeProduct(t, `Belegprodukt ${Math.random().toString(36).slice(2, 7)}`)
  await t`update product_templates pt set can_be_sold = true,
            invoice_policy = ${opts.invoicePolicy ?? 'order'}::invoice_policy
          from product_variants pv
          where pv.template_id = pt.id and pv.id = ${variantId}`
  await stockUp(t, variantId, 50)

  const [order] = await t<{ id: string }[]>`
    insert into sales_orders (number, partner_id) values (next_sequence('sale'), ${customer.id})
    returning id`
  const [line] = await t<{ id: string }[]>`
    insert into sales_order_lines (order_id, variant_id, name, qty, uom_id, price_unit)
    values (${order.id}, ${variantId}, 'Belegprodukt', ${opts.qty ?? 2}, ${uom}, 100)
    returning id`
  return { orderId: order.id, lineId: line.id, variantId, customerId: customer.id, uom }
}

describe('Beleg-Vervollständigung (0013/0014)', () => {
  test('Lieferstatus "started": reserviert, aber noch nichts geliefert', async () => {
    await withRollback(async (t) => {
      const s = await saleScenario(t)
      await t`select confirm_sales_order(${s.orderId})`
      const [so] = await t<{ delivery_status: string }[]>`
        select delivery_status from sales_orders where id = ${s.orderId}`
      assert.equal(so.delivery_status, 'started', 'Lager hat reserviert => started')
    })
  })

  test('Abrechnungsstatus "upselling": mehr geliefert als bestellt', async () => {
    await withRollback(async (t) => {
      const s = await saleScenario(t, { qty: 1, invoicePolicy: 'delivery' })
      await t`select confirm_sales_order(${s.orderId})`
      // Überlieferung simulieren: 2 geliefert, Bestellmenge 1 bereits berechnet.
      await t`update sales_order_lines set qty_delivered = 2, qty_invoiced = 1
              where id = ${s.lineId}`
      await t`select sales_order_recompute_status(${s.orderId})`

      const [line] = await t<{ invoice_status: string; qty_to_invoice: number }[]>`
        select invoice_status, qty_to_invoice from sales_order_lines where id = ${s.lineId}`
      assert.equal(line.invoice_status, 'upselling')
      assert.equal(Number(line.qty_to_invoice), 1, 'die Mehrlieferung ist noch abzurechnen')

      const [so] = await t<{ invoice_status: string }[]>`
        select invoice_status from sales_orders where id = ${s.orderId}`
      assert.equal(so.invoice_status, 'upselling')
    })
  })

  test('Steuer-Schnappschuss: Zeilensatz kommt beim Bestätigen vom Produkt', async () => {
    await withRollback(async (t) => {
      const s = await saleScenario(t)
      const [steuer] = await t<{ id: string }[]>`
        insert into taxes (name, amount, type_tax_use) values ('7 % Testsatz', 7, 'sale')
        returning id`
      await t`update product_templates pt set sale_tax_id = ${steuer.id}
              from product_variants pv
              where pv.template_id = pt.id and pv.id = ${s.variantId}`
      await t`select confirm_sales_order(${s.orderId})`

      const [line] = await t<{ tax_rate: number; tax_id: string }[]>`
        select tax_rate, tax_id from sales_order_lines where id = ${s.lineId}`
      assert.equal(Number(line.tax_rate), 7)
      assert.equal(line.tax_id, steuer.id)
    })
  })

  test('Kit-Stückliste: die Komponenten werden geliefert, nicht das Set', async () => {
    await withRollback(async (t) => {
      const uom = await uomStueck(t)
      const kabel = await makeProduct(t, 'Kit-Kabel')
      const tuch = await makeProduct(t, 'Kit-Tuch')
      await stockUp(t, kabel, 20)
      await stockUp(t, tuch, 20)

      const setVariant = await makeProduct(t, 'Zubehör-Set')
      const [setTpl] = await t<{ template_id: string }[]>`
        select template_id from product_variants where id = ${setVariant}`
      const [kitBom] = await t<{ id: string }[]>`
        insert into boms (template_id, qty, uom_id, bom_type)
        values (${setTpl.template_id}, 1, ${uom}, 'kit') returning id`
      await t`insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
              values (${kitBom.id}, 10, ${kabel}, 1, ${uom}),
                     (${kitBom.id}, 20, ${tuch}, 2, ${uom})`

      const [customer] = await t<{ id: string }[]>`
        insert into partners (name, is_customer) values ('Kit-Kunde', true) returning id`
      const [order] = await t<{ id: string }[]>`
        insert into sales_orders (number, partner_id) values (next_sequence('sale'), ${customer.id})
        returning id`
      await t`insert into sales_order_lines (order_id, variant_id, name, qty, uom_id, price_unit)
              values (${order.id}, ${setVariant}, 'Zubehör-Set', 3, ${uom}, 29)`

      const [res] = await t<{ confirm_sales_order: string }[]>`
        select confirm_sales_order(${order.id})`

      const moves = await t<{ variant_id: string; qty: number }[]>`
        select variant_id, qty from stock_moves where picking_id = ${res.confirm_sales_order}`
      assert.equal(moves.length, 2, 'zwei Komponenten-Positionen')
      assert.ok(!moves.some((m) => m.variant_id === setVariant), 'das Set selbst wird nicht bewegt')
      assert.equal(Number(moves.find((m) => m.variant_id === kabel)!.qty), 3)
      assert.equal(Number(moves.find((m) => m.variant_id === tuch)!.qty), 6, '2 je Set × 3 Sets')
    })
  })

  test('3-Way-Matching: no → yes → exception', async () => {
    await withRollback(async (t) => {
      const uom = await uomStueck(t)
      const variantId = await makeProduct(t, '3Way-Teil')
      await t`update product_templates pt set can_be_purchased = true, bill_policy = 'ordered'
              from product_variants pv where pv.template_id = pt.id and pv.id = ${variantId}`
      const [vendor] = await t<{ id: string }[]>`
        insert into partners (name, is_vendor) values ('3Way GmbH', true) returning id`
      const [po] = await t<{ id: string }[]>`
        insert into purchase_orders (number, vendor_id)
        values (next_sequence('purchase'), ${vendor.id}) returning id`
      await t`insert into purchase_order_lines (order_id, variant_id, name, qty, uom_id, price_unit)
              values (${po.id}, ${variantId}, '3Way-Teil', 10, ${uom}, 2)`
      const [receipt] = await t<{ confirm_purchase_order: string }[]>`
        select confirm_purchase_order(${po.id})`

      // Politik "ordered": Rechnung sofort möglich — aber noch nichts erhalten.
      const [bill] = await t<{ create_vendor_bill: string }[]>`
        select create_vendor_bill(${po.id})`
      const [m1] = await t<{ s: string }[]>`
        select vendor_bill_match_state(${bill.create_vendor_bill}) as s`
      assert.equal(m1.s, 'no', 'kein Wareneingang => no')

      // Teilmenge einbuchen: 4 von 10 → mehr berechnet als erhalten.
      const [move] = await t<{ id: string }[]>`
        select id from stock_moves where picking_id = ${receipt.confirm_purchase_order}`
      await t`select picking_validate(${receipt.confirm_purchase_order},
        ${t.json({ [move.id]: 4 })}, false)`
      const [m2] = await t<{ s: string }[]>`
        select vendor_bill_match_state(${bill.create_vendor_bill}) as s`
      assert.equal(m2.s, 'exception', 'Teillieferung deckt die Rechnung nicht')
    })
  })

  test('Buchen setzt die Fälligkeit aus der Zahlungsbedingung', async () => {
    await withRollback(async (t) => {
      const uom = await uomStueck(t)
      const variantId = await makeProduct(t, 'Fällig-Teil')
      await t`update product_templates pt set can_be_purchased = true, bill_policy = 'ordered'
              from product_variants pv where pv.template_id = pt.id and pv.id = ${variantId}`
      const [term] = await t<{ id: string }[]>`
        select id from payment_terms where nb_days = 30 and delay_type = 'days_after' limit 1`
      const [vendor] = await t<{ id: string }[]>`
        insert into partners (name, is_vendor, supplier_payment_term_id)
        values ('Fällig GmbH', true, ${term.id}) returning id`
      const [po] = await t<{ id: string }[]>`
        insert into purchase_orders (number, vendor_id)
        values (next_sequence('purchase'), ${vendor.id}) returning id`
      await t`insert into purchase_order_lines (order_id, variant_id, name, qty, uom_id, price_unit)
              values (${po.id}, ${variantId}, 'Fällig-Teil', 1, ${uom}, 10)`
      await t`select confirm_purchase_order(${po.id})`

      const [bill] = await t<{ create_vendor_bill: string }[]>`
        select create_vendor_bill(${po.id})`
      await t`update vendor_bills set bill_date = '2026-08-07' where id = ${bill.create_vendor_bill}`
      await t`select post_vendor_bill(${bill.create_vendor_bill})`

      const [row] = await t<{ due_date: string; payment_term_id: string }[]>`
        select due_date::text as due_date, payment_term_id
        from vendor_bills where id = ${bill.create_vendor_bill}`
      assert.equal(row.payment_term_id, term.id, 'Zahlungsbedingung vom Lieferanten übernommen')
      assert.equal(row.due_date, '2026-09-06', '30 Tage nach Rechnungsdatum')
    })
  })
})
