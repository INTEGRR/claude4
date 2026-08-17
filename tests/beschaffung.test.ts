import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { TransactionSql } from 'postgres'
import { closeDb, makeProduct, stockUp, withRollback } from './helpers.ts'

after(closeDb)

async function orderpointScenario(t: TransactionSql, opts: { route?: string } = {}) {
  const variantId = await makeProduct(t, `Meldeteil ${Math.random().toString(36).slice(2, 7)}`)
  await t`update product_templates pt
          set can_be_purchased = true, route_buy = true,
              route_manufacture = ${opts.route === 'manufacture'}
          from product_variants pv
          where pv.template_id = pt.id and pv.id = ${variantId}`
  await stockUp(t, variantId, 40)

  const [vendor] = await t<{ id: string }[]>`
    insert into partners (name, is_vendor) values ('Melde GmbH', true) returning id`
  await t`insert into vendor_prices (vendor_id, template_id, price, discount)
          select ${vendor.id}, pv.template_id, 2.00, 10
          from product_variants pv where pv.id = ${variantId}`

  const [loc] = await t<{ id: string }[]>`
    select id from stock_locations where full_path = 'WH/Stock'`
  const [op] = await t<{ id: string }[]>`
    insert into stock_orderpoints (variant_id, location_id, min_qty, max_qty, qty_multiple, route)
    values (${variantId}, ${loc.id}, 50, 200, 25, ${opts.route ?? null})
    returning id`
  return { variantId, vendorId: vendor.id, orderpointId: op.id }
}

