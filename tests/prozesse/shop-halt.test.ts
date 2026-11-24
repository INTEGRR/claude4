/**
 * Fulfillment-Halt aus Shopify (0134, Entscheidungslog 2026-11-24): Wird
 * eine Bestellung im Shop angehalten („Kabel muss noch rein", Kunde möchte
 * warten), sperrt KRNL den Versand — Label, Packtisch, Versandliste und das
 * Ausbuchen in der Datenbank. Gesetzt und aufgehoben wird nur im Shop.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'
import { fakeHaltSetzen, fakeOrderHinterlegen } from '../../src/modules/integrationen/shopify-fake.ts'
import { processPendingWebhooks } from '../../src/modules/integrationen/import.ts'
import { packtischBelegLaden } from '../../src/modules/versand/packtisch-beleg.ts'
import { angehalteneLieferungen } from '../../src/modules/versand/angehalten.ts'

const DATENBANK = 'erp_shop_halt_check'
const ADMIN = { name: 'halt-test', role: 'admin' as const }
let h: Harness
let webhookNr = 0
let letzteMeldung = ''

const aktion = (name: string, recordId: string | undefined, parameter: Record<string, unknown> = {}) =>
  aktionAusfuehrenGeprueft(name, { recordId, parameter }, ADMIN)

const gid = (nr: number) => `gid://shopify/Order/${nr}`

function bestellung(nr: number, versandStatus = 'UNFULFILLED') {
  return {
    id: gid(nr), name: `#${nr}`, createdAt: '2026-11-20T10:00:00Z', updatedAt: '2026-11-20T10:00:00Z',
    email: 'kunde@example.com', tags: [], displayFinancialStatus: 'PAID', displayFulfillmentStatus: versandStatus,
    cancelledAt: null, taxesIncluded: true, paymentGatewayNames: ['shopify_payments'],
    customer: { id: 'gid://shopify/Customer/6140', firstName: 'Jan', lastName: 'Halt', defaultEmailAddress: { emailAddress: 'kunde@example.com' } },
    totalPriceSet: { shopMoney: { amount: '34.51', currencyCode: 'EUR' } },
    currentTotalPriceSet: { shopMoney: { amount: '34.51' } },
    totalOutstandingSet: { shopMoney: { amount: '0.00' } },
    shippingAddress: { name: 'Jan Halt', address1: 'Am Markt 3', address2: null, zip: '32457', city: 'Porta Westfalica', countryCodeV2: 'DE', phone: null },
    billingAddress: { name: 'Jan Halt', company: null, address1: 'Am Markt 3', address2: null, zip: '32457', city: 'Porta Westfalica', countryCodeV2: 'DE' },
    shippingLine: null,
    lineItems: {
      nodes: [{
        id: `gid://shopify/LineItem/${nr}-0`, title: 'Deskmat', variantTitle: null, sku: 'HALT-MAT',
        quantity: 1, currentQuantity: 1, variant: null,
        originalUnitPriceSet: { shopMoney: { amount: '34.51' } },
        discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '34.51' } }, taxLines: [{ rate: 0.19 }],
      }],
    },
  }
}

/** Bestell-Webhook (orders/…) — verarbeitet wie im Betrieb. */
async function bestellWebhook(nr: number, topic = 'orders/updated'): Promise<void> {
  await h.sql`insert into shopify_webhook_events (webhook_id, topic, shopify_order_id, payload)
              values (${`halt-${++webhookNr}`}, ${topic}, ${gid(nr)}, '{}'::jsonb)`
  await verarbeiten()
}

/** Halt-Webhook: nennt nur den Fulfillment-Auftrag, keine Bestellung. */
async function haltWebhook(nr: number, topic: 'fulfillment_orders/placed_on_hold' | 'fulfillment_orders/hold_released'): Promise<void> {
  await h.sql`insert into shopify_webhook_events (webhook_id, topic, shopify_order_id, payload)
              values (${`halt-${++webhookNr}`}, ${topic}, null,
                      ${h.sql.json({ fulfillment_order: { id: `gid://shopify/FulfillmentOrder/${nr}`, status: 'on_hold' } })})`
  await verarbeiten()
}

async function verarbeiten(): Promise<void> {
  const r = await processPendingWebhooks(5)
  const [ev] = await h.sql<{ status: string; error: string | null }[]>`
    select status::text as status, error from shopify_webhook_events where webhook_id = ${`halt-${webhookNr}`}`
  assert.equal(r.failed, 0, `Webhook ohne Fehler: ${ev.error ?? ''}`)
  assert.equal(ev.status, 'done', `Webhook verarbeitet: ${ev.error ?? ''}`)
  letzteMeldung = ev.error ?? ''
}

