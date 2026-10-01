/**
 * Der Staging-Schalter der Shopify-Anbindung durch die echte Naht: Im
 * Lesemodus weist shopifyGraphQL() jede Mutation ab — vor der Konfigurations-
 * prüfung, also ohne Zugangsdaten und ohne Netz —, die Outbox hakt einen so
 * abgewiesenen Schreibjob als erledigt-übersprungen ab (nicht als
 * gescheitert), und er läuft nach dem Umschalten nicht nach. Der Fake sitzt
 * VOR dem Wächter (er hat keinen Shop zu schützen); deshalb schaltet dieser
 * Test den Fake für den Lesepfad aus und für den Schreibnachweis wieder ein.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import {
  ShopifyError,
  ShopifyNurLesen,
  ShopifyProbelauf,
  addOrderTags,
} from '../../src/modules/integrationen/shopify.ts'
import { runDueJobs } from '../../src/modules/integrationen/jobs.ts'

const DATENBANK = 'erp_shopify_modus_check'
let h: Harness

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

describe('Shopify nur lesen: eine Naht für alle Mutationen', () => {
  test('im Lesemodus wird jede Mutation abgewiesen und protokolliert, im Schreibmodus kommt sie durch', async () => {
    process.env.SHOPIFY_FAKE = '0'
    await modus('lesen')
    await assert.rejects(
      addOrderTags('gid://shopify/Order/1', ['krnl']),
      (e: unknown) => e instanceof ShopifyNurLesen && /nur lesen/.test((e as Error).message),
    )
    const [tx] = await h.sql<{ ok: boolean; error: string | null }[]>`
      select ok, error from api_transactions
      where system = 'shopify' order by created_at desc limit 1`
    assert.equal(tx.ok, false, 'die abgewiesene Mutation steht im Transaktionsprotokoll')
    assert.match(tx.error ?? '', /nur lesen/)

    // Schreibmodus ohne Fake und ohne Zugangsdaten: der Wächter lässt durch,
    // erst die Konfigurationsprüfung dahinter greift — kein Netz nötig.
    await modus('schreiben')
    await assert.rejects(
      addOrderTags('gid://shopify/Order/1', ['krnl']),
      (e: unknown) =>
        e instanceof ShopifyError && !(e instanceof ShopifyNurLesen) && /nicht konfiguriert/.test(e.message),
    )
  })

  test('die Outbox hakt einen Schreibjob als übersprungen ab — erledigt, nicht gescheitert, kein Nachlauf', async () => {
    process.env.SHOPIFY_FAKE = '0'
    await modus('lesen')
    const [kunde] = await h.sql<{ id: string }[]>`
      insert into partners (name, is_customer) values ('Staging-Kunde', true) returning id`
    const [auftrag] = await h.sql<{ id: string }[]>`
      insert into sales_orders (number, partner_id, shopify_order_id)
      values (next_sequence('sale'), ${kunde.id}, 'gid://shopify/Order/4711') returning id`
    const nutzlast = { sales_order_id: auftrag.id, tags: ['krnl'] }

    const [job] = await h.sql<{ id: string }[]>`
      select enqueue_job('shopify_tag_add', ${h.sql.json(nutzlast)}, 'tag:staging') as id`
    const lauf = await runDueJobs()
    assert.equal(lauf.uebersprungen, 1)
    assert.equal(lauf.failed, 0, 'übersprungen ist kein Fehlschlag')

    const [zeile] = await h.sql<
      { status: string; last_result: string | null; last_error: string | null; dedupe_key: string | null }[]
    >`select status, last_result, last_error, dedupe_key from integration_jobs where id = ${job.id}`
    assert.equal(zeile.status, 'done')
    assert.match(zeile.last_result ?? '', /^Übersprungen: Shopify steht auf „nur lesen"/)
    assert.equal(zeile.last_error, null)
    assert.equal(zeile.dedupe_key, null, 'der Schlüssel ist frei — kein ewig blockierter Job')

    const [ereignis] = await h.sql<{ kind: string; message: string }[]>`
      select kind, message from audit_log where record_id = ${auftrag.id}
      order by created_at desc limit 1`
    assert.equal(ereignis?.kind, 'info', 'am Beleg steht ein Info-, kein Fehler-Ereignis')
    assert.match(ereignis?.message ?? '', /übersprungen/)

    // Umschalten: der alte Job läuft NICHT nach, ein neuer läuft durch (Fake).
    await modus('schreiben')
    process.env.SHOPIFY_FAKE = '1'
    const [neu] = await h.sql<{ id: string }[]>`
      select enqueue_job('shopify_tag_add', ${h.sql.json(nutzlast)}, 'tag:staging') as id`
    assert.ok(neu.id, 'gleicher Schlüssel wieder frei')
    const zweiter = await runDueJobs()
    assert.equal(zweiter.succeeded, 1)
    assert.equal(zweiter.uebersprungen, 0)
    const [ergebnis] = await h.sql<{ last_result: string | null }[]>`
      select last_result from integration_jobs where id = ${neu.id}`
    assert.match(ergebnis.last_result ?? '', /^Tags gesetzt/)
  })
})

describe('Shopify-Probelauf (0102): wie scharf, aber nichts senden', () => {
  test('eine Mutation geht nicht raus, steht als „würde senden" im Protokoll, der Job ist erledigt', async () => {
    process.env.SHOPIFY_FAKE = '0'
    await modus('probe')
    await assert.rejects(
      addOrderTags('gid://shopify/Order/1', ['krnl']),
      (e: unknown) => e instanceof ShopifyProbelauf && /würde jetzt an Shopify gehen/.test((e as Error).message),
    )
    const [tx] = await h.sql<{ kind: string; ok: boolean; request: { variables: { tags: string[] } } }[]>`
      select kind, ok, request from api_transactions where system = 'shopify' order by created_at desc limit 1`
    assert.equal(tx.kind, 'probe:tagsAdd')
    assert.deepEqual(tx.request.variables.tags, ['krnl'], 'was gesendet worden wäre, steht vollständig drin')

    const [kunde] = await h.sql<{ id: string }[]>`
      insert into partners (name, is_customer) values ('Probe-Kunde', true) returning id`
    const [auftrag] = await h.sql<{ id: string }[]>`
      insert into sales_orders (number, partner_id, shopify_order_id)
      values (next_sequence('sale'), ${kunde.id}, 'gid://shopify/Order/4712') returning id`
    const [job] = await h.sql<{ id: string }[]>`
      select enqueue_job('shopify_tag_add', ${h.sql.json({ sales_order_id: auftrag.id, tags: ['krnl'] })}, 'tag:probe') as id`
    const lauf = await runDueJobs()
    assert.deepEqual([lauf.uebersprungen, lauf.failed], [1, 0])
    const [zeile] = await h.sql<{ status: string; last_result: string }[]>`
      select status, last_result from integration_jobs where id = ${job.id}`
    assert.equal(zeile.status, 'done')
    assert.match(zeile.last_result, /^Probelauf — tagsAdd würde/)
  })

  test('Bestandsabgleich im Probelauf: nur Änderungen, eigener Probe-Stand, echter Stand bleibt leer', async () => {
    process.env.SHOPIFY_FAKE = '1'
    await modus('probe')
    const [uom] = await h.sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
    const [tpl] = await h.sql<{ id: string }[]>`
      insert into product_templates (name, uom_id, can_be_sold) values ('Probe-Deskmat', ${uom.id}, true) returning id`
    await h.sql`select generate_variants(${tpl.id})`
    const [v] = await h.sql<{ id: string }[]>`
      update product_variants set shopify_variant_id = 'gid://shopify/ProductVariant/7001', sku = 'PROBE-DM'
      where template_id = ${tpl.id} returning id`
    const lagern = async (menge: number) => {
      const [lager] = await h.sql<{ id: string }[]>`select id from stock_locations where full_path = 'WH/Stock'`
      const [ist] = await h.sql<{ n: number }[]>`select coalesce(sum(on_hand), 0)::float as n from stock_quants where variant_id = ${v.id} and location_id = ${lager.id}`
      const [z] = await h.sql<{ id: string }[]>`
        insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
        values (${lager.id}, ${v.id}, ${menge}, ${ist.n}) returning id`
      await h.sql`select inventory_apply(${z.id}, 'test')`
    }
    await lagern(12)
    const { inventarAbgleichen } = await import('../../src/modules/integrationen/inventar.ts')
    const probeEintraege = async () =>
      h.sql<{ request: { aenderungen: { sku: string; vorher: number | null; neu: number }[] } }[]>`
        select request from api_transactions where kind = 'probe:inventorySetQuantities' order by created_at desc`

    await inventarAbgleichen()
    const [erster] = await probeEintraege()
    assert.deepEqual(erster.request.aenderungen.find((a) => a.sku === 'PROBE-DM'), { sku: 'PROBE-DM', name: 'Probe-Deskmat', vorher: null, neu: 12 })

    const vorher = (await probeEintraege()).length
    await inventarAbgleichen()
    assert.equal((await probeEintraege()).length, vorher, 'nichts geändert — kein neuer Eintrag')

    await lagern(9)
    await inventarAbgleichen()
    const [zweiter] = await probeEintraege()
    assert.deepEqual(zweiter.request.aenderungen, [{ sku: 'PROBE-DM', name: 'Probe-Deskmat', vorher: 12, neu: 9 }])

    const [stand] = await h.sql<{ probe_qty: number; pushed_qty: number | null }[]>`
      select probe_qty::float as probe_qty, pushed_qty from shopify_inventory_state where variant_id = ${v.id}`
    assert.deepEqual({ ...stand }, { probe_qty: 9, pushed_qty: null }, 'beim Scharfschalten wird alles echt gemeldet')
  })

  test('jede KRNL-Aktion stößt im Probelauf den Abgleich an, im Lesemodus nicht', async () => {
    const { aktionAusfuehrenGeprueft } = await import('../../src/modules/prozesse/torwaechter.ts')
    const zaehler = async () =>
      Number((await h.sql<{ n: string | null }[]>`select value ->> 'n' as n from shopify_sync_state where key = 'inventar_anstoss'`)[0]?.n ?? 0)
    const ADMIN = { name: 'probe-test', role: 'admin' as const }
    const [t] = await h.sql<{ id: string }[]>`select id from product_templates where name = 'Probe-Deskmat'`

    await modus('lesen')
    const a = await zaehler()
    await aktionAusfuehrenGeprueft('verkauf.shop_artikel_setzen', { parameter: { template_id: t.id, projekt: 'X' } }, ADMIN)
    // shop_artikel_setzen stößt selbst an — darum eine Aktion ohne eigenen Anstoß:
    await aktionAusfuehrenGeprueft('verkauf.shop_stand_holen', {}, ADMIN)
    const b = await zaehler()
    await modus('probe')
    await aktionAusfuehrenGeprueft('verkauf.shop_stand_holen', {}, ADMIN)
    assert.equal(await zaehler(), b + 1, 'Probelauf: Anstoß nach der Aktion')
    assert.equal(b, a + 1, 'Lesemodus: nur der eigene Anstoß der Regel-Aktion, keiner vom Torwächter')
    await modus('lesen')
  })
})
