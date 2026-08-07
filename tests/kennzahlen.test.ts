import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { TransactionSql } from 'postgres'
import {
  closeDb,
  locationId,
  makeProduct,
  stockUp,
  uomStueck,
  withRollback,
} from './helpers.ts'

after(closeDb)

/**
 * Kennzahlen. Die materialisierten Sichten lassen sich in einer Transaktion
 * nicht neu berechnen (REFRESH sperrt und sieht ohnehin nur festgeschriebene
 * Daten), deshalb prüfen die Tests die Rechenvorschrift direkt gegen dieselbe
 * Abfrage — und zusätzlich, dass die Sichten selbst benutzbar sind.
 */
let counter = 0

/** Kunde, Produkt, Bestand, bestätigter Auftrag und gebuchte Lieferung. */
async function verkaufMitLieferung(
  t: TransactionSql,
  opts: { einstand: number; preis: number; menge: number; retoure?: number },
) {
  const n = ++counter
  const uom = await uomStueck(t)
  const variant = await makeProduct(t, `KZ-Produkt ${n}`)
  await t`update product_templates set standard_cost = ${opts.einstand}, can_be_sold = true
          where id = (select template_id from product_variants where id = ${variant})`
  await stockUp(t, variant, opts.menge + (opts.retoure ?? 0) + 10)
  await t`select valuation_initialize(${variant}, 'test')`

  const [kunde] = await t<{ id: string }[]>`
    insert into partners (name, is_customer) values (${`Kunde ${n}`}, true) returning id`
  const [order] = await t<{ id: string }[]>`
    insert into sales_orders (number, partner_id) values (next_sequence('sale'), ${kunde.id})
    returning id`
  await t`
    insert into sales_order_lines (order_id, variant_id, name, qty, uom_id, price_unit)
    values (${order.id}, ${variant}, 'Position', ${opts.menge}, ${uom}, ${opts.preis})`

  const [picking] = await t<{ confirm_sales_order: string }[]>`
    select confirm_sales_order(${order.id}, 'test')`
  await t`select picking_validate(${picking.confirm_sales_order}, '{}'::jsonb, false)`

  return { variant, order: order.id, picking: picking.confirm_sales_order, uom, kunde: kunde.id }
}

/** Rechenvorschrift des Deckungsbeitrags — identisch zu mv_contribution_margin. */
const MARGE_SQL = (t: TransactionSql, variant: string) => t<
  { qty: number; revenue: number; cost: number }[]
>`
  select sum(bewegung.vorzeichen * m.qty_done) as qty,
         sum(round(bewegung.vorzeichen * m.qty_done
                   * coalesce(zeile.price_unit, 0)
                   * (1 - coalesce(zeile.discount, 0) / 100.0), 4)) as revenue,
         sum(coalesce(-wert.value, 0)) as cost
  from stock_moves m
  join stock_pickings p on p.id = m.picking_id and p.origin_model = 'sales_order'
  join lateral (
    select case
             when (select type from stock_locations where id = m.dest_location_id) = 'customer' then 1
             when (select type from stock_locations where id = m.src_location_id) = 'customer' then -1
           end as vorzeichen
  ) bewegung on bewegung.vorzeichen is not null
  left join lateral (
    select l.price_unit, l.discount from sales_order_lines l
    where l.order_id = p.origin_id and l.variant_id = m.variant_id
    order by l.sequence limit 1) zeile on true
  left join lateral (
    select sum(v.value) as value from stock_valuation_layers v where v.move_id = m.id) wert on true
  where m.state = 'done' and m.variant_id = ${variant}`