async function auftrag(nr: number) {
  const [so] = await h.sql<{ id: string; halt: boolean; grund: string | null; notiz: string | null; seit: string | null }[]>`
    select id, shopify_halt as halt, shopify_halt_grund as grund, shopify_halt_notiz as notiz,
           shopify_halt_seit::text as seit
    from sales_orders where shopify_order_id = ${gid(nr)}`
  return so
}

async function lieferung(nr: number) {
  const [p] = await h.sql<{ id: string; number: string; state: string }[]>`
    select p.id, p.number, p.state::text as state from stock_pickings p
    join sales_orders so on so.id = p.origin_id and p.origin_model = 'sales_order'
    where so.shopify_order_id = ${gid(nr)}`
  return p
}

async function versandbereit(nr: number): Promise<boolean> {
  const [{ n }] = await h.sql<{ n: number }[]>`
    select count(*)::int as n from shipping_ready where shopify_order_name = ${`#${nr}`}`
  return Number(n) > 0
}

before(async () => {
  h = await harnessStart(DATENBANK)
  await aktion('einstellungen.shopify_modus_setzen', undefined, { modus: 'schreiben' })
  const r = await aktion('produkte.produkt_anlegen', undefined, {
    name: 'Deskmat Halt', sku: 'HALT-MAT', verkaufspreis: 29, einstandspreis: 9, gewicht_g: 500,
    verkaufbar: true, einkaufbar: true, route: 'kaufen', attribute: [],
  })
  const [pv] = await h.sql<{ id: string }[]>`select id from product_variants where template_id = ${r.recordId!}`
  const z = await aktion('lager.zaehlung_erfassen', undefined, { variant_id: pv.id, counted_qty: 10 })
  await aktion('lager.zaehlung_buchen', z.recordId)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

describe('Fulfillment-Halt aus Shopify sperrt den Versand', () => {
  test('Halt-Webhook: Auftrag angehalten mit Grund und Notiz, nicht mehr versandbereit', async () => {
    fakeOrderHinterlegen(bestellung(6140) as never)
    await bestellWebhook(6140, 'orders/create')
    assert.equal((await auftrag(6140)).halt, false)
    assert.equal(await versandbereit(6140), true, 'ohne Halt versandbereit')

    fakeHaltSetzen(gid(6140), [{ reason: 'OTHER', reasonNotes: 'Kabel beilegen' }])
    await haltWebhook(6140, 'fulfillment_orders/placed_on_hold')
    assert.match(letzteMeldung, /#6140 in Shopify angehalten \(Sonstiges: Kabel beilegen\)/)

    const a = await auftrag(6140)
    assert.deepEqual([a.halt, a.grund, a.notiz], [true, 'Sonstiges', 'Kabel beilegen'])
    assert.ok(a.seit, 'Beginn des Halts steht am Auftrag')
    assert.equal(await versandbereit(6140), false, 'angehalten = nicht versandbereit')
    const liste = await angehalteneLieferungen()
    assert.deepEqual(liste.map((l) => [l.shopify, l.grund, l.notiz]), [['#6140', 'Sonstiges', 'Kabel beilegen']])
    // Die Reservierung bleibt: die Ware geht nicht an andere.
    assert.equal((await lieferung(6140)).state, 'assigned')

    const [ev] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from audit_log where model = 'sales_order' and record_id = ${a.id}
        and message like 'In Shopify angehalten (Sonstiges: Kabel beilegen)%'`
    assert.notEqual(Number(ev.n), 0, 'der Halt steht im Verlauf des Auftrags')
  })

  test('angehalten: Packtisch, Label und Ausbuchen verweigern mit Grund', async () => {
    const p = await lieferung(6140)
    const pack = await packtischBelegLaden(p.number)
    assert.equal(pack.ok, false)
    assert.match(pack.ok ? '' : pack.error, /#6140 ist in Shopify angehalten \(Sonstiges: Kabel beilegen\)/)

    await assert.rejects(aktion('versand.label_erstellen', p.id), /in Shopify angehalten \(Sonstiges: Kabel beilegen\)/)
    // Letzte Sicherung in der Datenbank — gilt für jeden Weg.
    await assert.rejects(
      h.sql`select picking_validate(${p.id}, '{}'::jsonb, false)`,
      /#6140 ist in Shopify angehalten \(Sonstiges: Kabel beilegen\)/,
    )
    assert.equal((await lieferung(6140)).state, 'assigned', 'nichts ausgebucht')
    const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from shipments where picking_id = ${p.id}`
    assert.equal(Number(n), 0, 'kein Label entstanden')
  })

  test('Halt aufgehoben: wieder versandbereit, die Notiz bleibt als Packhinweis, Label geht durch', async () => {
    fakeHaltSetzen(gid(6140), undefined)
    await haltWebhook(6140, 'fulfillment_orders/hold_released')
    assert.match(letzteMeldung, /Halt in Shopify aufgehoben/)

    const a = await auftrag(6140)
    assert.deepEqual([a.halt, a.seit, a.notiz], [false, null, 'Kabel beilegen'])
    assert.equal(await versandbereit(6140), true)
    const p = await lieferung(6140)
    const pack = await packtischBelegLaden(p.number)
    assert.equal(pack.ok, true)
    assert.equal(pack.ok ? pack.doc.packhinweis : null, 'Kabel beilegen')

    await aktion('versand.label_erstellen', p.id)
    assert.equal((await lieferung(6140)).state, 'done')
  })

  test('ohne Webhook: das Label sieht frisch im Shop nach — in beide Richtungen', async () => {
    fakeOrderHinterlegen(bestellung(6141) as never)
    await bestellWebhook(6141, 'orders/create')
    const p = await lieferung(6141)

    // Im Shop eben angehalten, der Webhook kam nie an.
    fakeHaltSetzen(gid(6141), [{ reason: 'INCORRECT_ADDRESS', reasonNotes: null }])
    assert.equal((await auftrag(6141)).halt, false, 'KRNL weiß es noch nicht')
    await assert.rejects(aktion('versand.label_erstellen', p.id), /#6141 ist in Shopify angehalten \(Adresse falsch\)/)
    assert.equal((await auftrag(6141)).halt, true, 'der Halt steht jetzt am Auftrag')

    // Im Shop eben freigegeben, wieder ohne Webhook.
    fakeHaltSetzen(gid(6141), undefined)
    await aktion('versand.label_erstellen', p.id)
    assert.equal((await lieferung(6141)).state, 'done')
    assert.equal((await auftrag(6141)).halt, false)
  })

  test('Recht auf Fulfillment-Aufträge fehlt: der Anzeige-Status der Bestellung entscheidet', async () => {
    fakeOrderHinterlegen(bestellung(6142) as never)
    await bestellWebhook(6142, 'orders/create')
    fakeHaltSetzen(gid(6142), null) // Abfrage der Halt-Einzelheiten scheitert
    fakeOrderHinterlegen(bestellung(6142, 'ON_HOLD') as never)
    await bestellWebhook(6142)
    const a = await auftrag(6142)
    assert.deepEqual([a.halt, a.grund, a.notiz], [true, 'In Shopify angehalten', null])
    assert.equal(await versandbereit(6142), false)

    fakeOrderHinterlegen(bestellung(6142, 'UNFULFILLED') as never)
    await bestellWebhook(6142)
    assert.equal((await auftrag(6142)).halt, false)
    assert.equal(await versandbereit(6142), true)
  })

  test('versendet und danach angehalten: die Versandmeldung wird nicht still übersprungen', async () => {
    fakeOrderHinterlegen(bestellung(6143) as never)
    await bestellWebhook(6143, 'orders/create')
    const p = await lieferung(6143)
    // Der Halt entsteht zwischen Label und Shop-Rückmeldung.
    await h.sql`update integration_jobs set next_run_at = now() + interval '1 hour' where status = 'pending'`
    await aktion('versand.label_erstellen', p.id)
    fakeHaltSetzen(gid(6143), [{ reason: 'OTHER', reasonNotes: 'Kunde wartet' }])

    const { runDueJobs } = await import('../../src/modules/integrationen/jobs.ts')
    await h.sql`update integration_jobs set next_run_at = now() where kind = 'shopify_fulfillment_create' and status = 'pending'`
    await runDueJobs(20)
    const [job] = await h.sql<{ status: string; last_error: string | null }[]>`
      select j.status::text as status, j.last_error from integration_jobs j
      join shipments s on s.id = (j.payload ->> 'shipment_id')::uuid
      where j.kind = 'shopify_fulfillment_create' and s.picking_id = ${p.id}`
    assert.equal(job.status, 'pending', 'der Job wartet und wiederholt')
    assert.match(job.last_error ?? '', /In Shopify angehalten/)
    const [{ n }] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from benachrichtigungen where schluessel like 'halt-versand:%'`
    assert.equal(Number(n), 1, 'Telegram-Meldung eingereiht')

    // Halt aufgehoben: die Wiederholung meldet den Versand.
    fakeHaltSetzen(gid(6143), undefined)
    await h.sql`update integration_jobs set next_run_at = now() where kind = 'shopify_fulfillment_create' and status = 'pending'`
    await runDueJobs(20)
    const [s] = await h.sql<{ fid: string | null }[]>`
      select shopify_fulfillment_id as fid from shipments where picking_id = ${p.id}`
    assert.ok(s.fid, 'Fulfillment im Shop angelegt')
  })
})
