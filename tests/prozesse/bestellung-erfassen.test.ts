/**
 * Bestellung aus Beleg erfassen (KI-Chat, Entscheidungslog 2026-10-15): eine
 * außerhalb von KRNL schon getätigte und bezahlte Bestellung — Commercial
 * Invoice im Chat — entsteht in EINER Transaktion samt neuem Lieferanten,
 * neuem Kaufteil, Fracht als Dienstleistungszeile, Bestätigung (Wareneingang
 * wird erwartet) und Vorkasse im Zahlungsregister. Danach wird der Beleg
 * über einkauf.beleg_ablegen an der Bestellung abgelegt (Drive-Attrappe).
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_bestellung_erfassen_check'
const ADMIN = { name: 'beleg-test', role: 'admin' as const }
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
let h: Harness

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

describe('Bestellung aus Beleg erfassen', () => {
  test('neuer Lieferant, vorhandener und neuer Artikel, Fracht, bestätigt, Vorkasse bezahlt, Beleg abgelegt', async () => {
    const sql = h.sql
    await sql`
      insert into exchange_rates (currency, valid_from, rate) values ('USD', current_date - 30, 0.9)
      on conflict (currency, valid_from) do update set rate = excluded.rate`
    const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
    const [tpl] = await sql<{ id: string }[]>`
      insert into product_templates (name, uom_id, can_be_purchased, route_buy)
      values ('Belegtest Philips Pan Head Screw M3x4 Messing', ${stueck.id}, true, true) returning id`
    await sql`select generate_variants(${tpl.id})`
    await sql`update product_variants set sku = 'BT-M3X4-MS' where template_id = ${tpl.id}`
    const lieferant = `Shenzhen Belegtest Co. ${Date.now()}`

    const r = await aktionAusfuehrenGeprueft(
      'einkauf.bestellung_erfassen',
      {
        parameter: {
          lieferant,
          lieferant_neu: true,
          lieferant_land: 'cn',
          lieferant_email: 'sales@belegtest.example',
          positionen: [
            { artikel_neu: 'Philips Flat Head Screw M2x0.4x4mm Carbon Steel Black', sku_neu: 'BT-M2X4-CS', menge: 10000, preis: 0.011 },
            { produkt: 'BT-M3X4-MS', menge: 2000, preis: 0.048 },
          ],
          waehrung: 'usd',
          incoterm_code: 'ddp',
          referenz: 'CH2026092142',
          bestelldatum: '2026-09-21',
          eta: '2026-10-20',
          versandkosten: 75,
          bestaetigen: true,
          bezahlt: true,
          bezahlt_betrag: 321,
          bezahlt_am: '2026-09-22',
          beleg_art: 'ci',
        },
      },
      ADMIN,
    )
    assert.ok(r.recordId)
    assert.match(r.text ?? '', /bestätigt — der Wareneingang wird erwartet/)
    assert.match(r.text ?? '', /Vorkasse 321\.00 USD am 2026-09-22/)
    assert.match(r.text ?? '', /Lieferant neu angelegt/)
    assert.match(r.text ?? '', /neue Artikel: Philips Flat Head/)
    assert.doesNotMatch(r.text ?? '', /kein USD-Kurs/)

    const [po] = await sql<
      { state: string; currency: string; incoterm_code: string; vendor_reference: string; bestellt: string; eta: string; exchange_rate: number }[]
    >`
      select state, currency, incoterm_code, vendor_reference, confirmed_at::date::text as bestellt,
             expected_arrival::date::text as eta, exchange_rate
      from purchase_orders where id = ${r.recordId}`
    assert.equal(po.state, 'purchase')
    assert.equal(po.currency, 'USD')
    assert.equal(po.incoterm_code, 'DDP')
    assert.equal(po.vendor_reference, 'CH2026092142')
    assert.equal(po.bestellt, '2026-09-21')
    assert.equal(po.eta, '2026-10-20')
    assert.equal(Number(po.exchange_rate), 0.9)

    const zeilen = await sql<{ name: string; qty: number; price_unit: number }[]>`
      select name, qty, price_unit from purchase_order_lines where order_id = ${r.recordId} order by sequence`
    assert.equal(zeilen.length, 3)
    assert.equal(Number(zeilen[0].qty), 10000)
    assert.equal(Number(zeilen[0].price_unit), 0.011, 'sechs Nachkommastellen bleiben erhalten')
    assert.equal(Number(zeilen[1].price_unit), 0.048)
    assert.equal(zeilen[2].name, 'Fracht laut Beleg (DDP)')
    assert.equal(Number(zeilen[2].price_unit), 75)

    const [neu] = await sql<{ sku: string; can_be_purchased: boolean; can_be_sold: boolean; route_buy: boolean }[]>`
      select pv.sku, pt.can_be_purchased, pt.can_be_sold, pt.route_buy
      from product_variants pv join product_templates pt on pt.id = pv.template_id
      where pv.sku = 'BT-M2X4-CS'`
    assert.ok(neu, 'neues Kaufteil mit SKU')
    assert.equal(neu.can_be_purchased, true)
    assert.equal(neu.can_be_sold, false)
    assert.equal(neu.route_buy, true)

    const [lf] = await sql<{ country_code: string; is_vendor: boolean; standard_waehrung: string; standard_incoterm: string; email: string }[]>`
      select country_code, is_vendor, standard_waehrung, standard_incoterm, email from partners where name = ${lieferant}`
    assert.deepEqual(lf, { country_code: 'CN', is_vendor: true, standard_waehrung: 'USD', standard_incoterm: 'DDP', email: 'sales@belegtest.example' })

    // Wareneingang: die zwei Waren, nicht die Fracht
    const [picking] = await sql<{ id: string }[]>`
      select id from stock_pickings where origin_model = 'purchase_order' and origin_id = ${r.recordId}`
    assert.ok(picking, 'Wareneingang entstanden')
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from stock_moves where picking_id = ${picking.id}`
    assert.equal(n, 2)

    // Zahlplan und Zahlungsregister in Belegwährung
    const [rate] = await sql<{ bezeichnung: string; betrag: number; bezahlt_am: string }[]>`
      select bezeichnung, betrag, bezahlt_am::text as bezahlt_am from zahlplan_raten where purchase_order_id = ${r.recordId}`
    assert.equal(rate.bezeichnung, 'Vorkasse 100 %')
    assert.equal(Number(rate.betrag), 321)
    assert.equal(rate.bezahlt_am, '2026-09-22')
    const [z] = await sql<{ betrag: number; waehrung: string; betrag_eur: number; quelle: string; am: string; zweck: string }[]>`
      select z.betrag, z.waehrung, z.betrag_eur, z.quelle, z.gezahlt_am::text as am, z.verwendungszweck as zweck
      from zahlungen z join zahlplan_raten r on r.id = z.zahlplan_rate_id
      where r.purchase_order_id = ${r.recordId}`
    assert.equal(Number(z.betrag), 321)
    assert.equal(z.waehrung, 'USD')
    assert.equal(Number(z.betrag_eur), 288.9)
    assert.equal(z.quelle, 'po_rate')
    assert.equal(z.am, '2026-09-22')
    assert.match(z.zweck, /CH2026092142/)

    // Beleg ablegen: derselbe Inhalt ein zweites Mal wird verknüpft, nicht kopiert
    const b1 = await aktionAusfuehrenGeprueft(
      'einkauf.beleg_ablegen',
      { recordId: r.recordId, parameter: { name: 'CH2026092142.png', mime: 'image/png', daten: PNG, art: 'ci' } },
      ADMIN,
    )
    assert.match(b1.text ?? '', /an der Bestellung abgelegt/)
    const b2 = await aktionAusfuehrenGeprueft(
      'einkauf.beleg_ablegen',
      { recordId: r.recordId, parameter: { name: 'nochmal.png', mime: 'image/png', daten: PNG } },
      ADMIN,
    )
    assert.match(b2.text ?? '', /war schon abgelegt/)
    const doks = await sql<{ art: string; quelle: string; name: string }[]>`
      select d.art::text as art, d.quelle::text as quelle, d.name
      from dokument_verweise v join dokumente d on d.id = v.dokument_id
      where v.modell = 'purchase_order' and v.record_id = ${r.recordId}`
    assert.equal(doks.length, 1)
    assert.equal(doks[0].art, 'ci')
    assert.equal(doks[0].quelle, 'upload')
    assert.equal(doks[0].name, 'CH2026092142.png')
    const [job] = await sql<{ kind: string }[]>`
      select kind from integration_jobs where dedupe_key = ${`ki-dokument:${(b1.daten as { dokument_id: string }).dokument_id}`}`
    assert.equal(job?.kind, 'ki_dokument_lesen', 'der Dokument-Leser liest den Beleg')
  })

  test('Entwurf ohne Zahlung in Euro; ohne Kurs kommt der Hinweis', async () => {
    const sql = h.sql
    const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
    const [tpl] = await sql<{ id: string }[]>`
      insert into product_templates (name, uom_id, can_be_purchased) values ('Belegtest Feder', ${stueck.id}, true) returning id`
    await sql`select generate_variants(${tpl.id})`
    await sql`update product_variants set sku = 'BT-FEDER' where template_id = ${tpl.id}`
    await sql`insert into partners (name, is_vendor, is_company, country_code) values ('Belegtest Federn GmbH', true, true, 'DE')`

    const r = await aktionAusfuehrenGeprueft(
      'einkauf.bestellung_erfassen',
      {
        parameter: {
          lieferant: 'Belegtest Federn GmbH',
          positionen: [{ produkt: 'BT-FEDER', menge: 50, preis: 1.2 }],
          waehrung: 'CNY',
          bestaetigen: false,
          bestelldatum: '2026-10-01',
        },
      },
      ADMIN,
    )
    assert.ok(r.recordId)
    assert.match(r.text ?? '', /als Entwurf/)
    assert.match(r.text ?? '', /kein CNY-Kurs hinterlegt/)
    const [po] = await sql<{ state: string; frist: string }[]>`
      select state, order_deadline::date::text as frist from purchase_orders where id = ${r.recordId}`
    assert.equal(po.state, 'draft')
    assert.equal(po.frist, '2026-10-01')
    const [{ raten }] = await sql<{ raten: number }[]>`select count(*)::int as raten from zahlplan_raten where purchase_order_id = ${r.recordId}`
    assert.equal(raten, 0)
  })

  test('Fehler lassen nichts zurück: Zeile ohne Artikel, unbekannter Lieferant, neuer Lieferant ohne Land', async () => {
    const sql = h.sql
    const zaehlen = async () => {
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from purchase_orders`
      return n
    }
    const vorher = await zaehlen()
    await assert.rejects(
      aktionAusfuehrenGeprueft('einkauf.bestellung_erfassen', { parameter: { lieferant: 'Gibts nicht GmbH', positionen: [{ menge: 1 }] } }, ADMIN),
      /Position 1: produkt/,
    )
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einkauf.bestellung_erfassen',
        { parameter: { lieferant: 'Gibts nicht GmbH', positionen: [{ artikel_neu: 'Teil', menge: 1 }] } },
        ADMIN,
      ),
      /Lieferant „Gibts nicht GmbH" nicht gefunden/,
    )
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einkauf.bestellung_erfassen',
        { parameter: { lieferant: 'Gibts nicht GmbH', lieferant_neu: true, positionen: [{ artikel_neu: 'Teil', menge: 1 }] } },
        ADMIN,
      ),
      /lieferant_land/,
    )
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einkauf.bestellung_erfassen',
        { parameter: { lieferant: 'Belegtest Federn GmbH', positionen: [{ produkt: 'BT-GIBTSNICHT', menge: 1 }], waehrung: 'XXX' } },
        ADMIN,
      ),
      /Währung XXX/,
    )
    assert.equal(await zaehlen(), vorher)
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from partners where name = 'Gibts nicht GmbH'`
    assert.equal(n, 0, 'kein halber Lieferant')
  })
})