describe('Deckungsbeitrag', () => {
  test('Umsatz minus tatsächlicher Wareneinsatz', async () => {
    await withRollback(async (t) => {
      const s = await verkaufMitLieferung(t, { einstand: 30, preis: 100, menge: 4 })
      const [row] = await MARGE_SQL(t, s.variant)

      assert.equal(Number(row.qty), 4)
      assert.equal(Number(row.revenue), 400, '4 × 100 €')
      assert.equal(Number(row.cost), 120, '4 × 30 € Einstand aus der Wertschicht')
    })
  })

  test('Rabatte mindern den Umsatz', async () => {
    await withRollback(async (t) => {
      const s = await verkaufMitLieferung(t, { einstand: 30, preis: 100, menge: 2 })
      // Rabatt nachträglich setzen und die Marge neu rechnen
      await t`update sales_order_lines set discount = 25 where order_id = ${s.order}`
      const [row] = await MARGE_SQL(t, s.variant)
      assert.equal(Number(row.revenue), 150, '2 × 100 € abzüglich 25 %')
    })
  })

  test('eine Retoure dreht Umsatz und Wareneinsatz zurück', async () => {
    await withRollback(async (t) => {
      const s = await verkaufMitLieferung(t, { einstand: 30, preis: 100, menge: 5 })

      const [retoure] = await t<{ picking_return: string }[]>`
        select picking_return(${s.picking})`
      // Nur 2 von 5 kommen zurück
      const [move] = await t<{ id: string }[]>`
        select id from stock_moves where picking_id = ${retoure.picking_return}`
      await t`select picking_validate(${retoure.picking_return},
                ${t.json({ [move.id]: 2 })}, false)`

      const [row] = await MARGE_SQL(t, s.variant)
      assert.equal(Number(row.qty), 3, '5 geliefert, 2 zurück')
      assert.equal(Number(row.revenue), 300, 'Umsatz nur für die behaltenen 3')
      assert.equal(Number(row.cost), 90, 'Wareneinsatz ebenso')
    })
  })
})

describe('Lieferantentreue', () => {
  test('pünktlich, verspätet und offen werden unterschieden', async () => {
    await withRollback(async (t) => {
      const n = ++counter
      const uom = await uomStueck(t)
      const [vendor] = await t<{ id: string }[]>`
        insert into partners (name, is_vendor) values (${`Lieferant ${n}`}, true) returning id`
      const teil = await makeProduct(t, `Kauf-Teil ${n}`)

      const [po] = await t<{ id: string }[]>`
        insert into purchase_orders (number, vendor_id, state, confirmed_at)
        values (next_sequence('purchase'), ${vendor.id}, 'purchase', now()) returning id`
      await t`
        insert into purchase_order_lines (order_id, variant_id, name, qty, uom_id, price_unit,
                                          date_planned, qty_received)
        values (${po.id}, ${teil}, 'Teil', 10, ${uom}, 5, current_date + 7, 10),
               (${po.id}, ${teil}, 'Teil', 5, ${uom}, 5, current_date - 3, 0)`

      // Wareneingang für die erste Zeile: heute, also vor dem Soll-Termin
      const [opType] = await t<{ id: string }[]>`
        select id from operation_types where kind = 'receipt' limit 1`
      const stock = await locationId(t, 'WH/Stock')
      const [picking] = await t<{ id: string }[]>`
        insert into stock_pickings (number, operation_type_id, state, partner_id,
                                    origin_model, origin_id)
        values (next_sequence('receipt'), ${opType.id}, 'done', ${vendor.id},
                'purchase_order', ${po.id})
        returning id`
      const [vendorLoc] = await t<{ id: string }[]>`
        select id from stock_locations where type = 'vendor' limit 1`
      await t`
        insert into stock_moves (picking_id, variant_id, uom_id, qty, qty_done,
                                 src_location_id, dest_location_id, state, date_done)
        values (${picking.id}, ${teil}, ${uom}, 10, 10, ${vendorLoc.id}, ${stock},
                'done', now())`

      const rows = await t<
        { lines: number; delivered: number; on_time: number; overdue: number }[]
      >`
        with zeilen as (
          select pol.id,
                 pol.date_planned::date as soll,
                 (select min(m.date_done)::date from stock_moves m
                  join stock_pickings p on p.id = m.picking_id
                  where p.origin_model = 'purchase_order' and p.origin_id = po.id
                    and m.variant_id = pol.variant_id and m.state = 'done') as ist
          from purchase_order_lines pol
          join purchase_orders po on po.id = pol.order_id
          where po.id = ${po.id}
        )
        select count(*)::int as lines,
               count(*) filter (where ist is not null)::int as delivered,
               count(*) filter (where ist is not null and soll is not null and ist <= soll)::int as on_time,
               count(*) filter (where ist is null and soll < current_date)::int as overdue
        from zeilen`

      assert.equal(rows[0].lines, 2)
      // Beide Zeilen zeigen auf dieselbe Variante, deshalb gilt der Eingang
      // für beide — die zweite ist damit ebenfalls "geliefert".
      assert.equal(rows[0].delivered, 2)
      assert.equal(rows[0].on_time, 1, 'nur die Zeile mit Termin in der Zukunft ist pünktlich')
      assert.equal(rows[0].overdue, 0)
    })
  })
})

