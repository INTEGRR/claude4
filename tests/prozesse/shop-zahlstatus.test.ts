/**
 * Shop-Zahlstatus (0130, Entscheidungslog 2026-10-17, Vorlage
 * auftragsaenderung.md Punkt 3): Eine Shop-Rechnung ist nur bezahlt, wenn
 * Shopify nichts mehr offen meldet. Nach einer Bestelländerung mit Aufpreis
 * (PARTIALLY_PAID) bleibt sie offen mit dem Restbetrag und schließt beim
 * nächsten orders/updated, sobald der Kunde nachgezahlt hat.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'
import { fakeOrderHinterlegen } from '../../src/modules/integrationen/shopify-fake.ts'
import { processPendingWebhooks } from '../../src/modules/integrationen/import.ts'
import { zahlungsHinweis } from '../../src/modules/verkauf/rechnung-pdf.ts'

const DATENBANK = 'erp_shop_zahlstatus_check'
const ADMIN = { name: 'zahlstatus-test', role: 'admin' as const }
const GID = 'gid://shopify/Order/6130'
let h: Harness
let webhookNr = 0
let letzteMeldung = ''

const aktion = (name: string, recordId: string | undefined, parameter: Record<string, unknown> = {}) =>
  aktionAusfuehrenGeprueft(name, { recordId, parameter }, ADMIN)

function bestellung(menge: number, zahlstatus: string, offen: string | null) {
  return {
    id: GID, name: '#6130', createdAt: '2026-10-10T10:00:00Z', updatedAt: '2026-10-10T10:00:00Z',
    email: 'kunde@example.com', tags: [], displayFinancialStatus: zahlstatus, displayFulfillmentStatus: 'UNFULFILLED',
    cancelledAt: null, taxesIncluded: true, paymentGatewayNames: ['shopify_payments'],
    customer: { id: 'gid://shopify/Customer/6130', firstName: 'Lea', lastName: 'Kurz', defaultEmailAddress: { emailAddress: 'kunde@example.com' } },
    totalPriceSet: { shopMoney: { amount: '34.51', currencyCode: 'EUR' } },
    currentTotalPriceSet: { shopMoney: { amount: (34.51 * menge).toFixed(2) } },
    ...(offen === null ? {} : { totalOutstandingSet: { shopMoney: { amount: offen } } }),
    shippingAddress: { name: 'Lea Kurz', address1: 'Am Markt 3', address2: null, zip: '32457', city: 'Porta Westfalica', countryCodeV2: 'DE', phone: null },
    billingAddress: { name: 'Lea Kurz', company: null, address1: 'Am Markt 3', address2: null, zip: '32457', city: 'Porta Westfalica', countryCodeV2: 'DE' },
    shippingLine: null,
    lineItems: {
      nodes: [{
        id: 'gid://shopify/LineItem/6130-0', title: 'Deskmat', variantTitle: null, sku: 'ZS-MAT',
        quantity: menge, currentQuantity: menge, variant: null,
        originalUnitPriceSet: { shopMoney: { amount: '34.51' } },
        discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '34.51' } }, taxLines: [{ rate: 0.19 }],
      }],
    },
  }
}

async function webhook(topic = 'orders/updated'): Promise<void> {
  await h.sql`insert into shopify_webhook_events (webhook_id, topic, shopify_order_id, payload)
              values (${`zs-${++webhookNr}`}, ${topic}, ${GID}, '{}'::jsonb)`
  const r = await processPendingWebhooks(5)
  const [ev] = await h.sql<{ error: string | null }[]>`select error from shopify_webhook_events where webhook_id = ${`zs-${webhookNr}`}`
  assert.equal(r.failed, 0, `Webhook ohne Fehler: ${ev.error ?? ''}`)
  letzteMeldung = ev.error ?? ''
}

async function auftragId(): Promise<string> {
  const [so] = await h.sql<{ id: string }[]>`select id from sales_orders where shopify_order_id = ${GID}`
  return so.id
}

before(async () => {
  h = await harnessStart(DATENBANK)
  await aktion('einstellungen.shopify_modus_setzen', undefined, { modus: 'schreiben' })
  await aktion('einstellungen.rechnungen_setzen', undefined, {
    modus: 'scharf', zahlungsziel_tage: 14, mahnfrist_tage: 7, kontenrahmen: 'SKR03', debitorenkonto: '10000',
    erloeskonto_19: '8400', erloeskonto_7: '8300', erloeskonto_0: '8120',
  })
  const r = await aktion('produkte.produkt_anlegen', undefined, {
    name: 'Deskmat Zahlstatus', sku: 'ZS-MAT', verkaufspreis: 29, einstandspreis: 9, gewicht_g: 500,
    verkaufbar: true, einkaufbar: true, route: 'kaufen', attribute: [],
  })
  const [pv] = await h.sql<{ id: string }[]>`select id from product_variants where template_id = ${r.recordId!}`
  const z = await aktion('lager.zaehlung_erfassen', undefined, { variant_id: pv.id, counted_qty: 10 })
  await aktion('lager.zaehlung_buchen', z.recordId)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

describe('Shop-Rechnung: bezahlt nur, wenn Shopify nichts mehr offen meldet', () => {
  test('bezahlte Bestellung, dann Aufpreis: 2 statt 1 Deskmat, Shopify meldet 34,51 € offen', async () => {
    fakeOrderHinterlegen(bestellung(1, 'PAID', '0.00') as never)
    await webhook('orders/create')
    const id = await auftragId()
    const [a] = await h.sql<{ state: string; zahlstatus: string; offen: number }[]>`
      select state::text as state, shopify_zahlstatus as zahlstatus, shopify_offen as offen from sales_orders where id = ${id}`
    assert.deepEqual([a.state, a.zahlstatus, Number(a.offen)], ['sale', 'PAID', 0])

    fakeOrderHinterlegen(bestellung(2, 'PARTIALLY_PAID', '34.51') as never)
    await webhook()
    assert.match(letzteMeldung, /Bestellung im Shop geändert/)
    const [b] = await h.sql<{ zahlstatus: string; offen: number }[]>`
      select shopify_zahlstatus as zahlstatus, shopify_offen as offen from sales_orders where id = ${id}`
    assert.deepEqual([b.zahlstatus, Number(b.offen)], ['PARTIALLY_PAID', 34.51])
  })

  test('Versand vor der Nachzahlung: Rechnung bleibt offen mit dem Restbetrag', async () => {
    const id = await auftragId()
    const [p] = await h.sql<{ id: string }[]>`
      select id from stock_pickings where origin_model = 'sales_order' and origin_id = ${id} and state not in ('done', 'cancel')`
    await h.sql`select picking_validate(${p.id}, '{}'::jsonb, false)`
    const [r] = await h.sql<{ id: string; status: string; brutto: number; offen: number; shop_offen: number; faellig: string }[]>`
      select id, status::text as status, brutto, kundenrechnung_offen(id) as offen, shop_offen,
             (faellig_am - rechnungsdatum)::int::text as faellig
      from kundenrechnungen where sales_order_id = ${id}`
    assert.equal(r.status, 'offen', 'Shopify meldet noch einen offenen Betrag')
    assert.equal(Number(r.brutto), 69.02)
    assert.equal(Number(r.offen), 34.51, 'offen ist nur der Aufpreis')
    assert.equal(r.faellig, '14', 'reguläres Zahlungsziel statt sofort fällig')

    const [k] = await h.sql<{ quelle: string; waehrung: string; nummer: string }[]>`
      select so.source::text as quelle, kr.waehrung, kr.nummer from kundenrechnungen kr
      join sales_orders so on so.id = kr.sales_order_id where kr.id = ${r.id}`
    const hinweis = zahlungsHinweis({ ...k, art: 'rechnung', status: 'offen', offen: 34.51 } as never, {} as never)
    assert.match(hinweis, /Offener Restbetrag: 34,51/)
  })

  test('Kunde zahlt nach: Shopify meldet PAID — die Rechnung schließt von selbst', async () => {
    const id = await auftragId()
    fakeOrderHinterlegen(bestellung(2, 'PAID', '0.00') as never)
    await webhook()
    assert.match(letzteMeldung, /1 Rechnung laut Shopify bezahlt/)
    const [r] = await h.sql<{ status: string; offen: number }[]>`
      select status::text as status, kundenrechnung_offen(id) as offen from kundenrechnungen where sales_order_id = ${id}`
    assert.deepEqual([r.status, Number(r.offen)], ['bezahlt', 0])
  })

  test('ohne Angabe von Shopify (ältere Antwort) gilt weiter „Shop hat bezahlt"', async () => {
    const [so] = await h.sql<{ id: string }[]>`
      update sales_orders set shopify_offen = null where shopify_order_id = ${GID} returning id`
    const [{ n }] = await h.sql<{ n: number }[]>`select kundenrechnung_shop_abgleich(${so.id}) as n`
    assert.equal(Number(n), 0)
  })
})
