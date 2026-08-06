import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { TransactionSql } from 'postgres'
import {
  closeDb,
  makeProduct,
  stockUp,
  uomStueck,
  withRollback,
} from './helpers.ts'

after(closeDb)

/**
 * Prüft die Kennzahlen der Auswertungsseite gegen ein durchgespieltes
 * Szenario: dieselben Aggregationen wie in
 * src/app/(erp)/auswertungen/page.tsx, hier mit bekannten Sollwerten.
 */

let counter = 0

async function szenario(t: TransactionSql) {
  const uom = await uomStueck(t)
  const suffix = `AW${++counter}`

  const [tpl] = await t<{ id: string }[]>`
    insert into product_templates (name, uom_id, route_manufacture, can_be_sold)
    values (${`Tastatur ${suffix}`}, ${uom}, true, true) returning id`
  const [attr] = await t<{ id: string }[]>`
    insert into product_attributes (name) values (${`Farbe ${suffix}`}) returning id`
  await t`insert into product_attribute_values (attribute_id, name)
          values (${attr.id}, 'Weiß'), (${attr.id}, 'Schwarz')`
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
  const weiss = variants.find((v) => v.display_name.includes('Weiß'))!.id

  const gehaeuseWeiss = await makeProduct(t, `Gehäuse weiß ${suffix}`)
  const gehaeuseSchwarz = await makeProduct(t, `Gehäuse schwarz ${suffix}`)
  const platine = await makeProduct(t, `Platine ${suffix}`)

  const [bom] = await t<{ id: string }[]>`
    insert into boms (template_id, qty, uom_id) values (${tpl.id}, 1, ${uom}) returning id`
  await t`insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
          values (${bom.id}, 10, ${platine}, 1, ${uom})`
  const [lw] = await t<{ id: string }[]>`
    insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
    values (${bom.id}, 20, ${gehaeuseWeiss}, 1, ${uom}) returning id`
  const [ls] = await t<{ id: string }[]>`
    insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
    values (${bom.id}, 21, ${gehaeuseSchwarz}, 1, ${uom}) returning id`
  await t`insert into bom_line_variant_filters (bom_line_id, ptav_id)
          values (${lw.id}, ${ptavs.find((p) => p.name === 'Weiß')!.id}),
                 (${ls.id}, ${ptavs.find((p) => p.name === 'Schwarz')!.id})`

  return { tplId: tpl.id, weiss, gehaeuseWeiss, gehaeuseSchwarz, platine, uom }
}

/** Fertigmeldungs-Summe je Variante — dieselbe Abfrage wie auf der Seite. */
async function produziert(t: TransactionSql, variantId: string): Promise<number> {
  const [row] = await t<{ menge: number | null }[]>`
    select sum(m.qty_done) as menge from stock_moves m
    where m.production_id is not null and m.reference = 'Fertigmeldung'
      and m.state = 'done' and m.variant_id = ${variantId}`
  return Number(row.menge ?? 0)
}

async function verbaut(t: TransactionSql, variantId: string): Promise<number> {
  const [row] = await t<{ menge: number | null }[]>`
    select sum(m.qty_done) as menge from stock_moves m
    where m.production_id is not null and m.reference = 'Komponentenverbrauch'
      and m.state = 'done' and m.variant_id = ${variantId}`
  return Number(row.menge ?? 0)
}

describe('Auswertungen', () => {
  test('Produktion je Endvariante und verbaute Komponenten', async () => {
    await withRollback(async (t) => {
      const s = await szenario(t)
      await stockUp(t, s.platine, 10)
      await stockUp(t, s.gehaeuseWeiss, 10)
      await stockUp(t, s.gehaeuseSchwarz, 10)

      const [mo] = await t<{ create_manufacturing_order: string }[]>`
        select create_manufacturing_order(${s.weiss}, 3)`
      await t`select mo_confirm(${mo.create_manufacturing_order})`
      await t`select mo_produce(${mo.create_manufacturing_order})`

      assert.equal(await produziert(t, s.weiss), 3, 'drei weiße Tastaturen gefertigt')
      assert.equal(await verbaut(t, s.gehaeuseWeiss), 3, 'weißes Gehäuse dreimal verbaut')
      assert.equal(await verbaut(t, s.gehaeuseSchwarz), 0, 'schwarzes Gehäuse nie verbaut')
      assert.equal(await verbaut(t, s.platine), 3)
    })
  })

  test('Inventarwert: Kosten direkt oder als Stücklisten-Summe', async () => {
    await withRollback(async (t) => {
      const s = await szenario(t)
      // Komponenten bekommen Einstandskosten, das Endprodukt bewusst keine.
      await t`update product_templates pt set standard_cost = 20
              from product_variants pv
              where pv.template_id = pt.id and pv.id = ${s.gehaeuseWeiss}`
      await t`update product_templates pt set standard_cost = 30
              from product_variants pv
              where pv.template_id = pt.id and pv.id = ${s.platine}`

      const [kosten] = await t<{ unit_cost: number }[]>`
        select case
          when pt.standard_cost > 0 then pt.standard_cost
          else coalesce((
            select sum(comp.qty * cpt.standard_cost)
            from bom_components_for_variant(resolve_bom(pv.id), pv.id) comp
            join product_variants cpv on cpv.id = comp.component_variant_id
            join product_templates cpt on cpt.id = cpv.template_id), 0)
          end as unit_cost
        from product_variants pv join product_templates pt on pt.id = pv.template_id
        where pv.id = ${s.weiss}`

      // Weiße Variante: weißes Gehäuse (20) + Platine (30); schwarzes zählt nicht.
      assert.equal(Number(kosten.unit_cost), 50)
    })
  })

  test('Abverkaufsquote: verkauft ÷ (verkauft + Bestand)', async () => {
    await withRollback(async (t) => {
      const s = await szenario(t)
      await stockUp(t, s.weiss, 6)

      const [partner] = await t<{ id: string }[]>`
        insert into partners (name, is_customer) values ('Testkunde AW', true) returning id`
      const [order] = await t<{ id: string }[]>`
        insert into sales_orders (number, partner_id, state)
        values (next_sequence('sale'), ${partner.id}, 'sale') returning id`
      await t`insert into sales_order_lines (order_id, variant_id, name, qty, uom_id, price_unit)
              values (${order.id}, ${s.weiss}, 'Tastatur weiß', 4, ${s.uom}, 199)`

      const [row] = await t<{ verkauft: number; bestand: number }[]>`
        select sum(l.qty) as verkauft, on_hand_qty(l.variant_id) as bestand
        from sales_order_lines l
        join sales_orders so on so.id = l.order_id
        where so.state = 'sale' and l.variant_id = ${s.weiss}
        group by l.variant_id`

      assert.equal(Number(row.verkauft), 4)
      assert.equal(Number(row.bestand), 6)
      const quote = Number(row.verkauft) / (Number(row.verkauft) + Number(row.bestand))
      assert.equal(quote, 0.4, '4 verkauft bei 6 auf Lager => 40 %')
    })
  })

  test('Kommentar-Whitelist: log_event landet im Verlauf', async () => {
    await withRollback(async (t) => {
      const s = await szenario(t)
      await t`select log_event('product_template', ${s.tplId}, 'note', 'Testkommentar', 'Tester')`
      const [row] = await t<{ message: string; actor: string }[]>`
        select message, actor from audit_log
        where model = 'product_template' and record_id = ${s.tplId}
        order by created_at desc limit 1`
      assert.equal(row.message, 'Testkommentar')
      assert.equal(row.actor, 'Tester')
    })
  })
})
