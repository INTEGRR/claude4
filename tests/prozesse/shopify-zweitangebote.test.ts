/**
 * Bestand an Shopify-Zweitangebote (0106, Entscheidungslog 2026-10-01) gegen
 * die echte Datenbank und die Shopify-Attrappe: Ein Artikel mit einem
 * weiteren Shop-Angebot derselben SKU (Bundle-Bestandteil „Black Week
 * Editions") meldet an BEIDE Angebote — seit 0136 teilen sie sich den
 * Bestand (Kontingent), statt ihn doppelt anzubieten. Je Angebot steuerbar (aus = 0), im
 * Probelauf nur „würde senden", im Modus „nur lesen" geht nichts hinaus,
 * eine Ablehnung durch Shopify blockiert die Artikel nicht.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'
import { fakeBestand } from '../../src/modules/integrationen/shopify-fake.ts'

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

/** Was die Attrappe gerade als Bestand führt — nach absoluten Meldungen und Differenzen. */
const shop = (n: number): number | undefined => fakeBestand(`gid://shopify/InventoryItem/${n}`)

/** Zahl der Bestands-Aufrufe (absolut oder Differenz) an die Attrappe seit dem Zeitpunkt. */
async function aufrufeSeit(seit: Date): Promise<number> {
  const [{ n }] = await h.sql<{ n: number }[]>`
    select count(*)::int as n from api_transactions
    where kind in ('fake:inventorySetQuantities', 'fake:inventoryAdjustQuantities') and created_at > ${seit}`
  return Number(n)
}

