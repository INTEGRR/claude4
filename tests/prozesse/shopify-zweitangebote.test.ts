/**
 * Bestand an Shopify-Zweitangebote (0106, Entscheidungslog 2026-10-01) gegen
 * die echte Datenbank und die Shopify-Attrappe: Ein Artikel mit einem
 * weiteren Shop-Angebot derselben SKU (Bundle-Bestandteil „Black Week
 * Editions") erzeugt ZWEI Bestandsmeldungen — ans verknüpfte Angebot und ans
 * Zweitangebot, mit derselben Menge. Je Angebot steuerbar (aus = 0), im
 * Probelauf nur „würde senden", im Modus „nur lesen" geht nichts hinaus,
 * eine Ablehnung durch Shopify blockiert die Artikel nicht.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_zweitangebote_check'
const ADMIN = { name: 'zweit-test', role: 'admin' as const }
let h: Harness
let artikel = ''
let angebot = ''

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  process.env.SHOPIFY_FAKE = '1'
  await harnessEnde(h, DATENBANK)
})

async function modus(m: 'lesen' | 'probe' | 'schreiben'): Promise<void> {
  await h.sql`insert into settings (key, value) values ('shopify', ${h.sql.json({ modus: m })})
              on conflict (key) do update set value = excluded.value`
}

async function bestand(variante: string, menge: number): Promise<void> {
  const [lager] = await h.sql<{ id: string }[]>`select id from stock_locations where full_path = 'WH/Stock'`
  const [ist] = await h.sql<{ n: number }[]>`
    select coalesce(sum(on_hand), 0)::float as n from stock_quants where variant_id = ${variante} and location_id = ${lager.id}`
  const [z] = await h.sql<{ id: string }[]>`
    insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
    values (${lager.id}, ${variante}, ${menge}, ${ist.n}) returning id`
  await h.sql`select inventory_apply(${z.id}, 'test')`
}

/** Alle Bestandsmeldungen an die Attrappe seit dem Zeitpunkt: je Aufruf InventoryItem → Menge. */
async function meldungenSeit(seit: Date): Promise<Record<string, number>[]> {
  const zeilen = await h.sql<{ request: { variables: { input: { quantities: { inventoryItemId: string; quantity: number }[] } } } }[]>`
    select request from api_transactions
    where kind = 'fake:inventorySetQuantities' and created_at > ${seit} order by created_at, id`
  return zeilen.map((z) =>
    Object.fromEntries(z.request.variables.input.quantities.map((q) => [q.inventoryItemId, q.quantity])),
  )
}

const knoten = (n: number, sku: string | null, produkt: { title: string; bundle?: boolean }) => ({
  id: `gid://shopify/ProductVariant/${n}`, sku, barcode: null, inventoryQuantity: 0, inventoryPolicy: 'DENY',
  availableForSale: true,
  product: { id: `gid://shopify/Product/${n}`, title: produkt.title, status: 'ACTIVE', hasVariantsThatRequiresComponents: produkt.bundle ?? false },
  inventoryItem: { id: `gid://shopify/InventoryItem/${n}`, tracked: true },
})

