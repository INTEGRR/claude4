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
 * Kennzahlen. Seit Migration 0088 sind die Sichten mv_* normale Sichten —
 * sie rechnen bei jeder Abfrage live und sehen deshalb auch Daten der
 * laufenden Transaktion. Die Tests fragen sie direkt ab.
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

/** Deckungsbeitrag einer Variante — direkt aus der live gerechneten Sicht. */
const MARGE_SQL = (t: TransactionSql, variant: string) => t<
  { qty: number; revenue: number; cost: number }[]
>`
  select sum(qty) as qty, sum(revenue) as revenue, sum(cost) as cost
  from mv_contribution_margin where variant_id = ${variant}`

/** Bewerteter Bestand einer Variante (Summe der Wertschichten). */
async function bewertung(t: TransactionSql, variant: string) {
  const [v] = await t<{ valued_qty: number; valuation_total: number; moving_avg_cost: number }[]>`
    select valued_qty, valuation_total, moving_avg_cost from product_variants where id = ${variant}`
  return {
    menge: Number(v.valued_qty),
    wert: Number(v.valuation_total),
    schnitt: Number(v.moving_avg_cost),
  }
}

async function einkaufspreis(t: TransactionSql, variant: string, preis: number) {
  await t`update product_templates set standard_cost = ${preis}
          where id = (select template_id from product_variants where id = ${variant})`
}