/** Differenz-Meldungen seit dem Zeitpunkt: je Aufruf InventoryItem → Differenz. */
async function differenzenSeit(seit: Date): Promise<Record<string, number>[]> {
  const zeilen = await h.sql<{ request: { variables: { input: { changes: { inventoryItemId: string; delta: number }[] } } } }[]>`
    select request from api_transactions
    where kind = 'fake:inventoryAdjustQuantities' and created_at > ${seit} order by created_at, id`
  return zeilen.map((z) =>
    Object.fromEntries(z.request.variables.input.changes.map((q) => [q.inventoryItemId, q.delta])),
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
    assert.match(r.text ?? '', /1 Zweitangebot mit derselben SKU/)

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

  test('eine Variante mit Zweitangebot: beide Angebote TEILEN sich den Bestand (0136) — nie doppelt angeboten', async () => {
    const { inventarAbgleichen } = await import('../../src/modules/integrationen/inventar.ts')
    const r = await inventarAbgleichen()
    assert.deepEqual(
      [r.uebertragen, r.angebote, r.angeboteUebertragen, r.angeboteAbgelehnt],
      [1, 1, 1, 0],
    )
    // 4 Stück da: 2 am Artikel, 2 am Zweitangebot — zusammen nie mehr als 4.
    assert.deepEqual([shop(601), shop(9601)], [2, 2])
    const [stand] = await h.sql<{ pushed_qty: number }[]>`select pushed_qty from shopify_zweitangebote where id = ${angebot}`
    assert.equal(stand.pushed_qty, 2)

    const leer = new Date()
    assert.equal((await inventarAbgleichen()).angeboteUebertragen, 0, 'nichts geändert — kein Aufruf')
    assert.equal(await aufrufeSeit(leer), 0)

    // Bestand sinkt: beide Angebote folgen — als Differenz, nicht als absolute Menge.
    await bestand(artikel, 2)
    const danach = new Date()
    await inventarAbgleichen()
    assert.deepEqual([shop(601), shop(9601)], [1, 1])
    assert.deepEqual(await differenzenSeit(danach), [
      { 'gid://shopify/InventoryItem/601': -1, 'gid://shopify/InventoryItem/9601': -1 },
    ])
  })

  test('der Job nennt die Zweitangebote', async () => {
    // 3 Stück: 2 + 1 — nur der Artikel ändert sich.
    await bestand(artikel, 3)
    await h.sql`select inventar_abgleich_anstossen()`
    const { runDueJobs } = await import('../../src/modules/integrationen/jobs.ts')
    await runDueJobs()
    const [job] = await h.sql<{ last_result: string }[]>`
      select last_result from integration_jobs where kind = 'shopify_inventory_push' order by updated_at desc limit 1`
    assert.match(job.last_result, /Bestand gemeldet: 1 Änderung.*; Zweitangebote: 0 von 1 gemeldet/)
    assert.deepEqual([shop(601), shop(9601)], [2, 1])
  })

  test('je Angebot steuerbar: „aus" nimmt dem Zweitangebot alles — der Artikel bekommt den Anteil dazu', async () => {
    const { inventarAbgleichen } = await import('../../src/modules/integrationen/inventar.ts')
    const r = await aktionAusfuehrenGeprueft(
      'verkauf.shop_zweitangebot_setzen', { parameter: { angebot_id: angebot, modus: 'aus' } }, ADMIN)
    assert.match(r.text ?? '', /„Test Black Week Editions" .*: aus \(ausverkauft\)/)
    const seit = new Date()
    await inventarAbgleichen()
    assert.deepEqual([shop(601), shop(9601)], [3, 0])
    // Erst senken, dann heben — die Summe liegt nie über dem Bestand.
    assert.deepEqual(await differenzenSeit(seit), [
      { 'gid://shopify/InventoryItem/9601': -1 },
      { 'gid://shopify/InventoryItem/601': 1 },
    ])

    await aktionAusfuehrenGeprueft(
      'verkauf.shop_zweitangebot_setzen', { parameter: { angebot_id: angebot, modus: 'auto' } }, ADMIN)
    await inventarAbgleichen()
    assert.deepEqual([shop(601), shop(9601)], [2, 1])
  })

  test('Probelauf: nur „würde senden" — auch fürs Zweitangebot, echter Stand bleibt', async () => {
    const { inventarAbgleichen } = await import('../../src/modules/integrationen/inventar.ts')
    await modus('probe')
    await bestand(artikel, 7)
    const seit = new Date()
    await inventarAbgleichen()
    assert.equal(await aufrufeSeit(seit), 0, 'nichts an Shopify')
    const eintraege = await h.sql<{ request: { zweitangebote?: boolean; aenderungen: { sku: string; angebot?: string; neu: number }[] } }[]>`
      select request from api_transactions where kind = 'probe:inventorySetQuantities' and created_at > ${seit}
      order by created_at, id`
    assert.equal(eintraege.length, 2, 'zwei Einträge: Artikel und Zweitangebote')
    // 7 Stück: 4 + 3.
    assert.deepEqual(eintraege[0].request.aenderungen.map((a) => [a.sku, a.neu]), [['ZW-KB', 4]])
    assert.equal(eintraege[1].request.zweitangebote, true)
    assert.deepEqual(
      eintraege[1].request.aenderungen.map((a) => [a.sku, a.angebot, a.neu]),
      [['ZW-KB', 'Test Black Week Editions', 3]],
    )
    const [stand] = await h.sql<{ pushed_qty: number; probe_qty: number }[]>`
      select pushed_qty, probe_qty from shopify_zweitangebote where id = ${angebot}`
    assert.deepEqual({ ...stand }, { pushed_qty: 1, probe_qty: 3 }, 'das Buch bleibt — beim Scharfschalten wird echt gemeldet')

    const { probeZeile } = await import('../../src/modules/integrationen/probe-anzeige.ts')
    assert.equal(
      probeZeile('probe:inventorySetQuantities', eintraege[1].request).titel,
      'Bestand an Zweitangebote: 1 Änderung (erste vollständige Meldung)',
    )
  })

  test('nur lesen: auch ans Zweitangebot geht nichts hinaus — das Buch bleibt', async () => {
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
    assert.equal(stand.pushed_qty, 1, 'unverändert — eine gescheiterte Erhöhung nimmt das Buch zurück')
  })

  test('Shopify lehnt ein Zweitangebot ab: der Artikel und die übrigen Angebote kommen trotzdem an', async () => {
    const { inventarAbgleichen } = await import('../../src/modules/integrationen/inventar.ts')
    await modus('schreiben')
    // Zweites Angebot, dessen InventoryItem am Standort nicht geführt wird.
    await h.sql`insert into shopify_zweitangebote (variant_id, shopify_variant_id, shopify_inventory_item_gid, produkt, sku)
                values (${artikel}, 'gid://shopify/ProductVariant/404404', 'gid://shopify/InventoryItem/404404', 'Altes Bundle', 'ZW-KB')`
    // 9 Stück auf drei Angebote: je 3.
    await bestand(artikel, 9)
    const r = await inventarAbgleichen()
    assert.deepEqual([r.uebertragen, r.angeboteUebertragen, r.angeboteAbgelehnt], [1, 1, 1])
    assert.deepEqual([shop(601), shop(9601), shop(404404)], [3, 3, undefined])
    const [abgelehnt] = await h.sql<{ push_fehler: string | null; pushed_qty: number | null }[]>`
      select push_fehler, pushed_qty from shopify_zweitangebote where shopify_variant_id = 'gid://shopify/ProductVariant/404404'`
    assert.match(abgelehnt.push_fehler ?? '', /not stocked at the location/)
    assert.equal(abgelehnt.pushed_qty, null)

    // Dieselbe Menge wird nicht bei jedem Abgleich erneut abgelehnt.
    const ruhig = new Date()
    await inventarAbgleichen()
    assert.equal(await aufrufeSeit(ruhig), 0)
  })

  test('Webhook des Shops zum Zweitangebot: mehr als das Buch → Buch übernimmt, Abgleich senkt', async () => {
    const { verarbeiteInventarWebhook } = await import('../../src/modules/integrationen/inventar.ts')
    assert.match(
      await verarbeiteInventarWebhook({ inventory_item_id: 9601, available: 50 }),
      /Abweichung beim Zweitangebot ZW-KB: Shop 50, Buch 3 — Buch übernimmt den Shop-Stand, Abgleich angestoßen/,
    )
    assert.match(
      await verarbeiteInventarWebhook({ inventory_item_id: 9601, available: 1 }),
      /im Shop niedriger: Shop 1, Buch 50 — Bestellung unterwegs/,
    )
  })

  test('die Shop-Verfügbarkeit zeigt das Zweitangebot mit Soll, Meldung und Ablehnung', async () => {
    const { shopVerfuegbarkeit } = await import('../../src/modules/integrationen/shop-verfuegbarkeit.ts')
    const d = await shopVerfuegbarkeit()
    const liste = d.zweitangebote.map((z) => [z.produkt, z.soll, z.fehler ? 'abgelehnt' : 'ok'])
    // Soll ist das Kontingent (0136): 9 Stück auf drei Angebote.
    assert.deepEqual(liste, [['Altes Bundle', 3, 'abgelehnt'], ['Test Black Week Editions', 3, 'ok']])
  })
})