describe('Bestand an Zweitangebote', () => {
  test('Shop-Stand holen findet das Zweitangebot — nicht das Bundle, nicht Fremdes', async () => {
    await modus('schreiben')
    const [uom] = await h.sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
    const [tpl] = await h.sql<{ id: string }[]>`
      insert into product_templates (name, uom_id, can_be_sold) values ('Zweit-Tastatur Weiß', ${uom.id}, true) returning id`
    await h.sql`select generate_variants(${tpl.id})`
    ;[{ id: artikel }] = await h.sql<{ id: string }[]>`
      update product_variants set sku = 'ZW-KB', shopify_variant_id = 'gid://shopify/ProductVariant/601',
                                  shopify_inventory_item_gid = 'gid://shopify/InventoryItem/601'
      where template_id = ${tpl.id} returning id`
    await bestand(artikel, 4)

    const { fakeShopStandHinterlegen } = await import('../../src/modules/integrationen/shopify-fake.ts')
    fakeShopStandHinterlegen([
      knoten(601, 'ZW-KB', { title: 'Zweit-Tastatur' }),
      knoten(9601, 'ZW-KB', { title: 'Test Black Week Editions' }),
      knoten(9701, 'ZW-KB', { title: 'Black Week Bundle + Deskmat', bundle: true }),
      knoten(9801, 'FREMD-SKU', { title: 'Etwas anderes' }),
    ])
    const r = await aktionAusfuehrenGeprueft('verkauf.shop_stand_holen', {}, ADMIN)
    assert.deepEqual(r.daten, { varianten: 4, verkaufbar: 4, zugeordnet: 1, zweitangebote: 1 })
    assert.match(r.text ?? '', /1 Zweitangebot\(e\) mit derselben SKU/)

    const zeilen = await h.sql<{ id: string; variant_id: string; shopify_variant_id: string; shopify_inventory_item_gid: string; produkt: string }[]>`
      select id, variant_id, shopify_variant_id, shopify_inventory_item_gid, produkt from shopify_zweitangebote`
    assert.equal(zeilen.length, 1)
    assert.deepEqual(
      { ...zeilen[0], id: undefined },
      {
        id: undefined,
        variant_id: artikel,
        shopify_variant_id: 'gid://shopify/ProductVariant/9601',
        shopify_inventory_item_gid: 'gid://shopify/InventoryItem/9601',
        produkt: 'Test Black Week Editions',
      },
    )
    angebot = zeilen[0].id
  })

  test('eine Variante mit Zweitangebot erzeugt zwei Bestandsmeldungen mit derselben Menge', async () => {
    const { inventarAbgleichen } = await import('../../src/modules/integrationen/inventar.ts')
    const seit = new Date()
    const r = await inventarAbgleichen()
    assert.deepEqual(
      [r.uebertragen, r.angebote, r.angeboteUebertragen, r.angeboteAbgelehnt],
      [1, 1, 1, 0],
    )
    assert.deepEqual(await meldungenSeit(seit), [
      { 'gid://shopify/InventoryItem/601': 4 },
      { 'gid://shopify/InventoryItem/9601': 4 },
    ])
    const [stand] = await h.sql<{ pushed_qty: number }[]>`select pushed_qty from shopify_zweitangebote where id = ${angebot}`
    assert.equal(stand.pushed_qty, 4)

    const leer = new Date()
    assert.equal((await inventarAbgleichen()).angeboteUebertragen, 0, 'nichts geändert — kein Aufruf')
    assert.deepEqual(await meldungenSeit(leer), [])

    // Bestand sinkt: beide Angebote folgen.
    await bestand(artikel, 2)
    const danach = new Date()
    await inventarAbgleichen()
    assert.deepEqual(await meldungenSeit(danach), [
      { 'gid://shopify/InventoryItem/601': 2 },
      { 'gid://shopify/InventoryItem/9601': 2 },
    ])
  })

  test('der Job nennt die Zweitangebote', async () => {
    await bestand(artikel, 3)
    await h.sql`select inventar_abgleich_anstossen()`
    const { runDueJobs } = await import('../../src/modules/integrationen/jobs.ts')
    await runDueJobs()
    const [job] = await h.sql<{ last_result: string }[]>`
      select last_result from integration_jobs where kind = 'shopify_inventory_push' order by updated_at desc limit 1`
    assert.match(job.last_result, /Bestand gemeldet: 1 Änderung\(en\).*; Zweitangebote: 1 von 1 gemeldet/)
  })

  test('je Angebot steuerbar: „aus" meldet nur dem Zweitangebot 0, der Artikel bleibt', async () => {
    const { inventarAbgleichen } = await import('../../src/modules/integrationen/inventar.ts')
    const r = await aktionAusfuehrenGeprueft(
      'verkauf.shop_zweitangebot_setzen', { parameter: { angebot_id: angebot, modus: 'aus' } }, ADMIN)
    assert.match(r.text ?? '', /„Test Black Week Editions" .*: aus \(ausverkauft\)/)
    const seit = new Date()
    await inventarAbgleichen()
    assert.deepEqual(await meldungenSeit(seit), [{ 'gid://shopify/InventoryItem/9601': 0 }])

    await aktionAusfuehrenGeprueft(
      'verkauf.shop_zweitangebot_setzen', { parameter: { angebot_id: angebot, modus: 'auto' } }, ADMIN)
    const wieder = new Date()
    await inventarAbgleichen()
    assert.deepEqual(await meldungenSeit(wieder), [{ 'gid://shopify/InventoryItem/9601': 3 }])
  })

  test('Probelauf: nur „würde senden" — auch fürs Zweitangebot, echter Stand bleibt', async () => {
    const { inventarAbgleichen } = await import('../../src/modules/integrationen/inventar.ts')
    await modus('probe')
    await bestand(artikel, 7)
    const seit = new Date()
    await inventarAbgleichen()
    assert.deepEqual(await meldungenSeit(seit), [], 'nichts an Shopify')
    const eintraege = await h.sql<{ request: { zweitangebote?: boolean; aenderungen: { sku: string; angebot?: string; neu: number }[] } }[]>`
      select request from api_transactions where kind = 'probe:inventorySetQuantities' and created_at > ${seit}
      order by created_at, id`
    assert.equal(eintraege.length, 2, 'zwei Einträge wie zwei Mutationen')
    assert.deepEqual(eintraege[0].request.aenderungen.map((a) => [a.sku, a.neu]), [['ZW-KB', 7]])
    assert.equal(eintraege[1].request.zweitangebote, true)
    assert.deepEqual(
      eintraege[1].request.aenderungen.map((a) => [a.sku, a.angebot, a.neu]),
      [['ZW-KB', 'Test Black Week Editions', 7]],
    )
    const [stand] = await h.sql<{ pushed_qty: number; probe_qty: number }[]>`
      select pushed_qty, probe_qty from shopify_zweitangebote where id = ${angebot}`
    assert.deepEqual({ ...stand }, { pushed_qty: 3, probe_qty: 7 }, 'beim Scharfschalten wird echt gemeldet')

    const { probeZeile } = await import('../../src/modules/integrationen/probe-anzeige.ts')
    assert.equal(
      probeZeile('probe:inventorySetQuantities', eintraege[1].request).titel,
      'Bestand an Zweitangebote: 1 Änderung(en) (erste vollständige Meldung)',
    )
  })

  test('nur lesen: auch ans Zweitangebot geht nichts hinaus', async () => {
    const { inventarAbgleichen } = await import('../../src/modules/integrationen/inventar.ts')
    const { ShopifyNurLesen } = await import('../../src/modules/integrationen/shopify.ts')
    await modus('lesen')
    process.env.SHOPIFY_FAKE = '0'
    try {
      await assert.rejects(inventarAbgleichen(), (e: unknown) => e instanceof ShopifyNurLesen)
    } finally {
      process.env.SHOPIFY_FAKE = '1'
    }
    const [stand] = await h.sql<{ pushed_qty: number }[]>`select pushed_qty from shopify_zweitangebote where id = ${angebot}`
    assert.equal(stand.pushed_qty, 3, 'unverändert')
  })

  test('Shopify lehnt ein Zweitangebot ab: der Artikel und die übrigen Angebote kommen trotzdem an', async () => {
    const { inventarAbgleichen } = await import('../../src/modules/integrationen/inventar.ts')
    await modus('schreiben')
    // Zweites Angebot, dessen InventoryItem am Standort nicht geführt wird.
    await h.sql`insert into shopify_zweitangebote (variant_id, shopify_variant_id, shopify_inventory_item_gid, produkt, sku)
                values (${artikel}, 'gid://shopify/ProductVariant/404404', 'gid://shopify/InventoryItem/404404', 'Altes Bundle', 'ZW-KB')`
    await bestand(artikel, 5)
    const seit = new Date()
    const r = await inventarAbgleichen()
    assert.deepEqual([r.uebertragen, r.angeboteUebertragen, r.angeboteAbgelehnt], [1, 1, 1])
    assert.deepEqual(await meldungenSeit(seit), [
      { 'gid://shopify/InventoryItem/601': 5 },
      { 'gid://shopify/InventoryItem/404404': 5, 'gid://shopify/InventoryItem/9601': 5 },
      { 'gid://shopify/InventoryItem/9601': 5 },
    ])
    const [abgelehnt] = await h.sql<{ push_fehler: string | null; pushed_qty: number | null }[]>`
      select push_fehler, pushed_qty from shopify_zweitangebote where shopify_variant_id = 'gid://shopify/ProductVariant/404404'`
    assert.match(abgelehnt.push_fehler ?? '', /not stocked at the location/)
    assert.equal(abgelehnt.pushed_qty, null)

    // Dieselbe Menge wird nicht bei jedem Abgleich erneut abgelehnt.
    const ruhig = new Date()
    await inventarAbgleichen()
    assert.deepEqual(await meldungenSeit(ruhig), [])
  })

  test('Webhook des Shops zum Zweitangebot: zu viel → sofort korrigieren', async () => {
    const { verarbeiteInventarWebhook } = await import('../../src/modules/integrationen/inventar.ts')
    assert.match(
      await verarbeiteInventarWebhook({ inventory_item_id: 9601, available: 50 }),
      /Abweichung beim Zweitangebot ZW-KB: Shop 50, ERP 5 — Abgleich angestoßen/,
    )
    assert.match(
      await verarbeiteInventarWebhook({ inventory_item_id: 9601, available: 1 }),
      /im Shop niedriger/,
    )
  })

  test('die Shop-Verfügbarkeit zeigt das Zweitangebot mit Soll, Meldung und Ablehnung', async () => {
    const { shopVerfuegbarkeit } = await import('../../src/modules/integrationen/shop-verfuegbarkeit.ts')
    const d = await shopVerfuegbarkeit()
    const liste = d.zweitangebote.map((z) => [z.produkt, z.soll, z.fehler ? 'abgelehnt' : 'ok'])
    assert.deepEqual(liste, [['Altes Bundle', 5, 'abgelehnt'], ['Test Black Week Editions', 5, 'ok']])
  })
})
