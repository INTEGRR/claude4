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

async function modus(m: 'lesen' | 'schreiben'): Promise<void> {
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