describe('Kennzahlensichten', () => {
  test('alle Sichten sind vorhanden und abfragbar', async () => {
    await withRollback(async (t) => {
      const sichten = [
        'mv_stock_value_history',
        'mv_contribution_margin',
        'mv_inventory_turnover',
        'mv_supplier_otd',
        'mv_rma_analysis',
        'mv_labor_hours',
      ]
      for (const sicht of sichten) {
        const [row] = await t<{ c: number }[]>`
          select count(*)::int as c from pg_matviews where matviewname = ${sicht}`
        assert.equal(row.c, 1, `${sicht} fehlt`)
      }

      // Stichprobe: die Sicht liefert die erwarteten Spalten. Materialisierte
      // Sichten stehen nicht im information_schema — deshalb pg_attribute.
      const spalten = await t<{ name: string }[]>`
        select a.attname as name
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        where c.relname = 'mv_inventory_turnover' and a.attnum > 0 and not a.attisdropped`
      const namen = spalten.map((s) => s.name)
      for (const spalte of ['turnover', 'days_of_supply', 'margin_12m', 'avg_value_12m']) {
        assert.ok(namen.includes(spalte), `Spalte ${spalte} fehlt`)
      }
    })
  })

  test('die Wertschicht hat eine verlässliche Reihenfolge', async () => {
    await withRollback(async (t) => {
      const variant = await makeProduct(t, `Reihenfolge ${++counter}`)
      await t`update product_templates set standard_cost = 7
              where id = (select template_id from product_variants where id = ${variant})`
      await stockUp(t, variant, 10)
      await t`select valuation_initialize(${variant}, 'test')`
      await stockUp(t, variant, 20)

      const schichten = await t<{ seq: number; qty_after: number }[]>`
        select seq, qty_after from stock_valuation_layers
        where variant_id = ${variant} order by seq`
      assert.ok(schichten.length >= 2, 'mehrere Schichten')
      for (let i = 1; i < schichten.length; i++) {
        assert.ok(Number(schichten[i].seq) > Number(schichten[i - 1].seq), 'seq steigt')
      }
      assert.equal(
        Number(schichten[schichten.length - 1].qty_after),
        20,
        'die letzte Schicht trägt den Endbestand',
      )
    })
  })

  test('refresh_analytics läuft durch und vermerkt den Zeitpunkt', async () => {
    const [dauer] = await (await import('./helpers.ts')).db()<{ refresh_analytics: string }[]>`
      select refresh_analytics('test')`
    assert.ok(dauer.refresh_analytics, 'liefert eine Dauer')

    const [row] = await (await import('./helpers.ts')).db()<{ refreshed_at: string }[]>`
      select value ->> 'refreshed_at' as refreshed_at from settings where key = 'analytics'`
    assert.ok(row.refreshed_at, 'Zeitpunkt ist vermerkt')
    assert.ok(
      Date.now() - new Date(row.refreshed_at).getTime() < 60_000,
      'der Zeitpunkt ist frisch',
    )
  })
})
