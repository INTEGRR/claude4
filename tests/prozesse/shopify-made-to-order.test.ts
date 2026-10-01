/**
 * Made-to-Order an Shopify (0100) gegen die echte Datenbank und die
 * Shopify-Attrappe: Tastaturen (Route Fertigen + Auf Auftrag) melden die
 * baubare Menge, normale Artikel den freien Bestand; die erste Meldung
 * richtet die Tastatur in Shopify ein (Menge verfolgen, nicht ohne Bestand
 * verkaufen); eine Bestellung senkt die Meldung über den Anstoß; ein
 * laufender Abgleich sperrt den zweiten; die Rückmeldung des Shops setzt nie
 * still hoch.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'

const DATENBANK = 'erp_shopify_mto_check'
let h: Harness
const v: Record<string, string> = {}

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

async function artikel(name: string, opts: { gid?: string; mto?: boolean; bestand?: number } = {}): Promise<string> {
  const [uom] = await h.sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await h.sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, can_be_sold, route_manufacture, route_mto)
    values (${name}, ${uom.id}, true, ${opts.mto ?? false}, ${opts.mto ?? false}) returning id`
  await h.sql`select generate_variants(${tpl.id})`
  const [variante] = await h.sql<{ id: string }[]>`
    update product_variants set shopify_variant_id = ${opts.gid ?? null}
    where template_id = ${tpl.id} returning id`
  if (opts.bestand) {
    const [lager] = await h.sql<{ id: string }[]>`select id from stock_locations where full_path = 'WH/Stock'`
    const [z] = await h.sql<{ id: string }[]>`
      insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
      values (${lager.id}, ${variante.id}, ${opts.bestand}, 0) returning id`
    await h.sql`select inventory_apply(${z.id}, 'test')`
  }
  return variante.id
}

const stand = async (variante: string) =>
  (await h.sql<{ gemeldet: number | null; eingerichtet: boolean }[]>`
    select pushed_qty::float as gemeldet, mto_eingerichtet_at is not null as eingerichtet
    from shopify_inventory_state where variant_id = ${variante}`)[0]

describe('Made-to-Order: baubare Menge an Shopify', () => {
  test('Vorbereitung: Tastatur auf Auftrag mit Stückliste, Deskmat als Lagerware', async () => {
    await h.sql`insert into settings (key, value) values ('shopify', ${h.sql.json({ modus: 'schreiben' })})
                on conflict (key) do update set value = excluded.value`
    v.gehaeuse = await artikel('Gehäuse MTO', { bestand: 5 })
    v.switch = await artikel('Switch MTO', { bestand: 870 })
    v.tastatur = await artikel('Tastatur MTO', { gid: 'gid://shopify/ProductVariant/501', mto: true })
    v.deskmat = await artikel('Deskmat MTO', { gid: 'gid://shopify/ProductVariant/502', bestand: 7 })
    const [tpl] = await h.sql<{ template_id: string; uom_id: string }[]>`
      select pv.template_id, pt.uom_id from product_variants pv join product_templates pt on pt.id = pv.template_id
      where pv.id = ${v.tastatur}`
    const [bom] = await h.sql<{ id: string }[]>`
      insert into boms (template_id, qty, uom_id) values (${tpl.template_id}, 1, ${tpl.uom_id}) returning id`
    await h.sql`insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
                values (${bom.id}, 10, ${v.gehaeuse}, 1, ${tpl.uom_id}), (${bom.id}, 20, ${v.switch}, 87, ${tpl.uom_id})`
  })

  test('erster Abgleich: baubar − Puffer für die Tastatur, Bestand für die Deskmat, Tastatur eingerichtet', async () => {
    const { inventarAbgleichen } = await import('../../src/modules/integrationen/inventar.ts')
    const { fakeLetzterAufruf } = await import('../../src/modules/integrationen/shopify-fake.ts')
    const r = await inventarAbgleichen()
    assert.deepEqual([r.gesperrt, r.uebertragen, r.runden], [false, 2, 1])

    const aufruf = fakeLetzterAufruf('inventorySetQuantities') as
      | { input: { quantities: { inventoryItemId: string; quantity: number }[] } }
      | undefined
    assert.ok(aufruf, 'Bestand wurde gemeldet')
    const mengen = Object.fromEntries(aufruf.input.quantities.map((q) => [q.inventoryItemId, q.quantity]))
    assert.deepEqual(mengen, {
      'gid://shopify/InventoryItem/501': 3, // 5 Gehäuse baubar − Puffer 2
      'gid://shopify/InventoryItem/502': 7,
    })
    assert.deepEqual(fakeLetzterAufruf('productVariantsBulkUpdate'), {
      productId: 'gid://shopify/Product/501',
      variants: [{ id: 'gid://shopify/ProductVariant/501', inventoryPolicy: 'DENY', inventoryItem: { tracked: true } }],
    })
    assert.deepEqual({ ...(await stand(v.tastatur)) }, { gemeldet: 3, eingerichtet: true })
    assert.deepEqual({ ...(await stand(v.deskmat)) }, { gemeldet: 7, eingerichtet: false }, 'Lagerware wird nicht umgestellt')

    const zweiter = await inventarAbgleichen()
    assert.equal(zweiter.uebertragen, 0, 'nichts geändert — kein API-Aufruf')
  })

  test('eine Bestellung senkt die Meldung sofort: Anstoß → Job → neue Menge', async () => {
    // Wie confirm_sales_order bei Route Auf Auftrag: der Fertigungsauftrag reserviert die Teile.
    const [mo] = await h.sql<{ id: string }[]>`select create_manufacturing_order(${v.tastatur}, 2) as id`
    await h.sql`select mo_confirm(${mo.id})`
    await h.sql`select inventar_abgleich_anstossen()`
    const { runDueJobs } = await import('../../src/modules/integrationen/jobs.ts')
    await runDueJobs()
    const [job] = await h.sql<{ last_result: string }[]>`
      select last_result from integration_jobs where kind = 'shopify_inventory_push' order by created_at desc limit 1`
    assert.match(job.last_result, /Bestand gemeldet: 1 Änderung/)
    assert.equal((await stand(v.tastatur)).gemeldet, 1, '3 baubar − Puffer 2')
  })

  test('ein laufender Abgleich sperrt den zweiten (der laufende rechnet nach)', async () => {
    const { inventarAbgleichen } = await import('../../src/modules/integrationen/inventar.ts')
    await h.sql`insert into shopify_sync_state (key, value)
                values ('inventar_sperre', jsonb_build_object('bis', now() + interval '60 seconds'))
                on conflict (key) do update set value = excluded.value`
    assert.equal((await inventarAbgleichen()).gesperrt, true)
    await h.sql`update shopify_sync_state set value = jsonb_build_object('bis', now()) where key = 'inventar_sperre'`
    assert.equal((await inventarAbgleichen()).gesperrt, false)
  })

  test('Rückmeldung des Shops: zu viel → sofort korrigieren, zu wenig → nie still hochsetzen', async () => {
    const { verarbeiteInventarWebhook, inventarAbgleichen } = await import('../../src/modules/integrationen/inventar.ts')
    const zaehler = async () =>
      Number((await h.sql<{ n: string }[]>`select value ->> 'n' as n from shopify_sync_state where key = 'inventar_anstoss'`)[0].n)

    const vorher = await zaehler()
    assert.match(await verarbeiteInventarWebhook({ inventory_item_id: 501, available: 9 }), /angestoßen/)
    assert.equal(await zaehler(), vorher + 1)

    // Shopify hat eine Bestellung abgezogen, die KRNL noch nicht kennt: nicht zurücksetzen.
    assert.match(await verarbeiteInventarWebhook({ inventory_item_id: 501, available: 0 }), /nächsten Abgleich/)
    assert.equal(await zaehler(), vorher + 1, 'kein Anstoß')
    assert.equal((await stand(v.tastatur)).gemeldet, 0, 'Shop-Stand gemerkt')
    // Der nächste reguläre Abgleich setzt wieder die richtige Menge.
    assert.equal((await inventarAbgleichen()).uebertragen, 1)
    assert.equal((await stand(v.tastatur)).gemeldet, 1)
  })

  test('Shopify-Bestellung per Webhook: Import → Fertigungsauftrag → Anstoß → Meldung, ohne Cron', async () => {
    const { fakeOrderHinterlegen } = await import('../../src/modules/integrationen/shopify-fake.ts')
    const { processPendingWebhooks } = await import('../../src/modules/integrationen/import.ts')
    const { runDueJobs } = await import('../../src/modules/integrationen/jobs.ts')
    await h.sql`update product_variants set sku = 'MTO-KB' where id = ${v.tastatur}`
    const gid = 'gid://shopify/Order/880001'
    fakeOrderHinterlegen({
      id: gid, name: '#880001', createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z',
      email: 'release@example.com', tags: [], displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED',
      cancelledAt: null, taxesIncluded: true, customer: null,
      totalPriceSet: { shopMoney: { amount: '149.00', currencyCode: 'EUR' } },
      shippingAddress: { name: 'Release Kunde', address1: 'Weg 1', address2: null, zip: '10115', city: 'Berlin', countryCodeV2: 'DE', phone: null },
      shippingLine: { discountedPriceSet: { shopMoney: { amount: '0.00' } }, taxLines: [] },
      lineItems: { nodes: [{
        id: 'gid://shopify/LineItem/880001', title: 'Tastatur MTO', sku: 'MTO-KB', quantity: 1, currentQuantity: 1, variant: null,
        originalUnitPriceSet: { shopMoney: { amount: '149.00' } },
        discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '149.00' } }, taxLines: [{ rate: 0.19 }],
      }] },
    } as never)
    await h.sql`insert into shopify_webhook_events (webhook_id, topic, shopify_order_id, payload)
                values ('release-1', 'orders/create', ${gid}, '{}'::jsonb)`

    // Wie der Webhook-Endpunkt nach der Antwort: verarbeiten, dann Jobs.
    const r = await processPendingWebhooks(5)
    assert.equal(r.processed, 1)
    const [mo] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from manufacturing_orders mo join sales_orders so on so.id = mo.sales_order_id
      where so.shopify_order_id = ${gid}`
    assert.equal(mo.n, 1, 'Route Auf Auftrag: Fertigungsauftrag reserviert die Teile')
    await runDueJobs()
    assert.equal((await stand(v.tastatur)).gemeldet, 0, '2 baubar − Puffer 2: ausverkauft, ohne auf den Cron zu warten')
  })
})
