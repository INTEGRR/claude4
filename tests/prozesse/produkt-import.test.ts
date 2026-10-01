/**
 * Produktübernahme aus Shopify mit Bundles (Shopifys Bundles-App), durch den
 * echten Job und die echte Datenbank. Nachgestellt ist der Fall aus dem
 * Parallelbetrieb (2026-09-29): Eine Bundle-Bestandteil-Liste („Black Week
 * Editions") trägt die SKUs der weißen Tastaturen und kam in Shopify VOR dem
 * normalen Produkt. Früher belegte sie die SKUs, und „Nexus White" scheiterte
 * komplett an der Eindeutigkeit der SKU — samt seiner eindeutigen Varianten.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { runDueJobs } from '../../src/modules/integrationen/jobs.ts'
import { fakeProdukteHinterlegen } from '../../src/modules/integrationen/shopify-fake.ts'
import { importShopifyOrder } from '../../src/modules/integrationen/import.ts'

const DATENBANK = 'erp_produkt_import_check'
let h: Harness

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

const gid = (art: string, n: number) => `gid://shopify/${art}/${n}`

function variante(n: number, sku: string | null, option: [string, string]) {
  return {
    id: gid('ProductVariant', n),
    sku,
    barcode: null,
    price: '299.00',
    selectedOptions: [{ name: option[0], value: option[1] }],
    inventoryItem: { id: gid('InventoryItem', n) },
  }
}

function produkt(
  n: number,
  title: string,
  option: string,
  varianten: ReturnType<typeof variante>[],
  bundle: { istBundle?: boolean; steckeIn?: number } = {},
) {
  return {
    id: gid('Product', n),
    title,
    descriptionHtml: null,
    hasVariantsThatRequiresComponents: bundle.istBundle ?? false,
    productParents: { nodes: bundle.steckeIn ? [{ id: gid('Product', bundle.steckeIn) }] : [] },
    options: [{ name: option, values: varianten.map((v) => v.selectedOptions[0].value) }],
    variants: { nodes: varianten },
  }
}

// Reihenfolge wie Shopify sie liefert (CREATED_AT): Bestandteil, Bundle,
// dann erst das normale Produkt — der ungünstigste Fall.
const SHOP = [
  produkt(1, 'Test Black Week Editions', 'Farbe', [
    variante(11, 'T-WEISS-W', ['Farbe', 'Weiß']),
    variante(12, 'T-SCHWARZ-BO', ['Farbe', 'Schwarz']),
  ], { steckeIn: 2 }),
  produkt(2, 'Test Black Week Bundle + Deskmat', 'Farbe', [
    variante(21, null, ['Farbe', 'Weiß']),
    variante(22, null, ['Farbe', 'Schwarz']),
  ], { istBundle: true }),
  produkt(3, 'Test Nexus White', 'Schalter', [
    variante(31, 'T-WEISS-W', ['Schalter', 'W']),
    variante(32, 'T-WEISS-R', ['Schalter', 'R']),
  ]),
  produkt(4, 'Test Doppel-SKU', 'Größe', [
    variante(41, 'T-DUP', ['Größe', 'S']),
    variante(42, 'T-DUP', ['Größe', 'M']),
  ]),
]

async function importLaufen(): Promise<string[]> {
  await h.sql`select enqueue_job('shopify_product_import', '{}'::jsonb, 'produkt-import:start')`
  // Durchgang 1 reiht Durchgang 2 ein — so lange laufen, bis nichts mehr offen ist.
  for (let i = 0; i < 5; i++) {
    await runDueJobs()
    const [{ offen }] = await h.sql<{ offen: number }[]>`
      select count(*)::int as offen from integration_jobs
      where kind = 'shopify_product_import' and status not in ('done', 'failed')`
    if (offen === 0) break
  }
  const ergebnisse = await h.sql<{ last_result: string }[]>`
    select last_result from integration_jobs
    where kind = 'shopify_product_import' order by updated_at`
  return ergebnisse.map((r) => r.last_result)
}

async function variantenVon(titel: string) {
  return h.sql<{ id: string; sku: string | null; shopify_variant_id: string | null; active: boolean }[]>`
    select pv.id, pv.sku, pv.shopify_variant_id, pv.active
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pt.name = ${titel} order by pv.sku nulls last`
}

describe('Produktübernahme: Bundles und Zweitangebote', () => {
  test('das normale Produkt bekommt den Artikel, die Bundle-Liste nur den Rest, das Bundle nichts', async () => {
    fakeProdukteHinterlegen(SHOP)
    const ergebnisse = await importLaufen()
    assert.ok(ergebnisse.some((r) => /Durchgang 2: .*Übernahme abgeschlossen/.test(r)), ergebnisse.join('\n'))
    assert.ok(!ergebnisse.some((r) => /Probleme/.test(r)), `keine Probleme erwartet:\n${ergebnisse.join('\n')}`)

    // Nexus White vollständig — auch die geteilte SKU gehört ihm.
    const nexus = await variantenVon('Test Nexus White')
    assert.deepEqual(
      nexus.filter((v) => v.active).map((v) => [v.sku, v.shopify_variant_id]),
      [['T-WEISS-R', gid('ProductVariant', 32)], ['T-WEISS-W', gid('ProductVariant', 31)]],
    )

    // Die Bundle-Liste: nur die eigene SKU als Artikel, die geteilte archiviert.
    const editions = await variantenVon('Test Black Week Editions')
    assert.deepEqual(
      editions.filter((v) => v.active).map((v) => [v.sku, v.shopify_variant_id]),
      [['T-SCHWARZ-BO', gid('ProductVariant', 12)]],
    )
    assert.deepEqual(editions.filter((v) => !v.active).map((v) => v.sku), [null])

    // Das Bundle selbst ist kein Artikel.
    assert.equal((await variantenVon('Test Black Week Bundle + Deskmat')).length, 0)

    // Doppelte SKU im selben Produkt: kein Abbruch, die zweite wird archiviert.
    const doppel = await variantenVon('Test Doppel-SKU')
    assert.deepEqual(doppel.filter((v) => v.active).map((v) => v.sku), ['T-DUP'])
    assert.equal(doppel.filter((v) => !v.active).length, 1)

    const [stand] = await h.sql<{ value: { zweitangebote: number; bundles: number; fertig: boolean } }[]>`
      select value from shopify_sync_state where key = 'backfill_products'`
    assert.equal(stand.value.fertig, true)
    assert.equal(stand.value.zweitangebote, 2)
    assert.equal(stand.value.bundles, 1)

    // Die Zweitangebote sind gemerkt (0106) — der Bestandsabgleich meldet
    // ihnen dieselbe Menge wie dem Artikel: die Bundle-Liste bekommt den
    // Bestand von „Nexus White", die doppelte SKU den ihres Artikels.
    const zweit = await h.sql<{ shopify_variant_id: string; artikel: string; sku: string; produkt: string; item: string }[]>`
      select z.shopify_variant_id, pt.name as artikel, pv.sku, z.produkt, z.shopify_inventory_item_gid as item
      from shopify_zweitangebote z
      join product_variants pv on pv.id = z.variant_id
      join product_templates pt on pt.id = pv.template_id
      order by z.shopify_variant_id`
    assert.deepEqual(
      zweit.map((z) => [z.shopify_variant_id, z.artikel, z.sku, z.produkt, z.item]),
      [
        [gid('ProductVariant', 11), 'Test Nexus White', 'T-WEISS-W', 'Test Black Week Editions', gid('InventoryItem', 11)],
        [gid('ProductVariant', 42), 'Test Doppel-SKU', 'T-DUP', 'Test Doppel-SKU', gid('InventoryItem', 42)],
      ],
    )
  })

  test('ein zweiter Lauf legt nichts doppelt an', async () => {
    const [{ vorher }] = await h.sql<{ vorher: number }[]>`select count(*)::int as vorher from product_variants`
    const ergebnisse = await importLaufen()
    assert.ok(!ergebnisse.some((r) => /Probleme/.test(r)))
    const [{ nachher }] = await h.sql<{ nachher: number }[]>`select count(*)::int as nachher from product_variants`
    assert.equal(nachher, vorher)
    const [{ zweit }] = await h.sql<{ zweit: number }[]>`select count(*)::int as zweit from shopify_zweitangebote`
    assert.equal(zweit, 2, 'Zweitangebote auch nicht doppelt')
  })

  test('eine Bestellung über die Bundle-Liste landet beim Artikel des normalen Produkts', async () => {
    const [artikel] = (await variantenVon('Test Nexus White')).filter((v) => v.sku === 'T-WEISS-W')
    const ergebnis = await importShopifyOrder({
      id: gid('Order', 9900001),
      name: '#BUNDLE-1',
      createdAt: '2026-09-29T10:00:00Z',
      cancelledAt: null,
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'UNFULFILLED',
      email: 'bundle@example.com',
      tags: [],
      totalPriceSet: { shopMoney: { amount: '299.00', currencyCode: 'EUR' } },
      customer: {
        id: gid('Customer', 99),
        firstName: 'Bea',
        lastName: 'Bundle',
        defaultEmailAddress: { emailAddress: 'bundle@example.com' },
      },
      shippingAddress: {
        name: 'Bea Bundle', address1: 'Teststraße 1', address2: null,
        zip: '10115', city: 'Berlin', countryCodeV2: 'DE', phone: null,
      },
      lineItems: {
        nodes: [{
          title: 'Test Black Week Editions — Weiß',
          sku: 'T-WEISS-W',
          quantity: 1,
          currentQuantity: 1,
          variant: { id: gid('ProductVariant', 11) },
          originalUnitPriceSet: { shopMoney: { amount: '299.00' } },
        }],
      },
    } as never)
    assert.equal(ergebnis.unmatched, 0)
    const zeilen = await h.sql<{ variant_id: string }[]>`
      select variant_id from sales_order_lines where order_id = ${ergebnis.salesOrderId}`
    assert.deepEqual(zeilen.map((z) => z.variant_id), [artikel.id])
  })
})