describe('Meldebestände (0015)', () => {
  test('Vorschlag: bis Max auffüllen, aufgerundet aufs Vielfache', async () => {
    await withRollback(async (t) => {
      const s = await orderpointScenario(t)
      const [v] = await t<
        { qty_forecast: number; qty_to_order: number; route: string; unit_price: number }[]
      >`select qty_forecast, qty_to_order, route, unit_price
        from orderpoint_suggestions() where orderpoint_id = ${s.orderpointId}`
      assert.equal(Number(v.qty_forecast), 40, 'Prognose = Bestand')
      // Bedarf 160 → auf Vielfaches 25 aufgerundet = 175
      assert.equal(Number(v.qty_to_order), 175)
      assert.equal(v.route, 'buy')
      assert.equal(Number(v.unit_price), 1.8, '2,00 € mit 10 % Lieferantenrabatt')
    })
  })

  test('kein Vorschlag über dem Mindestbestand oder im Schlummer', async () => {
    await withRollback(async (t) => {
      const s = await orderpointScenario(t)
      await t`update stock_orderpoints set min_qty = 10, max_qty = 20
              where id = ${s.orderpointId}`
      let rows = await t`select 1 from orderpoint_suggestions()
                         where orderpoint_id = ${s.orderpointId}`
      assert.equal(rows.length, 0, 'Prognose 40 > Min 10 => kein Bedarf')

      await t`update stock_orderpoints set min_qty = 50, max_qty = 200,
                snoozed_until = current_date + 7
              where id = ${s.orderpointId}`
      rows = await t`select 1 from orderpoint_suggestions()
                     where orderpoint_id = ${s.orderpointId}`
      assert.equal(rows.length, 0, 'schlummernde Regel schlägt nichts vor')
    })
  })

  test('Ausführung (buy): Entwurfs-Bestellung, Folgeaufruf merged hinein', async () => {
    await withRollback(async (t) => {
      const s = await orderpointScenario(t)
      const [erste] = await t<{ orderpoint_execute: string }[]>`
        select orderpoint_execute(${s.orderpointId}, 'test')`

      const [po] = await t<{ id: string; state: string; lines: number }[]>`
        select po.id, po.state,
               (select count(*) from purchase_order_lines l where l.order_id = po.id)::int as lines
        from purchase_orders po where po.number = ${erste.orderpoint_execute}`
      assert.equal(po.state, 'draft')
      assert.equal(po.lines, 1)

      // Zweite Regel für denselben Lieferanten → landet in derselben Bestellung.
      const zweiteVariante = await makeProduct(t, 'Meldeteil B')
      await t`update product_templates pt set can_be_purchased = true, route_buy = true
              from product_variants pv where pv.template_id = pt.id and pv.id = ${zweiteVariante}`
      await t`insert into vendor_prices (vendor_id, template_id, price)
              select ${s.vendorId}, pv.template_id, 5 from product_variants pv
              where pv.id = ${zweiteVariante}`
      const [loc] = await t<{ id: string }[]>`
        select id from stock_locations where full_path = 'WH/Stock'`
      const [op2] = await t<{ id: string }[]>`
        insert into stock_orderpoints (variant_id, location_id, min_qty, max_qty)
        values (${zweiteVariante}, ${loc.id}, 10, 30) returning id`

      const [zweite] = await t<{ orderpoint_execute: string }[]>`
        select orderpoint_execute(${op2.id}, 'test')`
      assert.equal(zweite.orderpoint_execute, erste.orderpoint_execute, 'gleiche Bestellung')
      const [nachher] = await t<{ lines: number }[]>`
        select count(*)::int as lines from purchase_order_lines where order_id = ${po.id}`
      assert.equal(nachher.lines, 2)
    })
  })

  // BUG/00005: Entwurfs-Bestellungen und laufende Fertigungsaufträge zählen
  // als Zulauf — der ausgeführte Vorschlag darf nicht erneut angeboten werden.
  test('nach dem Bestellen verschwindet der Vorschlag; Storno bringt ihn zurück', async () => {
    await withRollback(async (t) => {
      const s = await orderpointScenario(t)
      const [erste] = await t<{ orderpoint_execute: string }[]>`
        select orderpoint_execute(${s.orderpointId}, 'test')`

      let rows = await t`select 1 from orderpoint_suggestions()
                         where orderpoint_id = ${s.orderpointId}`
      assert.equal(rows.length, 0, 'Entwurfs-Bestellung ist Zulauf — kein Vorschlag mehr')

      // Im Savepoint, damit der erwartete Fehler die Testtransaktion nicht abbricht.
      await assert.rejects(
        t.savepoint(async (sp) => {
          await sp`select orderpoint_execute(${s.orderpointId}, 'test')`
        }),
        /Kein offener Beschaffungsvorschlag/,
        'zweiter Klick bestellt nicht erneut',
      )

      // Bestellung stornieren, ohne dass Ware kam → der Bedarf lebt wieder auf.
      const [po] = await t<{ id: string }[]>`
        select id from purchase_orders where number = ${erste.orderpoint_execute}`
      await t`select cancel_purchase_order(${po.id}, 'test')`
      rows = await t`select 1 from orderpoint_suggestions()
                     where orderpoint_id = ${s.orderpointId}`
      assert.equal(rows.length, 1, 'stornierte Bestellung ist kein Zulauf mehr')
    })
  })

  test('laufender Fertigungsauftrag unterdrückt den Fertigen-Vorschlag', async () => {
    await withRollback(async (t) => {
      const s = await orderpointScenario(t, { route: 'manufacture' })
      const komponente = await makeProduct(t, 'Melde-Komponente Z')
      const [uom] = await t<{ uom_id: string }[]>`
        select uom_id from product_templates pt
        join product_variants pv on pv.template_id = pt.id where pv.id = ${s.variantId}`
      const [bom] = await t<{ id: string }[]>`
        insert into boms (template_id, qty, uom_id)
        select pv.template_id, 1, ${uom.uom_id} from product_variants pv
        where pv.id = ${s.variantId} returning id`
      await t`insert into bom_lines (bom_id, component_variant_id, qty, uom_id)
              values (${bom.id}, ${komponente}, 2, ${uom.uom_id})`

      await t`select orderpoint_execute(${s.orderpointId}, 'test')`
      const rows = await t`select 1 from orderpoint_suggestions()
                           where orderpoint_id = ${s.orderpointId}`
      assert.equal(rows.length, 0, 'bestätigter MO deckt den Bedarf — kein Vorschlag mehr')
    })
  })

  // BUG/00006: MOQ und Preisstaffeln aus vendor_prices fließen in Vorschlag
  // und Ausführung — angehoben wird die EMPFEHLUNG, entschieden der Benutzer.
  test('MOQ: Empfehlung wird angehoben, Bestellen darunter scheitert', async () => {
    await withRollback(async (t) => {
      const s = await orderpointScenario(t)
      await t`update vendor_prices set min_qty = 500 where vendor_id = ${s.vendorId}`

      const [v] = await t<
        { qty_to_order: number; moq: number; qty_empfohlen: number; unit_price: number }[]
      >`select qty_to_order, moq, qty_empfohlen, unit_price
        from orderpoint_suggestions() where orderpoint_id = ${s.orderpointId}`
      assert.equal(Number(v.qty_to_order), 175, 'berechneter Bedarf bleibt sichtbar')
      assert.equal(Number(v.moq), 500)
      assert.equal(Number(v.qty_empfohlen), 500, 'Empfehlung auf MOQ angehoben')
      assert.equal(Number(v.unit_price), 1.8, 'Preis der Staffel ab 500')

      await assert.rejects(
        t.savepoint(async (sp) => {
          await sp`select orderpoint_execute(${s.orderpointId}, 'test', 175)`
        }),
        /Mindestbestellmenge/,
        'unter MOQ wird nicht bestellt',
      )

      // Ohne Wunschmenge gilt die Empfehlung (500).
      const [nummer] = await t<{ orderpoint_execute: string }[]>`
        select orderpoint_execute(${s.orderpointId}, 'test')`
      const [zeile] = await t<{ qty: number }[]>`
        select l.qty from purchase_order_lines l
        join purchase_orders po on po.id = l.order_id
        where po.number = ${nummer.orderpoint_execute}`
      assert.equal(Number(zeile.qty), 500)
    })
  })

  test('Staffelpreise: Wunschmenge zieht den Preis ihrer Staffel', async () => {
    await withRollback(async (t) => {
      const s = await orderpointScenario(t)
      // Zweite Staffel: ab 1000 Stück 1,50 € ohne Rabatt.
      await t`insert into vendor_prices (vendor_id, template_id, price, min_qty)
              select ${s.vendorId}, pv.template_id, 1.50, 1000
              from product_variants pv where pv.id = ${s.variantId}`

      const staffeln = await t<{ min_qty: number; netto: number }[]>`
        select min_qty, netto from vendor_staffeln(${s.variantId}, ${s.vendorId})`
      assert.deepEqual(
        staffeln.map((r) => [Number(r.min_qty), Number(r.netto)]),
        [[0, 1.8], [1000, 1.5]],
      )

      const [nummer] = await t<{ orderpoint_execute: string }[]>`
        select orderpoint_execute(${s.orderpointId}, 'test', 1000)`
      const [zeile] = await t<{ qty: number; price_unit: number }[]>`
        select l.qty, l.price_unit from purchase_order_lines l
        join purchase_orders po on po.id = l.order_id
        where po.number = ${nummer.orderpoint_execute}`
      assert.equal(Number(zeile.qty), 1000)
      assert.equal(Number(zeile.price_unit), 1.5, 'Preis aus der 1000er-Staffel')
    })
  })

  test('Ausführung (manufacture): bestätigter Fertigungsauftrag mit Herkunft', async () => {
    await withRollback(async (t) => {
      const s = await orderpointScenario(t, { route: 'manufacture' })
      // Stückliste, damit der Fertigungsauftrag entstehen kann.
      const komponente = await makeProduct(t, 'Melde-Komponente')
      const [uom] = await t<{ uom_id: string }[]>`
        select uom_id from product_templates pt
        join product_variants pv on pv.template_id = pt.id where pv.id = ${s.variantId}`
      const [bom] = await t<{ id: string }[]>`
        insert into boms (template_id, qty, uom_id)
        select pv.template_id, 1, ${uom.uom_id} from product_variants pv
        where pv.id = ${s.variantId} returning id`
      await t`insert into bom_lines (bom_id, component_variant_id, qty, uom_id)
              values (${bom.id}, ${komponente}, 2, ${uom.uom_id})`

      const [nummer] = await t<{ orderpoint_execute: string }[]>`
        select orderpoint_execute(${s.orderpointId}, 'test')`
      const [mo] = await t<{ state: string; origin: string; orderpoint_id: string; qty: number }[]>`
        select state, origin, orderpoint_id, qty_to_produce as qty
        from manufacturing_orders where number = ${nummer.orderpoint_execute}`
      assert.equal(mo.state, 'confirmed')
      assert.equal(mo.orderpoint_id, s.orderpointId)
      assert.match(mo.origin, /Meldebestand/)
      assert.equal(Number(mo.qty), 175)
    })
  })
})
