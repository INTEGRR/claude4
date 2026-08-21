import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { closeDb, expectError, makeProduct, withRollback } from './helpers.ts'

after(closeDb)

describe('Stammdaten-Vervollständigung (0012)', () => {
  test('Kategorien pflegen ihren Pfad über die Hierarchie', async () => {
    await withRollback(async (t) => {
      const [wurzel] = await t<{ id: string }[]>`
        select id from product_categories where parent_id is null limit 1`
      const [komp] = await t<{ id: string; full_path: string }[]>`
        insert into product_categories (name, parent_id, full_path)
        values ('Komponenten', ${wurzel.id}, '') returning id, full_path`
      assert.equal(komp.full_path, 'Alle/Komponenten')

      const [elektronik] = await t<{ full_path: string }[]>`
        insert into product_categories (name, parent_id, full_path)
        values ('Elektronik', ${komp.id}, '') returning full_path`
      assert.equal(elektronik.full_path, 'Alle/Komponenten/Elektronik')
    })
  })

  test('Produkte ohne Kategorie fallen auf die Wurzel zurück', async () => {
    await withRollback(async (t) => {
      const variantId = await makeProduct(t, 'Kategorie-Test')
      const [row] = await t<{ full_path: string }[]>`
        select c.full_path from product_variants pv
        join product_templates pt on pt.id = pv.template_id
        join product_categories c on c.id = pt.category_id
        where pv.id = ${variantId}`
      assert.equal(row.full_path, 'Alle')
    })
  })

  test('Skonto-Fälligkeit: payment_term_due_date rechnet beide Varianten', async () => {
    await withRollback(async (t) => {
      const [term30] = await t<{ id: string }[]>`
        select id from payment_terms where nb_days = 30 and delay_type = 'days_after' limit 1`
      const [faellig] = await t<{ d: string }[]>`
        select payment_term_due_date(${term30.id}, '2026-08-07')::text as d`
      assert.equal(faellig.d, '2026-09-06')

      const [monatsende] = await t<{ id: string }[]>`
        insert into payment_terms (name, nb_days, delay_type)
        values ('10 Tage nach Monatsende', 10, 'days_after_end_of_month') returning id`
      const [f2] = await t<{ d: string }[]>`
        select payment_term_due_date(${monatsende.id}, '2026-08-07')::text as d`
      assert.equal(f2.d, '2026-09-11', 'Monatsende 31.08. + 10 Tage')
    })
  })

  test('Lieferantenpreise: Gültigkeit filtert, Rabatt rechnet netto', async () => {
    await withRollback(async (t) => {
      const variantId = await makeProduct(t, 'Preis-Test')
      const [vendor] = await t<{ id: string }[]>`
        insert into partners (name, is_vendor) values ('Preislieferant', true) returning id`
      const [tplRow] = await t<{ template_id: string }[]>`
        select template_id from product_variants where id = ${variantId}`

      // Abgelaufener Preis + gültiger Preis mit Rabatt
      await t`insert into vendor_prices (vendor_id, template_id, price, date_end, sequence)
              values (${vendor.id}, ${tplRow.template_id}, 5.00, current_date - 1, 5)`
      await t`insert into vendor_prices (vendor_id, template_id, price, discount, sequence)
              values (${vendor.id}, ${tplRow.template_id}, 10.00, 15, 10)`

      const [best] = await t<{ price: number; discount: number }[]>`
        select (best_vendor_price(${variantId}, ${vendor.id}, 1)).price,
               (best_vendor_price(${variantId}, ${vendor.id}, 1)).discount`
      assert.equal(Number(best.price), 10, 'abgelaufener Preis wird übergangen')
      const [netto] = await t<{ n: number }[]>`
        select vendor_price_net(${best.price}, ${best.discount}) as n`
      assert.equal(Number(netto.n), 8.5, '10 € mit 15 % Rabatt')
    })
  })

  test('Tags sind je Bereich eindeutig und hängen an Datensätzen', async () => {
    await withRollback(async (t) => {
      const [tag] = await t<{ id: string }[]>`
        insert into tags (kind, name) values ('partner', 'VIP') returning id`
      await expectError(
        t,
        (sp) => sp`insert into tags (kind, name) values ('partner', 'VIP')`,
        /unique|duplicate/i,
      )
      const [partner] = await t<{ id: string }[]>`
        insert into partners (name, is_customer) values ('Tag-Kunde', true) returning id`
      await t`insert into partner_tag_links (partner_id, tag_id) values (${partner.id}, ${tag.id})`
      const [count] = await t<{ count: number }[]>`
        select count(*)::int as count from partner_tag_links l
        join tags g on g.id = l.tag_id where g.name = 'VIP'`
      assert.equal(count.count, 1)
    })
  })

  test('Unterkontakte: Typ und Hierarchie (res.partner.parent_id/type)', async () => {
    await withRollback(async (t) => {
      const [firma] = await t<{ id: string }[]>`
        insert into partners (name, is_company, is_customer) values ('Muster AG', true, true)
        returning id`
      const [liefer] = await t<{ id: string }[]>`
        insert into partners (name, parent_id, partner_type)
        values ('Muster AG Lager Süd', ${firma.id}, 'delivery') returning id`
      const [row] = await t<{ partner_type: string }[]>`
        select partner_type from partners where id = ${liefer.id}`
      assert.equal(row.partner_type, 'delivery')
      await expectError(
        t,
        (sp) => sp`insert into partners (name, partner_type) values ('Kaputt', 'egal')`,
        /check/i,
      )
    })
  })
})
