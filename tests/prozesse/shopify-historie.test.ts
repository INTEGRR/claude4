/**
 * Shopify-Historie und Netto-Preise (Migration 0089) über die echten Wege:
 * Torwächter-Aktionen für den CSV-Import, der Live-Import mit den neuen
 * Preisfeldern und der Abgleich, der jetzt über 50 Bestellungen blättert.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'
import type { HistorieBestellung } from '../../src/modules/integrationen/shopify-csv.ts'

const DATENBANK = 'erp_shopify_historie_check'
const ADMIN = { name: 'historie-test', role: 'admin' as const }

let h: Harness

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

async function artikel(sku: string, mto = false): Promise<string> {
  const [stueck] = await h.sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await h.sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, route_mto, route_manufacture)
    values (${`Historie ${sku}`}, ${stueck.id}, ${mto}, ${mto}) returning id`
  await h.sql`select generate_variants(${tpl.id})`
  const [v] = await h.sql<{ id: string }[]>`
    update product_variants set sku = ${sku} where template_id = ${tpl.id} returning id`
  return v.id
}

function bestellung(name: string, teil: Partial<HistorieBestellung> = {}): HistorieBestellung {
  return {
    id: null,
    name,
    datum: '2024-03-15T10:00:00+01:00',
    email: `${name.slice(1)}@example.com`,
    kunde: `Kunde ${name}`,
    land: 'DE',
    status: 'erfuellt',
    waehrung: 'EUR',
    steuersatz: 19,
    versandNetto: 5,
    positionen: [{ sku: 'H-KB', name: 'Tastatur', menge: 2, stueckNetto: 100 }],
    ...teil,
  }
}

async function importieren(bestellungen: HistorieBestellung[]) {
  const r = await aktionAusfuehrenGeprueft(
    'integrationen.historie_importieren', { parameter: { bestellungen } }, ADMIN)
  return r.daten as { angelegt: number; vorhanden: number; offenJung: number; neueArtikel: number; fehler: string[] }
}

describe('Historie aus dem Shopify-Export', () => {
  test('historische Aufträge: Netto-Umsatz, keine Lieferung, keine Reservierung, keine Fertigung', async () => {
    const tastatur = await artikel('H-KB', true)
    const [bestand] = await h.sql<{ n: number }[]>`select count(*)::int as n from stock_moves`
    const bestandMo = (await h.sql<{ n: number }[]>`select count(*)::int as n from manufacturing_orders`)[0].n

    const r = await importieren([
      bestellung('#2001', { id: '9001' }),
      bestellung('#2002', { status: 'storniert' }),
      bestellung('#2003', {
        positionen: [
          { sku: 'ALT-99', name: 'Altes Board', menge: 1, stueckNetto: 80 },
          { sku: null, name: 'Trinkgeld', menge: 1, stueckNetto: 3 },
        ],
      }),
      // offen und jung: gehört dem Live-Import
      bestellung('#2004', { status: 'offen', datum: new Date().toISOString() }),
    ])
    assert.deepEqual(
      { angelegt: r.angelegt, vorhanden: r.vorhanden, offenJung: r.offenJung, neueArtikel: r.neueArtikel },
      { angelegt: 3, vorhanden: 0, offenJung: 1, neueArtikel: 2 },
    )
    assert.deepEqual(r.fehler, [])

    const [a] = await h.sql<
      { state: string; delivery_status: string; historisch: boolean; versandkosten: number;
        shopify_order_id: string; number: string; net: number; confirmed_at: string | null }[]
    >`
      select so.state, so.delivery_status, so.historisch, so.versandkosten, so.shopify_order_id,
             so.number, (sales_order_total(so.id)).net as net, so.confirmed_at::text
      from sales_orders so where so.shopify_order_name = '#2001'`
    assert.equal(a.state, 'sale')
    assert.equal(a.delivery_status, 'full')
    assert.equal(a.historisch, true)
    assert.equal(a.number, '#2001', 'Bestellname als Nummer — schont den Nummernkreis')
    assert.equal(a.shopify_order_id, 'gid://shopify/Order/9001')
    assert.equal(Number(a.net), 200, 'Warenumsatz netto')
    assert.equal(Number(a.versandkosten), 5)
    assert.ok(a.confirmed_at)

    const [storno] = await h.sql<{ state: string }[]>`
      select state from sales_orders where shopify_order_name = '#2002'`
    assert.equal(storno.state, 'cancel')

    const [nachher] = await h.sql<{ n: number }[]>`select count(*)::int as n from stock_moves`
    assert.equal(nachher.n, bestand.n, 'keine Lagerbewegung')
    const [mo] = await h.sql<{ n: number }[]>`select count(*)::int as n from manufacturing_orders`
    assert.equal(mo.n, bestandMo, 'kein Fertigungsauftrag — auch nicht für MTO-Artikel')
    const [{ klaer }] = await h.sql<{ klaer: number }[]>`
      select count(*)::int as klaer from shopify_unmatched_lines`
    assert.equal(klaer, 0, 'kein Klärfall, kein Dashboard-Alarm')

    // Unbekannte SKU und Position ohne SKU: archivierte Historie-Artikel.
    const archiv = await h.sql<{ sku: string | null; active: boolean; historie: string }[]>`
      select pv.sku, pt.active, pt.zusatz ->> 'historie' as historie
      from product_templates pt join product_variants pv on pv.template_id = pt.id
      where pt.zusatz ? 'historie' order by pv.sku nulls last`
    assert.deepEqual([...archiv], [
      { sku: 'ALT-99', active: false, historie: 'artikel' },
      { sku: null, active: false, historie: 'sammelartikel' },
    ])

    // Deckungsbeitrag sieht die Historie am Auftragsdatum.
    const [dbeitrag] = await h.sql<{ qty: number; revenue: number }[]>`
      select sum(qty) as qty, sum(revenue) as revenue from mv_contribution_margin
      where variant_id = ${tastatur} and monat = '2024-03-01'`
    assert.equal(Number(dbeitrag.qty), 2)
    assert.equal(Number(dbeitrag.revenue), 200)
  })

  test('zweiter Lauf: alles erkannt, nichts doppelt — über ID und Bestellname', async () => {
    const r = await importieren([bestellung('#2001', { id: '9001' }), bestellung('#2003')])
    assert.equal(r.angelegt, 0)
    assert.equal(r.vorhanden, 2)
    const [{ n }] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from sales_orders where historisch`
    assert.equal(n, 3)
  })

  test('bestehender Kontakt wird per E-Mail gefunden und nicht überschrieben', async () => {
    await h.sql`insert into partners (name, is_customer, email, city)
                values ('Bert Bestand', true, 'bert@example.com', 'Köln')`
    await importieren([bestellung('#2010', { email: 'BERT@example.com', kunde: 'Anderer Name' })])
    const [p] = await h.sql<{ name: string; city: string; n: number }[]>`
      select p.name, p.city, (select count(*)::int from partners where lower(email) = 'bert@example.com') as n
      from partners p where p.email = 'bert@example.com'`
    assert.deepEqual(p, { name: 'Bert Bestand', city: 'Köln', n: 1 })
  })

  test('Prüfung: unbekannte SKUs und vorhandene Bestellungen', async () => {
    const r = await aktionAusfuehrenGeprueft(
      'integrationen.historie_pruefen',
      { parameter: { skus: ['H-KB', 'NEU-1'], namen: ['#2001', '#9999'] } },
      ADMIN,
    )
    assert.deepEqual(r.daten, { unbekannteSkus: ['NEU-1'], vorhanden: 1 })
  })
})

describe('Live-Import netto und Abgleich', () => {
  function shopOrder(nummer: number, teil: Record<string, unknown> = {}) {
    return {
      id: `gid://shopify/Order/${nummer}`,
      name: `#${nummer}`,
      createdAt: '2026-09-28T10:00:00Z',
      updatedAt: `2026-09-28T10:${String(Math.floor(nummer / 60) % 60).padStart(2, '0')}:${String(nummer % 60).padStart(2, '0')}Z`,
      email: `k${nummer}@example.com`,
      tags: [],
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'FULFILLED',
      cancelledAt: null,
      taxesIncluded: true,
      totalPriceSet: { shopMoney: { amount: '112.95', currencyCode: 'EUR' } },
      customer: null,
      shippingAddress: {
        name: `Kunde ${nummer}`, address1: 'Weg 1', address2: null, zip: '10115',
        city: 'Berlin', countryCodeV2: 'DE', phone: null,
      },
      shippingLine: { discountedPriceSet: { shopMoney: { amount: '5.95' } }, taxLines: [{ rate: 0.19 }] },
      lineItems: {
        nodes: [
          {
            id: `gid://shopify/LineItem/${nummer}`,
            title: 'Tastatur',
            sku: 'H-KB',
            quantity: 1,
            currentQuantity: 1,
            variant: null,
            originalUnitPriceSet: { shopMoney: { amount: '119.00' } },
            discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '107.10' } },
            taxLines: [{ rate: 0.19 }],
          },
        ],
      },
      ...teil,
    }
  }

  test('Brutto-Shop mit Rabatt: Netto-Preis nach Rabatt, 19 %, Versand netto, historisch markiert', async () => {
    const { fakeOrderHinterlegen } = await import('../../src/modules/integrationen/shopify-fake.ts')
    const { importOrderByGid } = await import('../../src/modules/integrationen/import.ts')
    fakeOrderHinterlegen(shopOrder(700001) as never)
    const r = await importOrderByGid('gid://shopify/Order/700001')
    assert.ok(r.created)
    const [z] = await h.sql<{ price_unit: number; tax_rate: number; qty_delivered: number; versandkosten: number; historisch: boolean }[]>`
      select l.price_unit, l.tax_rate, l.qty_delivered, so.versandkosten, so.historisch
      from sales_orders so join sales_order_lines l on l.order_id = so.id
      where so.shopify_order_id = 'gid://shopify/Order/700001'`
    assert.equal(Number(z.price_unit), 90, '107,10 € brutto nach Rabatt = 90 € netto')
    assert.equal(Number(z.tax_rate), 19)
    assert.equal(Number(z.versandkosten), 5)
    assert.equal(z.historisch, true, 'in Shopify versandt → historisch')
    assert.equal(Number(z.qty_delivered), 1)
  })

  test('Abgleich blättert über 50 Bestellungen hinaus', async () => {
    const { fakeOrderHinterlegen, fakeBestellungenLeeren } = await import(
      '../../src/modules/integrationen/shopify-fake.ts')
    const { reconcileOrders } = await import('../../src/modules/integrationen/import.ts')
    fakeBestellungenLeeren()
    for (let n = 1; n <= 60; n++) fakeOrderHinterlegen(shopOrder(710000 + n) as never)
    await h.sql`insert into shopify_sync_state (key, value)
                values ('last_reconciliation_at', to_jsonb('2026-01-01T00:00:00Z'::text))
                on conflict (key) do update set value = excluded.value`
    const r = await reconcileOrders()
    assert.equal(r.checked, 60, 'beide Seiten gelesen (bis 0089: nur 50)')
    assert.equal(r.imported, 60)
    assert.equal(r.mehr, false)
    const [{ marke }] = await h.sql<{ marke: string }[]>`
      select value #>> '{}' as marke from shopify_sync_state where key = 'last_reconciliation_at'`
    assert.ok(new Date(marke).getTime() > Date.parse('2026-09-01'), 'Marke rückt vor')
  })

  test('Preise nachziehen setzt alte Brutto-Aufträge auf netto', async () => {
    const { fakeOrderHinterlegen } = await import('../../src/modules/integrationen/shopify-fake.ts')
    const kunde = (await h.sql<{ id: string }[]>`
      insert into partners (name, is_customer) values ('Altkunde Brutto', true) returning id`)[0].id
    const [variante] = await h.sql<{ id: string; uom: string }[]>`
      select pv.id, pt.uom_id as uom from product_variants pv
      join product_templates pt on pt.id = pv.template_id where pv.sku = 'H-KB'`
    const [so] = await h.sql<{ id: string }[]>`
      insert into sales_orders (number, partner_id, source, shopify_order_id, shopify_order_name, state)
      values (next_sequence('sale'), ${kunde}, 'shopify', 'gid://shopify/Order/720001', '#720001', 'sale')
      returning id`
    await h.sql`insert into sales_order_lines (order_id, variant_id, name, qty, uom_id, price_unit)
                values (${so.id}, ${variante.id}, 'Tastatur', 1, ${variante.uom}, 119)`
    fakeOrderHinterlegen(shopOrder(720001) as never)

    const r = await aktionAusfuehrenGeprueft('integrationen.shopify_preise_nachziehen', {}, ADMIN)
    assert.match(r.text ?? '', /auf Netto-Preise gesetzt/)
    const [z] = await h.sql<{ price_unit: number; versandkosten: number }[]>`
      select l.price_unit, so.versandkosten from sales_order_lines l
      join sales_orders so on so.id = l.order_id where so.id = ${so.id}`
    assert.equal(Number(z.price_unit), 90)
    assert.equal(Number(z.versandkosten), 5)
  })
})
