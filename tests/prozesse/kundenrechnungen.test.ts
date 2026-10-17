/**
 * Kundenrechnungen (0115, Entscheidungslog 2026-10-16) gegen die echte
 * Datenbank mit Shopify- und DHL-Attrappe:
 *  - Shop-Bestellung geändert VOR dem Versand (Menge, anderes Case, Artikel
 *    dazu): Positionen, Lieferung und Fertigung folgen, kein Beleg entsteht;
 *  - Lieferung per Label → Rechnung von selbst: Positionen mit Variantenname,
 *    Rabatt als Listenpreis, Versand, Zahlungsart aus dem Shop, bezahlt;
 *  - Änderung NACH der Rechnung (Teilerstattung im Shop): Gutschrift über die
 *    zurückgenommene Menge, Rechnung bleibt;
 *  - Artikel dazu nach der Rechnung: zweite Lieferung → zweite Rechnung ohne
 *    Versand;
 *  - Firmenkunde: offen, fällig in der Forderungsliste, überfällig → Mahnung,
 *    Teilgutschrift;
 *  - PDF rendert, DATEV-Stapel enthält die Belege.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'
import { runDueJobs } from '../../src/modules/integrationen/jobs.ts'
import { fakeOrderHinterlegen } from '../../src/modules/integrationen/shopify-fake.ts'
import { processPendingWebhooks } from '../../src/modules/integrationen/import.ts'
import { rechnungPdf } from '../../src/modules/verkauf/rechnung-pdf.ts'

const DATENBANK = 'erp_kundenrechnungen_check'
const ADMIN = { name: 'rechnungstest', role: 'admin' as const }
let h: Harness
const v: Record<string, string> = {}
let webhookNr = 0

const RECHNUNG_EINST = { zahlungsziel_tage: 14, mahnfrist_tage: 7, kontenrahmen: 'SKR03', debitorenkonto: '10000', erloeskonto_19: '8400', erloeskonto_7: '8300', erloeskonto_0: '8120' }

const aktion = (name: string, recordId: string | undefined, parameter: Record<string, unknown> = {}) =>
  aktionAusfuehrenGeprueft(name, { recordId, parameter }, ADMIN)

interface Zeile { sku: string; title: string; variantTitle?: string; qty: number; current?: number; brutto: string; original?: string }

function shopOrder(gid: string, name: string, zeilen: Zeile[], extra: Record<string, unknown> = {}) {
  return {
    id: gid, name, createdAt: '2026-10-10T10:00:00Z', updatedAt: '2026-10-10T10:00:00Z',
    email: 'kunde@example.com', tags: [], displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED',
    cancelledAt: null, taxesIncluded: true, paymentGatewayNames: ['shopify_payments'],
    customer: { id: 'gid://shopify/Customer/7360719358946', firstName: 'Stefan', lastName: 'Friedl', defaultEmailAddress: { emailAddress: 'kunde@example.com' } },
    totalPriceSet: { shopMoney: { amount: '0.00', currencyCode: 'EUR' } },
    shippingAddress: { name: 'Stefan Friedl', address1: 'Büdinger Straße 7', address2: null, zip: '63688', city: 'Gedern', countryCodeV2: 'DE', phone: null },
    billingAddress: { name: 'Stefan Friedl', company: null, address1: 'Büdinger Straße 7', address2: null, zip: '63688', city: 'Gedern', countryCodeV2: 'DE' },
    shippingLine: { discountedPriceSet: { shopMoney: { amount: '6.99' } }, taxLines: [{ rate: 0.19 }] },
    lineItems: {
      nodes: zeilen.map((z, i) => ({
        id: `gid://shopify/LineItem/${gid.split('/').pop()}-${i}`, title: z.title, variantTitle: z.variantTitle ?? null, sku: z.sku,
        quantity: z.qty, currentQuantity: z.current ?? z.qty, variant: null,
        originalUnitPriceSet: { shopMoney: { amount: z.original ?? z.brutto } },
        discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: z.brutto } }, taxLines: [{ rate: 0.19 }],
      })),
    },
    ...extra,
  }
}

async function webhook(gid: string, topic = 'orders/updated'): Promise<void> {
  await h.sql`insert into shopify_webhook_events (webhook_id, topic, shopify_order_id, payload)
              values (${`kr-${++webhookNr}`}, ${topic}, ${gid}, '{}'::jsonb)`
  const r = await processPendingWebhooks(5)
  const [ev] = await h.sql<{ error: string | null }[]>`select error from shopify_webhook_events where webhook_id = ${`kr-${webhookNr}`}`
  assert.equal(r.failed, 0, `Webhook ohne Fehler: ${ev.error ?? ''}`)
  v.letzteMeldung = ev.error ?? ''
}

async function auftrag(gid: string) {
  const [so] = await h.sql<{ id: string; state: string; delivery_status: string; versandkosten: number }[]>`
    select id, state::text as state, delivery_status::text as delivery_status, versandkosten from sales_orders where shopify_order_id = ${gid}`
  return so
}
const zeilen = (orderId: string) =>
  h.sql<{ sku: string; name: string; qty: number; qty_delivered: number; qty_invoiced: number; price_unit: number; listenpreis: number | null }[]>`
    select pv.sku, l.name, l.qty, l.qty_delivered, l.qty_invoiced, l.price_unit, l.listenpreis
    from sales_order_lines l join product_variants pv on pv.id = l.variant_id where l.order_id = ${orderId} order by l.sequence`
const bewegungen = (orderId: string) =>
  h.sql<{ sku: string; qty: number; state: string; picking_state: string }[]>`
    select pv.sku, m.qty, m.state::text as state, p.state::text as picking_state
    from stock_moves m join stock_pickings p on p.id = m.picking_id join product_variants pv on pv.id = m.variant_id
    where p.origin_model = 'sales_order' and p.origin_id = ${orderId} order by m.created_at`
const fertigung = (orderId: string) =>
  h.sql<{ sku: string; qty: number; state: string }[]>`
    select pv.sku, mo.qty_to_produce as qty, mo.state::text as state from manufacturing_orders mo
    join product_variants pv on pv.id = mo.variant_id where mo.sales_order_id = ${orderId} order by mo.created_at`
const rechnungen = (orderId: string) =>
  h.sql<{ id: string; nummer: string; art: string; status: string; netto: number; steuer: number; brutto: number; zahlungsart: string | null; storno_von_id: string | null }[]>`
    select id, nummer, art::text as art, status::text as status, netto, steuer, brutto, zahlungsart, storno_von_id
    from kundenrechnungen where sales_order_id = ${orderId} order by created_at`

before(async () => {
  h = await harnessStart(DATENBANK)
  const sql = h.sql
  await aktion('einstellungen.shopify_modus_setzen', undefined, { modus: 'schreiben' })
  // 0117: Vorgabe jeder Instanz ist der Probelauf — dieser Lauf prüft zuerst den Ernstfall (scharf), der Probelauf folgt unten.
  await aktion('einstellungen.rechnungen_setzen', undefined, { modus: 'scharf', ...RECHNUNG_EINST })
  await aktion('einstellungen.firma_speichern', undefined, {
    name: 'Anvil GmbH', street: 'Neue Friedhofstraße', house: '10', zip: '32457', city: 'Porta Westfalica', country: 'DEU',
    email: 'blink@example.com', phone: '', registergericht: 'Bad Oeynhausen', handelsregister: 'HRB 16523',
    steuernummer: '335/5754/6137', geschaeftsfuehrung: 'Patrick Düker, Philip Düker, Tino Uhlendorf', iban: 'DE00 0000 0000 0000 0000 00',
  })
  // Artikel: Tastatur auf Auftrag (Stückliste), zweites Case als eigene Variante, Deskmat als Lagerware.
  const artikel = async (name: string, sku: string, opts: { preis?: number; kosten?: number; verkaufbar?: boolean; einkaufbar?: boolean; route?: 'kaufen' | 'fertigen'; mto?: boolean; bestand?: number; gid?: number }) => {
    const r = await aktion('produkte.produkt_anlegen', undefined, {
      name, sku, verkaufspreis: opts.preis ?? 0, einstandspreis: opts.kosten ?? 0, gewicht_g: 500,
      verkaufbar: opts.verkaufbar ?? true, einkaufbar: opts.einkaufbar ?? false, route: opts.route ?? 'kaufen', attribute: [],
    })
    const [pv] = await sql<{ id: string }[]>`select id from product_variants where template_id = ${r.recordId!}`
    if (opts.mto) await sql`update product_templates set route_mto = true where id = ${r.recordId!}`
    if (opts.gid) await sql`update product_variants set shopify_variant_id = ${`gid://shopify/ProductVariant/${opts.gid}`} where id = ${pv.id}`
    if (opts.bestand) {
      const z = await aktion('lager.zaehlung_erfassen', undefined, { variant_id: pv.id, counted_qty: opts.bestand })
      await aktion('lager.zaehlung_buchen', z.recordId)
    }
    return { id: pv.id, template: r.recordId! }
  }
  const caseA = await artikel('Case Aluminium', 'CASE-ALU', { kosten: 38, einkaufbar: true, verkaufbar: false, bestand: 10 })
  const caseP = await artikel('Case Polycarbonat', 'CASE-PC', { kosten: 30, einkaufbar: true, verkaufbar: false, bestand: 10 })
  const sw = await artikel('Switch Silent Red', 'SW-RED', { kosten: 0.3, einkaufbar: true, verkaufbar: false, bestand: 2000 })
  const kbA = await artikel('NATIVE 75 Alu', 'KB-ALU', { preis: 233.61, route: 'fertigen', mto: true, gid: 901 })
  const kbP = await artikel('NATIVE 75 PC', 'KB-PC', { preis: 199, route: 'fertigen', mto: true, gid: 902 })
  const mat = await artikel('Deskmat', 'DESKMAT', { preis: 29, kosten: 9, einkaufbar: true, bestand: 20, gid: 903 })
  for (const [kb, c] of [[kbA, caseA], [kbP, caseP]] as const) {
    const bom = await aktion('fertigung.stueckliste_anlegen', undefined, { template_id: kb.template, qty: 1 })
    await aktion('fertigung.stueckliste_position_hinzufuegen', bom.recordId, { component_variant_id: c.id, qty: 1, issue_method: 'backflush', ptav_ids: [] })
    await aktion('fertigung.stueckliste_position_hinzufuegen', bom.recordId, { component_variant_id: sw.id, qty: 70, issue_method: 'backflush', ptav_ids: [] })
  }
  Object.assign(v, { caseA: caseA.id, caseP: caseP.id, sw: sw.id, kbA: kbA.id, kbP: kbP.id, mat: mat.id })
  // Firmenkunde für die Rechnung auf Ziel.
  const k = await aktion('kontakte.partner_anlegen', undefined, { name: 'Büro Nord GmbH', is_company: true, is_customer: true, is_vendor: false, country_code: 'DE', street: 'Hafenstraße', house_number: '12', zip: '20457', city: 'Hamburg' })
  v.kunde = k.recordId!
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

describe('Kundenrechnungen: Shop-Änderungen, Rechnung bei Lieferung, Gutschrift, Firmenkunde', () => {
  const GID = 'gid://shopify/Order/5001'

  test('Bestellung mit Rabatt wird importiert: Variantenname in der Zeile, Listenpreis vor Rabatt', async () => {
    fakeOrderHinterlegen(shopOrder(GID, '#5001', [
      { sku: 'KB-ALU', title: 'ANVIL NATIVE 75', variantTitle: 'Standard / FR4 / Silent Red', qty: 1, brutto: '272.01', original: '278.00' },
      { sku: 'DESKMAT', title: 'Deskmat', qty: 2, brutto: '34.51' },
    ]) as never)
    await webhook(GID, 'orders/create')
    const so = await auftrag(GID)
    assert.equal(so.state, 'sale')
    const z = await zeilen(so.id)
    assert.deepEqual(z.map((x) => [x.sku, x.name, Number(x.qty), Number(x.price_unit), x.listenpreis === null ? null : Number(x.listenpreis)]), [
      ['KB-ALU', 'ANVIL NATIVE 75 - Standard / FR4 / Silent Red', 1, 228.58, 233.61],
      ['DESKMAT', 'Deskmat', 2, 29, null],
    ])
    const [kopf] = await h.sql<{ zahlungsart: string; anschrift: { city: string } }[]>`
      select zahlungsart, rechnungsanschrift as anschrift from sales_orders where id = ${so.id}`
    assert.equal(kopf.zahlungsart, 'Shopify Payments')
    assert.equal(kopf.anschrift.city, 'Gedern')
    assert.deepEqual((await fertigung(so.id)).map((m) => [m.sku, Number(m.qty), m.state]), [['KB-ALU', 1, 'confirmed']])
  })

  test('Änderung vor dem Versand: anderes Case, 3 statt 2 Deskmats, Switches dazu — Auftrag, Lieferung und Fertigung folgen, kein Beleg', async () => {
    const so = await auftrag(GID)
    fakeOrderHinterlegen(shopOrder(GID, '#5001', [
      { sku: 'KB-ALU', title: 'ANVIL NATIVE 75', variantTitle: 'Standard / FR4 / Silent Red', qty: 1, current: 0, brutto: '272.01', original: '278.00' },
      { sku: 'KB-PC', title: 'ANVIL NATIVE 75', variantTitle: 'Polycarbonat / FR4 / Silent Red', qty: 1, brutto: '236.81' },
      { sku: 'DESKMAT', title: 'Deskmat', qty: 3, brutto: '34.51' },
      { sku: 'SW-RED', title: 'Switch Silent Red', qty: 10, brutto: '0.60' },
    ]) as never)
    await webhook(GID)
    assert.match(v.letzteMeldung, /Bestellung im Shop geändert/)
    const z = await zeilen(so.id)
    assert.deepEqual(z.map((x) => [x.sku, Number(x.qty)]), [['DESKMAT', 3], ['KB-PC', 1], ['SW-RED', 10]])
    // Fertigung: Alu storniert, PC neu; Lieferung: Alu-Bewegung storniert, PC + Switches neu, Deskmat 3.
    assert.deepEqual((await fertigung(so.id)).map((m) => [m.sku, Number(m.qty), m.state]), [['KB-ALU', 1, 'cancel'], ['KB-PC', 1, 'confirmed']])
    // Die Mehrmenge Deskmat ist eine zweite Bewegung (2 + 1) in derselben Lieferung.
    const offen = new Map<string, number>()
    for (const m of (await bewegungen(so.id)).filter((m) => m.state !== 'cancel')) offen.set(m.sku, (offen.get(m.sku) ?? 0) + Number(m.qty))
    assert.deepEqual([...offen].sort(), [['DESKMAT', 3], ['KB-PC', 1], ['SW-RED', 10]])
    assert.equal((await rechnungen(so.id)).length, 0, 'vor dem Versand entsteht kein Beleg')
    assert.equal(Number((await auftrag(GID)).versandkosten), 5.87)
  })

  test('Fertigung + Label: die Rechnung entsteht von selbst — bezahlt, mit Versand, Zahlungsart aus dem Shop', async () => {
    const so = await auftrag(GID)
    const [mo] = await h.sql<{ id: string }[]>`select id from manufacturing_orders where sales_order_id = ${so.id} and state = 'confirmed'`
    await aktion('fertigung.fertig_melden', mo.id, { mengen: {}, backorder: false })
    const [p] = await h.sql<{ id: string; state: string }[]>`
      select id, state::text as state from stock_pickings where origin_model = 'sales_order' and origin_id = ${so.id} and state not in ('done', 'cancel')`
    assert.equal(p.state, 'assigned')
    await aktion('versand.label_erstellen', p.id, { nicht_ausbuchen: false })
    await runDueJobs()
    const r = await rechnungen(so.id)
    assert.equal(r.length, 1)
    v.rechnung1 = r[0].id
    assert.match(r[0].nummer, /^RE-\d{4}$/)
    assert.equal(r[0].status, 'bezahlt')
    assert.equal(r[0].zahlungsart, 'Shopify Payments')
    // 1 × 199 + 3 × 29 + 10 × 0,50 + Versand 5,87 = 296,87 netto; Steuer 19 % je Zeile
    assert.equal(Number(r[0].netto), 296.87)
    assert.equal(Number(r[0].steuer), 56.41)
    assert.equal(Number(r[0].brutto), 353.28)
    const pos = await h.sql<{ art: string; bezeichnung: string; menge: number; brutto: number }[]>`
      select art, bezeichnung, menge, brutto from kundenrechnung_positionen where rechnung_id = ${r[0].id} order by sequence`
    assert.deepEqual(pos.map((x) => [x.art, x.bezeichnung, Number(x.menge), Number(x.brutto)]), [
      ['position', 'Deskmat', 3, 103.53],
      ['position', 'ANVIL NATIVE 75 - Polycarbonat / FR4 / Silent Red', 1, 236.81],
      ['position', 'Switch Silent Red', 10, 5.95],
      ['versand', 'Versand', 1, 6.99],
    ])
    assert.deepEqual((await zeilen(so.id)).map((x) => [x.sku, Number(x.qty_invoiced)]), [['DESKMAT', 3], ['KB-PC', 1], ['SW-RED', 10]])
    const [status] = await h.sql<{ invoice_status: string }[]>`select invoice_status::text from sales_orders where id = ${so.id}`
    assert.equal(status.invoice_status, 'invoiced')
  })

  test('PDF der Rechnung rendert (Bruttopreise, Rabatt, Pflichtangaben im Fuß)', async () => {
    const { bytes, dateiname } = await rechnungPdf(v.rechnung1)
    assert.ok(bytes.length > 2000, 'PDF hat Inhalt')
    assert.equal(bytes.subarray(0, 4).toString(), '%PDF')
    assert.match(dateiname, /^RE-\d{4}\.pdf$/)
  })

  test('Teilerstattung im Shop nach der Rechnung: Gutschrift über 1 Deskmat, Rechnung bleibt', async () => {
    const so = await auftrag(GID)
    fakeOrderHinterlegen(shopOrder(GID, '#5001', [
      { sku: 'KB-PC', title: 'ANVIL NATIVE 75', variantTitle: 'Polycarbonat / FR4 / Silent Red', qty: 1, brutto: '236.81' },
      { sku: 'DESKMAT', title: 'Deskmat', qty: 3, current: 2, brutto: '34.51' },
      { sku: 'SW-RED', title: 'Switch Silent Red', qty: 10, brutto: '0.60' },
    ], { displayFinancialStatus: 'PARTIALLY_REFUNDED', displayFulfillmentStatus: 'FULFILLED' }) as never)
    await webhook(GID)
    const r = await rechnungen(so.id)
    assert.equal(r.length, 2)
    const gut = r.find((x) => x.art === 'gutschrift')!
    assert.ok(gut, 'Gutschrift entstanden')
    assert.equal(gut.storno_von_id, v.rechnung1)
    assert.equal(Number(gut.brutto), 34.51)
    assert.equal(gut.status, 'bezahlt', 'Shop erstattet — nichts offen')
    assert.equal(r.find((x) => x.id === v.rechnung1)!.status, 'bezahlt', 'die Rechnung bleibt gültig')
    const z = await zeilen(so.id)
    assert.deepEqual(z.find((x) => x.sku === 'DESKMAT') && [Number(z.find((x) => x.sku === 'DESKMAT')!.qty), Number(z.find((x) => x.sku === 'DESKMAT')!.qty_invoiced)], [3, 2],
      'unter das Gelieferte geht die Menge nicht, berechnet sind noch 2')
  })

  test('Artikel dazu nach der Rechnung: neue Lieferung, zweite Rechnung ohne Versand', async () => {
    const so = await auftrag(GID)
    // Der Kunde bestellt 10 Switches nach (neue Shop-Zeile derselben Variante).
    fakeOrderHinterlegen(shopOrder(GID, '#5001', [
      { sku: 'KB-PC', title: 'ANVIL NATIVE 75', variantTitle: 'Polycarbonat / FR4 / Silent Red', qty: 1, brutto: '236.81' },
      { sku: 'DESKMAT', title: 'Deskmat', qty: 3, current: 2, brutto: '34.51' },
      { sku: 'SW-RED', title: 'Switch Silent Red', qty: 10, brutto: '0.60' },
      { sku: 'SW-RED', title: 'Switch Silent Red', qty: 10, brutto: '0.60' },
    ], { displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'PARTIALLY_FULFILLED' }) as never)
    await webhook(GID)
    assert.match(v.letzteMeldung, /Switch Silent Red: 10 → 20/)
    const offen = (await bewegungen(so.id)).filter((m) => m.state !== 'cancel' && m.state !== 'done')
    assert.deepEqual(offen.map((m) => [m.sku, Number(m.qty), m.picking_state]), [['SW-RED', 10, 'assigned']], 'die Nachlieferung wartet versandbereit')
    assert.equal((await rechnungen(so.id)).length, 2, 'die Nachbestellung allein erzeugt keinen Beleg')
    const [p] = await h.sql<{ id: string }[]>`
      select id from stock_pickings where origin_model = 'sales_order' and origin_id = ${so.id} and state = 'assigned'`
    await aktion('lager.transfer_buchen', p.id, { mengen: {}, lose: {}, backorder: false })
    const r = (await rechnungen(so.id)).filter((x) => x.art === 'rechnung')
    assert.equal(r.length, 2)
    assert.equal(Number(r[1].brutto), 5.95, 'nur die Nachlieferung, kein zweiter Versand')
    assert.equal(r[1].status, 'bezahlt')
  })

  test('Firmenkunde: offen mit Zahlungsziel, in der Forderungsliste, überfällig → Mahnung, Teilgutschrift', async () => {
    const r = await aktion('verkauf.auftrag_mit_positionen', undefined, { kunde: 'Büro Nord GmbH', positionen: [{ produkt: 'DESKMAT', menge: 4, preis: 25 }] })
    await aktion('verkauf.bestaetigen', r.recordId)
    const [p] = await h.sql<{ id: string }[]>`select id from stock_pickings where origin_model = 'sales_order' and origin_id = ${r.recordId!}`
    await aktion('lager.transfer_buchen', p.id, { mengen: {}, lose: {}, backorder: false })
    const [k] = await rechnungen(r.recordId!)
    assert.equal(k.status, 'offen')
    assert.equal(Number(k.brutto), 119)
    assert.equal(k.zahlungsart, 'Überweisung')
    const faellig = await h.sql<{ quelle: string; richtung: string; betrag_eur: number }[]>`
      select quelle, richtung, betrag_eur from finanz_faellig((current_date + 60)::date) where quelle = 'kundenrechnung'`
    assert.deepEqual(faellig.map((f) => [f.quelle, f.richtung, Number(f.betrag_eur)]), [['kundenrechnung', 'ein', 119]])

    await assert.rejects(aktion('verkauf.rechnung_mahnen', k.id), /noch nicht fällig/)
    await h.sql`update kundenrechnungen set faellig_am = current_date - 10 where id = ${k.id}`
    const m = await aktion('verkauf.rechnung_mahnen', k.id)
    assert.match(m?.text ?? '', /Zahlungserinnerung/)
    const mahnung = await rechnungPdf(k.id, 'mahnung')
    assert.equal(mahnung.bytes.subarray(0, 4).toString(), '%PDF')
    assert.match(mahnung.dateiname, /Mahnung-1/)

    const [pos] = await h.sql<{ id: string }[]>`select id from kundenrechnung_positionen where rechnung_id = ${k.id}`
    const g = await aktion('verkauf.gutschrift_erstellen', k.id, { positionen: [{ position_id: pos.id, menge: 1 }], grund: 'eine Matte beschädigt' })
    assert.match(g?.text ?? '', /Teilgutschrift GU-\d{4} über 29,75\s€/)
    const [nachher] = await h.sql<{ status: string; offen: number }[]>`select status::text as status, kundenrechnung_offen(id) as offen from kundenrechnungen where id = ${k.id}`
    assert.equal(nachher.status, 'offen', 'Teilgutschrift lässt die Rechnung bestehen')
    assert.equal(Number(nachher.offen), 119, 'die Gutschrift ist ein eigener Beleg, verrechnet wird in der Zahlung')
    const [konto] = await h.sql<{ id: string }[]>`insert into bankkonten (name, waehrung) values ('Geschäftskonto', 'EUR') returning id`
    await aktion('verkauf.rechnung_zahlen', k.id, { betrag: 89.25, bankkonto_id: konto.id })
    const [teil] = await h.sql<{ status: string; offen: number }[]>`select status::text as status, kundenrechnung_offen(id) as offen from kundenrechnungen where id = ${k.id}`
    assert.deepEqual([teil.status, Number(teil.offen)], ['offen', 29.75])
    await aktion('verkauf.rechnung_zahlen', k.id, { betrag: 29.75, bankkonto_id: konto.id })
    const [voll] = await h.sql<{ status: string }[]>`select status::text as status from kundenrechnungen where id = ${k.id}`
    assert.equal(voll.status, 'bezahlt')
    v.b2bRechnung = k.id
  })

  test('Storno einer bezahlten Überweisungsrechnung: Gutschrift offen (Erstattung), Rechnung storniert', async () => {
    const r = await aktion('verkauf.rechnung_stornieren', v.b2bRechnung, { grund: 'Komplettrücknahme' })
    assert.match(r?.text ?? '', /Erstattung steht noch aus/)
    const [k] = await h.sql<{ status: string }[]>`select status::text as status from kundenrechnungen where id = ${v.b2bRechnung}`
    assert.equal(k.status, 'storniert')
    const [g] = await h.sql<{ status: string; brutto: number }[]>`
      select status::text as status, brutto from kundenrechnungen where storno_von_id = ${v.b2bRechnung} and brutto = 119`
    assert.equal(g.status, 'offen')
    const faellig = await h.sql<{ richtung: string; betrag_eur: number }[]>`
      select richtung, betrag_eur from finanz_faellig((current_date + 60)::date) where quelle = 'kundenrechnung'`
    assert.deepEqual(faellig.map((f) => [f.richtung, Number(f.betrag_eur)]), [['aus', 119]], 'die Erstattung steht als Auszahlung an')
    await assert.rejects(aktion('verkauf.rechnung_stornieren', v.b2bRechnung), /bereits storniert/)
  })

  test('DATEV-Buchungsstapel des Monats enthält Rechnungen und Gutschriften', async () => {
    const { datevBuchungsstapel, steuergruppen } = await import('../../src/modules/verkauf/datev-export.ts')
    const belege = await h.sql<{ nummer: string; art: 'rechnung' | 'gutschrift'; rechnungsdatum: string; kunde: string; positionen: { steuersatz: number; brutto: number }[] }[]>`
      select k.nummer, k.art::text as art, k.rechnungsdatum::text as rechnungsdatum, k.anschrift ->> 'name' as kunde,
             (select jsonb_agg(jsonb_build_object('steuersatz', steuersatz, 'brutto', brutto)) from kundenrechnung_positionen where rechnung_id = k.id) as positionen
      from kundenrechnungen k order by k.nummer`
    const csv = datevBuchungsstapel(
      belege.map((b) => ({ ...b, gruppen: steuergruppen(b.positionen) })),
      { kontenrahmen: 'SKR03', debitorenkonto: '10000', erloeskonto_19: '8400', erloeskonto_7: '8300', erloeskonto_0: '8120' },
      { von: '2026-10-01', bis: '2026-10-31' },
    )
    const zeilenCsv = csv.trim().split('\r\n')
    assert.equal(zeilenCsv.length, 2 + belege.length)
    assert.ok(zeilenCsv.some((z) => z.includes('"S"') && z.includes('"8400"')), 'Rechnung im Soll gegen Erlöse 19 %')
    assert.ok(zeilenCsv.some((z) => z.includes('"H"')), 'Gutschrift im Haben')
    const r = await aktion('verkauf.datev_uebergeben', undefined, { von: '2026-01-01', bis: '2030-12-31' })
    assert.match(r?.text ?? '', new RegExp(`^${belege.length} Beleg`))
  })
})

describe('Rechnungs-Probelauf (0117): Testbelege parallel zum Shop, Vergleich, Löschen, scharf schalten', () => {
  const GID = 'gid://shopify/Order/5002'
  const shopBetrag = (betrag: string) => ({
    totalPriceSet: { shopMoney: { amount: betrag, currencyCode: 'EUR' } },
    currentTotalPriceSet: { shopMoney: { amount: betrag } },
  })
  const lieferungBuchen = async (orderId: string) => {
    const [p] = await h.sql<{ id: string }[]>`
      select id from stock_pickings where origin_model = 'sales_order' and origin_id = ${orderId} and state not in ('done', 'cancel') order by created_at limit 1`
    await aktion('lager.transfer_buchen', p.id, { mengen: {}, lose: {}, backorder: false })
  }
  const probeStand = () =>
    h.sql<{ code: string; next_number: number }[]>`select code, next_number from sequence_state() where code in ('kundenrechnung_probe', 'gutschrift_probe') order by code`

  test('Modus „test": Shop-Lieferung erzeugt eine Testrechnung PROBE-RE-0001 — bezahlt und berechnet wie im Ernstfall, Shop-Betrag am Auftrag', async () => {
    const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from kundenrechnungen where not probe`
    v.echteVorher = String(n)
    assert.ok(n >= 4, 'der Ernstfall oben hat echte Belege hinterlassen')
    await aktion('einstellungen.rechnungen_setzen', undefined, { modus: 'test', ...RECHNUNG_EINST })
    const [{ modus }] = await h.sql<{ modus: string }[]>`select rechnung_modus() as modus`
    assert.equal(modus, 'test')

    fakeOrderHinterlegen(shopOrder(GID, '#5002', [{ sku: 'DESKMAT', title: 'Deskmat', qty: 2, brutto: '34.51' }], shopBetrag('76.01')) as never)
    await webhook(GID, 'orders/create')
    const so = await auftrag(GID)
    const [kopf] = await h.sql<{ shopify_brutto: number | null }[]>`select shopify_brutto from sales_orders where id = ${so.id}`
    assert.equal(Number(kopf.shopify_brutto), 76.01, 'Gesamtbetrag laut Shop steht am Auftrag')
    await lieferungBuchen(so.id)
    const r = await rechnungen(so.id)
    assert.equal(r.length, 1)
    assert.equal(r[0].nummer, 'PROBE-RE-0001')
    assert.equal(r[0].status, 'bezahlt')
    assert.equal(Number(r[0].brutto), 76.01, '2 × 34,51 + Versand 6,99 — gleicher Betrag wie der Shop')
    v.probeRechnung = r[0].id
    v.probeAuftrag = so.id
    assert.deepEqual((await zeilen(so.id)).map((x) => [x.sku, Number(x.qty_invoiced)]), [['DESKMAT', 2]], 'berechnete Menge wie im Ernstfall')
    const [st] = await h.sql<{ invoice_status: string }[]>`select invoice_status::text from sales_orders where id = ${so.id}`
    assert.equal(st.invoice_status, 'invoiced')
    const [probe] = await h.sql<{ probe: boolean }[]>`select probe from kundenrechnungen where id = ${r[0].id}`
    assert.equal(probe.probe, true)
    // Echte Nummern bleiben unangetastet.
    const [[re]] = [await h.sql<{ next_number: number }[]>`select next_number from sequence_state() where code = 'kundenrechnung'`]
    v.reNaechste = String(re.next_number)
  })

  test('Testbelege zählen nirgends: Firmenkunden-Testrechnung nicht in den Fälligkeiten, nicht im DATEV-Stapel, PDF trägt die Probe', async () => {
    const r = await aktion('verkauf.auftrag_mit_positionen', undefined, { kunde: 'Büro Nord GmbH', positionen: [{ produkt: 'DESKMAT', menge: 1, preis: 25 }] })
    await aktion('verkauf.bestaetigen', r.recordId)
    await lieferungBuchen(r.recordId!)
    const [k] = await rechnungen(r.recordId!)
    assert.equal(k.nummer, 'PROBE-RE-0002')
    assert.equal(k.status, 'offen')
    v.probeB2b = k.id
    const faellig = await h.sql<{ n: number }[]>`
      select count(*)::int as n from finanz_faellig((current_date + 60)::date) where quelle = 'kundenrechnung' and ref = ${k.id}`
    assert.equal(faellig[0].n, 0, 'Testbelege stehen nicht in der Forderungsliste')
    const datev = await aktion('verkauf.datev_uebergeben', undefined, { von: '2026-01-01', bis: '2030-12-31' })
    assert.match(datev?.text ?? '', /^0 Beleg/, 'Testbelege werden nie an DATEV übergeben')
    const pdf = await rechnungPdf(k.id)
    assert.equal(pdf.bytes.subarray(0, 4).toString(), '%PDF')
    assert.equal(pdf.kopf.probe, true)
    assert.match(pdf.dateiname, /^PROBE-RE-0002/)
  })

  test('Shop-Änderung nach der Testrechnung: Testgutschrift PROBE-GU-0001, Shop-Betrag folgt — Vergleich bleibt gleich', async () => {
    fakeOrderHinterlegen(shopOrder(GID, '#5002', [{ sku: 'DESKMAT', title: 'Deskmat', qty: 2, current: 1, brutto: '34.51' }],
      { displayFinancialStatus: 'PARTIALLY_REFUNDED', displayFulfillmentStatus: 'FULFILLED', ...shopBetrag('41.50') }) as never)
    await webhook(GID)
    const r = await rechnungen(v.probeAuftrag)
    assert.equal(r.length, 2)
    const gut = r.find((x) => x.art === 'gutschrift')!
    assert.equal(gut.nummer, 'PROBE-GU-0001')
    assert.equal(gut.storno_von_id, v.probeRechnung)
    assert.equal(Number(gut.brutto), 34.51)
    const [kopf] = await h.sql<{ shopify_brutto: number }[]>`select shopify_brutto from sales_orders where id = ${v.probeAuftrag}`
    assert.equal(Number(kopf.shopify_brutto), 41.5)
    const [summe] = await h.sql<{ krnl: number }[]>`
      select sum(case art when 'rechnung' then brutto else -brutto end) as krnl from kundenrechnungen where probe and sales_order_id = ${v.probeAuftrag}`
    assert.equal(Number(summe.krnl), 41.5, 'KRNL-Summe der Testbelege = Shop-Betrag')
    assert.deepEqual((await probeStand()).map((x) => [x.code, Number(x.next_number)]), [['gutschrift_probe', 2], ['kundenrechnung_probe', 3]])
  })

  test('Scharf schalten ist gesperrt, solange Testbelege existieren', async () => {
    await assert.rejects(aktion('einstellungen.rechnungen_setzen', undefined, { modus: 'scharf', ...RECHNUNG_EINST }), /3 Testbelege.*Probelauf löschen/)
    const [{ modus }] = await h.sql<{ modus: string }[]>`select rechnung_modus() as modus`
    assert.equal(modus, 'test', 'der Modus bleibt beim Probelauf')
  })

  test('Probelauf löschen: Testbelege samt Zahlung weg, berechnete Mengen und Auftragsstatus zurück, Probe-Kreise auf 1, echte Belege unberührt', async () => {
    const [konto] = await h.sql<{ id: string }[]>`select id from bankkonten order by created_at limit 1`
    await aktion('verkauf.rechnung_zahlen', v.probeB2b, { betrag: 29.75, bankkonto_id: konto.id })
    const [[vorher]] = [await h.sql<{ n: number }[]>`select count(*)::int as n from zahlungen where quelle = 'kundenrechnung'`]
    const [[probeZahlungen]] = [await h.sql<{ n: number }[]>`
      select count(*)::int as n from zahlungen z join kundenrechnungen k on k.id = z.kundenrechnung_id where k.probe`]
    assert.equal(probeZahlungen.n, 1)

    const r = await aktion('verkauf.rechnung_probelauf_loeschen', undefined, {})
    assert.match(r?.text ?? '', /^3 Testbelege des Probelaufs gelöscht/)
    const [[rest]] = [await h.sql<{ n: number }[]>`select count(*)::int as n from kundenrechnungen where probe`]
    assert.equal(rest.n, 0)
    const [[echte]] = [await h.sql<{ n: number }[]>`select count(*)::int as n from kundenrechnungen where not probe`]
    assert.equal(String(echte.n), v.echteVorher, 'echte Belege bleiben')
    const [[nachher]] = [await h.sql<{ n: number }[]>`select count(*)::int as n from zahlungen where quelle = 'kundenrechnung'`]
    assert.equal(nachher.n, vorher.n - 1, 'die Zahlung auf den Testbeleg ist mit weg')
    assert.deepEqual((await zeilen(v.probeAuftrag)).map((x) => [x.sku, Number(x.qty_invoiced)]), [['DESKMAT', 0]], 'berechnete Menge zurückgerechnet')
    const [st] = await h.sql<{ invoice_status: string }[]>`select invoice_status::text from sales_orders where id = ${v.probeAuftrag}`
    assert.notEqual(st.invoice_status, 'invoiced')
    assert.deepEqual((await probeStand()).map((x) => [x.code, Number(x.next_number)]), [['gutschrift_probe', 1], ['kundenrechnung_probe', 1]])
    const wieder = await aktion('verkauf.rechnung_probelauf_loeschen', undefined, {})
    assert.match(wieder?.text ?? '', /^Kein Testbeleg/)
  })

  test('Danach scharf: die nächste Lieferung bekommt eine echte RE-Nummer in Folge', async () => {
    await aktion('einstellungen.rechnungen_setzen', undefined, { modus: 'scharf', ...RECHNUNG_EINST })
    const r = await aktion('verkauf.auftrag_mit_positionen', undefined, { kunde: 'Büro Nord GmbH', positionen: [{ produkt: 'DESKMAT', menge: 1, preis: 25 }] })
    await aktion('verkauf.bestaetigen', r.recordId)
    await lieferungBuchen(r.recordId!)
    const [k] = await rechnungen(r.recordId!)
    assert.equal(k.nummer, `RE-${String(v.reNaechste).padStart(4, '0')}`, 'der echte Kreis zählt nahtlos weiter')
    const [probe] = await h.sql<{ probe: boolean }[]>`select probe from kundenrechnungen where id = ${k.id}`
    assert.equal(probe.probe, false)
    // Modus aus: keine Automatik, Rechnung nur von Hand (wie bisher automatisch = false).
    await aktion('einstellungen.rechnungen_setzen', undefined, { modus: 'aus', ...RECHNUNG_EINST })
    const r2 = await aktion('verkauf.auftrag_mit_positionen', undefined, { kunde: 'Büro Nord GmbH', positionen: [{ produkt: 'DESKMAT', menge: 1, preis: 25 }] })
    await aktion('verkauf.bestaetigen', r2.recordId)
    await lieferungBuchen(r2.recordId!)
    assert.equal((await rechnungen(r2.recordId!)).length, 0, 'aus heißt aus')
    await aktion('einstellungen.rechnungen_setzen', undefined, { modus: 'scharf', ...RECHNUNG_EINST })
  })
})