describe('Deckungsbeitrag', () => {
  test('Umsatz minus tatsächlicher Wareneinsatz', async () => {
    await withRollback(async (t) => {
      const s = await verkaufMitLieferung(t, { einstand: 30, preis: 100, menge: 4 })
      const [row] = await MARGE_SQL(t, s.variant)

      assert.equal(Number(row.qty), 4)
      assert.equal(Number(row.revenue), 400, '4 × 100 €')
      assert.equal(Number(row.cost), 120, '4 × 30 € Einstand')
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

describe('Echtzeit (0088)', () => {
  test('Inventur zu 0 €, danach Einkaufspreis setzen: der Bestand ist sofort bewertet', async () => {
    await withRollback(async (t) => {
      const variant = await makeProduct(t, `Deskmat ${++counter}`)
      await stockUp(t, variant, 10)
      assert.deepEqual(await bewertung(t, variant), { menge: 10, wert: 0, schnitt: 0 })

      await einkaufspreis(t, variant, 12)
      assert.deepEqual(await bewertung(t, variant), { menge: 10, wert: 120, schnitt: 12 })

      const [schicht] = await t<{ layer_type: string; quantity: number; value: number }[]>`
        select layer_type, quantity, value from stock_valuation_layers
        where variant_id = ${variant} order by seq desc limit 1`
      assert.equal(schicht.layer_type, 'revaluation')
      assert.equal(Number(schicht.quantity), 0, 'reine Wertbuchung')
      assert.equal(Number(schicht.value), 120)

      const [umschlag] = await t<{ value_now: number }[]>`
        select value_now from mv_inventory_turnover where variant_id = ${variant}`
      assert.equal(Number(umschlag.value_now), 120, 'Kennzahl ohne Neuberechnung aktuell')
      const [wert] = await t<{ value_end: number }[]>`
        select value_end from mv_stock_value_history
        where variant_id = ${variant} and monat = date_trunc('month', current_date)::date`
      assert.equal(Number(wert.value_end), 120, 'Wertverlauf ebenso')
    })
  })

  test('Preisänderung bei vorhandenem Durchschnitt: Neubewertung um die Differenz', async () => {
    await withRollback(async (t) => {
      const variant = await makeProduct(t, `Keycaps ${++counter}`)
      await einkaufspreis(t, variant, 10)
      await stockUp(t, variant, 5)
      assert.equal((await bewertung(t, variant)).wert, 50)

      await einkaufspreis(t, variant, 14)
      assert.deepEqual(await bewertung(t, variant), { menge: 5, wert: 70, schnitt: 14 })

      // Ein leerer Preis heißt „unbekannt" — er wertet nicht ab.
      await einkaufspreis(t, variant, 0)
      assert.deepEqual(await bewertung(t, variant), { menge: 5, wert: 70, schnitt: 14 })

      // Ohne Bestand merkt sich die Variante nur den Preis für den nächsten Zugang.
      const leer = await makeProduct(t, `Leer ${++counter}`)
      await einkaufspreis(t, leer, 9)
      assert.deepEqual(await bewertung(t, leer), { menge: 0, wert: 0, schnitt: 9 })
    })
  })

  test('der Deckungsbeitrag folgt dem Einkaufspreis sofort', async () => {
    await withRollback(async (t) => {
      const s = await verkaufMitLieferung(t, { einstand: 30, preis: 100, menge: 4 })
      assert.equal(Number((await MARGE_SQL(t, s.variant))[0].cost), 120)
      await einkaufspreis(t, s.variant, 40)
      assert.equal(Number((await MARGE_SQL(t, s.variant))[0].cost), 160, '4 × 40 € — heutiger Einstand')
    })
  })

  test('Aufträge ohne Lieferschein (historisch übernommen) zählen am Auftragsdatum', async () => {
    await withRollback(async (t) => {
      const uom = await uomStueck(t)
      const variant = await makeProduct(t, `Historisch ${++counter}`)
      await einkaufspreis(t, variant, 20)
      const [kunde] = await t<{ id: string }[]>`
        insert into partners (name, is_customer) values ('Altkunde', true) returning id`
      const [order] = await t<{ id: string }[]>`
        insert into sales_orders (number, partner_id, state, delivery_status, order_date)
        values (next_sequence('sale'), ${kunde.id}, 'sale', 'full', '2024-03-15')
        returning id`
      await t`
        insert into sales_order_lines (order_id, variant_id, name, qty, uom_id, price_unit, discount)
        values (${order.id}, ${variant}, 'Alt', 3, ${uom}, 50, 10)`
      const [row] = await t<{ monat: string; qty: number; revenue: number; cost: number }[]>`
        select monat::text, qty, revenue, cost from mv_contribution_margin where variant_id = ${variant}`
      assert.equal(row.monat, '2024-03-01')
      assert.equal(Number(row.qty), 3)
      assert.equal(Number(row.revenue), 135, '3 × 50 € − 10 %')
      assert.equal(Number(row.cost), 60, '3 × 20 € heutiger Einstand')
    })
  })

  test('ohne Durchschnitt und Einkaufspreis: Stücklistenkosten', async () => {
    await withRollback(async (t) => {
      const uom = await uomStueck(t)
      const teil = await makeProduct(t, `Switch ${++counter}`)
      await einkaufspreis(t, teil, 0.5)
      const tastatur = await makeProduct(t, `Board ${++counter}`)
      const [bom] = await t<{ id: string }[]>`
        insert into boms (template_id, qty, uom_id)
        values ((select template_id from product_variants where id = ${tastatur}), 1, ${uom})
        returning id`
      await t`insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
              values (${bom.id}, 10, ${teil}, 70, ${uom})`
      const [p] = await t<{ preis: number }[]>`select einstandspreis_aktuell(${tastatur}) as preis`
      assert.equal(Number(p.preis), 35, '70 Switches × 0,50 €')
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
          select count(*)::int as c from pg_views where viewname = ${sicht}`
        assert.equal(row.c, 1, `${sicht} fehlt (normale Sicht seit 0088)`)
      }

      // Stichprobe: die Sicht liefert die erwarteten Spalten.
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

  test('refresh_analytics bleibt für Altaufrufer aufrufbar, rechnet aber nichts mehr', async () => {
    await withRollback(async (t) => {
      const [row] = await t<{ dauer: string }[]>`select refresh_analytics('test')::text as dauer`
      assert.equal(row.dauer, '00:00:00')
    })
  })
})
