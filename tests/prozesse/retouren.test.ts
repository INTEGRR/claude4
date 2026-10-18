/**
 * Retouren (0119) gegen eine echte Datenbank — die Fälle neben dem
 * Fixture-Lauf: Portal (Bestellnummer + E-Mail, angemeldeter Kunde,
 * Honigtopf, Mengengrenzen), Erstattung VOR der Prüfung (Abschluss mit der
 * Prüfung), nur Shop-Aufträge, und die Gegenrechnung bei der nächsten
 * Bestellung: ein verkaufsfähiger Rückläufer ohne wartenden Auftrag bedient
 * den nächsten ohne Fertigung.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'
import { fakeOrderHinterlegen } from '../../src/modules/integrationen/shopify-fake.ts'
import { processPendingWebhooks } from '../../src/modules/integrationen/import.ts'
import { bestellungFinden, retoureAufnehmen } from '../../src/modules/versand/retoure-eingang.ts'
import { auswahlSeite, suchSeite } from '../../src/modules/versand/retoure-shop-seiten.ts'

const DATENBANK = 'erp_retouren_check'
const ADMIN = { name: 'retourentest', role: 'admin' as const }
let h: Harness
const v: Record<string, string> = {}
let nr = 0

const aktion = (name: string, recordId: string | undefined, parameter: Record<string, unknown> = {}) =>
  aktionAusfuehrenGeprueft(name as never, { recordId, parameter }, ADMIN)

function order(gid: string, name: string, sku: string, qty: number, brutto: string, extra: Record<string, unknown> = {}) {
  return {
    id: gid, name, createdAt: '2026-10-10T10:00:00Z', updatedAt: '2026-10-10T10:00:00Z',
    email: 'kundin@example.com', tags: [], displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED',
    cancelledAt: null, taxesIncluded: true, paymentGatewayNames: ['shopify_payments'],
    customer: { id: 'gid://shopify/Customer/5550001', firstName: 'Klara', lastName: 'Kundin', defaultEmailAddress: { emailAddress: 'kundin@example.com' } },
    totalPriceSet: { shopMoney: { amount: (Number(brutto) * qty).toFixed(2), currencyCode: 'EUR' } },
    currentTotalPriceSet: { shopMoney: { amount: (Number(brutto) * qty).toFixed(2) } },
    shippingAddress: { name: 'Klara Kundin', address1: 'Retourenweg 1', address2: null, zip: '32457', city: 'Porta Westfalica', countryCodeV2: 'DE', phone: null },
    billingAddress: null,
    shippingLine: null,
    lineItems: {
      nodes: [{
        id: `gid://shopify/LineItem/${gid.split('/').pop()}-0`, title: sku, variantTitle: null, sku, quantity: qty, currentQuantity: qty, variant: null,
        originalUnitPriceSet: { shopMoney: { amount: brutto } }, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: brutto } }, taxLines: [{ rate: 0.19 }],
      }],
    },
    ...extra,
  }
}

async function webhook(gid: string, topic = 'orders/updated'): Promise<void> {
  await h.sql`insert into shopify_webhook_events (webhook_id, topic, shopify_order_id, payload)
              values (${`rt-${++nr}`}, ${topic}, ${gid}, '{}'::jsonb)`
  const r = await processPendingWebhooks(5)
  const [ev] = await h.sql<{ error: string | null }[]>`select error from shopify_webhook_events where webhook_id = ${`rt-${nr}`}`
  assert.equal(r.failed, 0, `Webhook ohne Fehler: ${ev.error ?? ''}`)
}

async function auftrag(gid: string): Promise<string> {
  const [so] = await h.sql<{ id: string }[]>`select id from sales_orders where shopify_order_id = ${gid}`
  return so.id
}

async function liefern(orderId: string): Promise<void> {
  const [p] = await h.sql<{ id: string }[]>`
    select id from stock_pickings where origin_model = 'sales_order' and origin_id = ${orderId} and state not in ('done', 'cancel') limit 1`
  await aktion('lager.transfer_buchen', p.id, { mengen: {}, lose: {}, backorder: false })
}

async function zeile(orderId: string): Promise<string> {
  const [z] = await h.sql<{ id: string }[]>`select id from sales_order_lines where order_id = ${orderId} order by sequence limit 1`
  return z.id
}

before(async () => {
  h = await harnessStart(DATENBANK)
  await aktion('einstellungen.shopify_modus_setzen', undefined, { modus: 'schreiben' })
  const artikel = async (name: string, sku: string, opts: { preis: number; route?: 'kaufen' | 'fertigen'; mto?: boolean; bestand?: number; einkaufbar?: boolean; verkaufbar?: boolean }) => {
    const r = await aktion('produkte.produkt_anlegen', undefined, {
      name, sku, verkaufspreis: opts.preis, einstandspreis: 5, gewicht_g: 500, verkaufbar: opts.verkaufbar ?? true,
      einkaufbar: opts.einkaufbar ?? false, route: opts.route ?? 'kaufen', attribute: [],
    })
    const [pv] = await h.sql<{ id: string }[]>`select id from product_variants where template_id = ${r.recordId!}`
    if (opts.mto) await h.sql`update product_templates set route_mto = true where id = ${r.recordId!}`
    if (opts.bestand) {
      const z = await aktion('lager.zaehlung_erfassen', undefined, { variant_id: pv.id, counted_qty: opts.bestand })
      await aktion('lager.zaehlung_buchen', z.recordId)
    }
    return { id: pv.id, template: r.recordId! }
  }
  const teil = await artikel('Gehäuse', 'RT-CASE', { preis: 0, einkaufbar: true, verkaufbar: false, bestand: 50 })
  const board = await artikel('Retourenboard', 'RT-KB', { preis: 199, route: 'fertigen', mto: true })
  const bom = await aktion('fertigung.stueckliste_anlegen', undefined, { template_id: board.template, qty: 1 })
  await aktion('fertigung.stueckliste_position_hinzufuegen', bom.recordId, { component_variant_id: teil.id, qty: 1, issue_method: 'backflush', ptav_ids: [] })
  const mat = await artikel('Retourenmatte', 'RT-MAT', { preis: 29, bestand: 20 })
  Object.assign(v, { teil: teil.id, board: board.id, mat: mat.id })
  await aktion('kontakte.partner_anlegen', undefined, { name: 'Laden um die Ecke', is_company: true, is_customer: true, is_vendor: false, country_code: 'DE', street: 'Hauptstraße', house_number: '1', zip: '32457', city: 'Porta Westfalica' })
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

describe('Retouren: Portal, Erstattung vor der Prüfung, Gegenrechnung bei der nächsten Bestellung', () => {
  const GID_MAT = 'gid://shopify/Order/7701'
  const GID_KB = 'gid://shopify/Order/7702'

  test('nur Shop-Aufträge, nur Geliefertes', async () => {
    const r = await aktion('verkauf.auftrag_mit_positionen', undefined, { kunde: 'Laden um die Ecke', positionen: [{ produkt: 'RT-MAT', menge: 1, preis: 25 }] })
    await aktion('verkauf.bestaetigen', r.recordId)
    await assert.rejects(
      aktion('versand.retoure_anlegen', r.recordId, { positionen: [{ zeile: await zeile(r.recordId!), menge: 1 }] }),
      /nur für Shop-Aufträge/,
    )
    fakeOrderHinterlegen(order(GID_MAT, '#7701', 'RT-MAT', 3, '34.51') as never)
    await webhook(GID_MAT, 'orders/create')
    const so = await auftrag(GID_MAT)
    v.matAuftrag = so
    await assert.rejects(
      aktion('versand.retoure_anlegen', so, { positionen: [{ zeile: await zeile(so), menge: 1 }] }),
      /höchstens 0 zurücksendbar/,
      'vor der Lieferung ist nichts zurücksendbar',
    )
    await liefern(so)
  })

  test('Portal: Nummer + E-Mail der Bestellung, sonst „nicht gefunden"; Honigtopf; Mengen gedeckelt', async () => {
    assert.equal((await bestellungFinden('7701', 'fremd@example.com', null)).art, 'nicht_gefunden', 'falsche E-Mail verrät nichts')
    assert.equal((await bestellungFinden('#9999', 'kundin@example.com', null)).art, 'nicht_gefunden')
    const suche = await bestellungFinden('7701', 'KUNDIN@example.com', null)
    assert.equal(suche.art, 'ok')
    if (suche.art !== 'ok') return
    assert.deepEqual(suche.bestellung.zeilen.map((z) => z.frei), [3])
    // Angemeldeter Kunde: ohne E-Mail, über die signierte Kunden-ID.
    assert.equal((await bestellungFinden('#7701', '', '5550001')).art, 'ok')
    assert.equal((await bestellungFinden('#7701', '', '5550002')).art, 'nicht_gefunden')

    // Suchdrossel (0131): nach 10 Fehlversuchen zu einer E-Mail ist die Suche
    // für sie gesperrt — auch mit der richtigen Nummer; ebenso je Nummer.
    for (let i = 0; i < 9; i++) assert.equal((await bestellungFinden(`#88${i}`, 'rater@example.com', null)).art, 'nicht_gefunden')
    assert.equal((await bestellungFinden('#7701', 'rater@example.com', null)).art, 'nicht_gefunden', 'der zehnte Fehlversuch zählt noch')
    assert.equal((await bestellungFinden('#7701', 'rater@example.com', null)).art, 'gedrosselt')
    assert.equal((await retoureAufnehmen({ bestellnummer: '#7701', email: 'rater@example.com' }, { kundeId: null })).art, 'gedrosselt')
    for (let i = 0; i < 10; i++) assert.equal((await bestellungFinden('#9998', `p${i}@example.com`, null)).art, 'nicht_gefunden')
    assert.equal((await bestellungFinden('#9998', 'p99@example.com', null)).art, 'gedrosselt', 'Nummer durchprobieren mit vielen Adressen')
    assert.equal((await bestellungFinden('7701', 'kundin@example.com', null)).art, 'ok', 'Unbeteiligte bleiben frei')
    const [{ klartext }] = await h.sql<{ klartext: number }[]>`
      select count(*)::int as klartext from portal_suchversuche where kennung_hash ilike '%example.com%' or kennung_hash like '#%'`
    assert.equal(klartext, 0, 'nur Hashes gespeichert')
    await h.sql`delete from portal_suchversuche`

    const z = suche.bestellung.zeilen[0].id
    assert.equal((await retoureAufnehmen({ bestellnummer: '#7701', email: 'kundin@example.com', webseite: 'spam', [`menge_${z}`]: '1' }, { kundeId: null })).art, 'honigtopf')
    const zuviel = await retoureAufnehmen({ bestellnummer: '#7701', email: 'kundin@example.com', [`menge_${z}`]: '4' }, { kundeId: null })
    assert.deepEqual(zuviel, { art: 'fehler', meldung: 'RT-MAT: höchstens 3 zurücksendbar.' })

    const ok = await retoureAufnehmen(
      { bestellnummer: '#7701', email: 'kundin@example.com', [`menge_${z}`]: '2', [`grund_${z}`]: 'Falscher Artikel bestellt', anliegen: 'Eine reicht.' },
      { kundeId: null },
    )
    assert.equal(ok.art, 'ok')
    if (ok.art !== 'ok') return
    assert.match(ok.nummer, /^RT\/\d{5}$/)
    const [r] = await h.sql<{ id: string; quelle: string; status: string; email: string; grund: string; shop_brutto_vorher: number }[]>`
      select id, quelle, status::text as status, email, grund, shop_brutto_vorher from retouren where nummer = ${ok.nummer}`
    assert.deepEqual([r.quelle, r.status, r.email, r.grund, Number(r.shop_brutto_vorher)], ['shop', 'angefragt', 'kundin@example.com', 'Eine reicht.', 103.53])
    v.portalRetoure = r.id
    const [job] = await h.sql<{ n: number }[]>`select count(*)::int as n from integration_jobs where kind = 'send_return_request_email' and payload ->> 'retoure_id' = ${r.id}`
    assert.equal(job.n, 1, 'Eingangsbestätigung über die Outbox')
    // Nach der Anfrage ist nur noch 1 zurücksendbar.
    const danach = await bestellungFinden('7701', 'kundin@example.com', null)
    assert.equal(danach.art === 'ok' && danach.bestellung.zeilen[0].frei, 1)
    // Seiten rendern ohne Liquid-Injektion aus Kundendaten.
    assert.ok(!suchSeite({ aktion: '/apps/reparatur', bestellnummer: '{{ x }}' }).includes('{{ x }}'))
    assert.match(auswahlSeite({ aktion: '/apps/reparatur', bestellnummer: '#7701', email: 'k@example.com', zeilen: [{ id: z, name: 'Matte', frei: 1 }] }), /action="\/apps\/reparatur\/retoure"/)
  })

  test('Erstattung VOR der Prüfung: erkannt am Webhook, die Prüfung schließt dann gleich ab', async () => {
    const id = v.portalRetoure
    await aktion('versand.retoure_genehmigen', id, { label_senden: false })
    await aktion('versand.retoure_eingang', id)
    // Der Shop erstattet 2 Matten, bevor wir geprüft haben.
    fakeOrderHinterlegen(order(GID_MAT, '#7701', 'RT-MAT', 3, '34.51', {
      displayFinancialStatus: 'PARTIALLY_REFUNDED', displayFulfillmentStatus: 'FULFILLED',
      currentTotalPriceSet: { shopMoney: { amount: '34.51' } },
      lineItems: { nodes: [{ id: 'gid://shopify/LineItem/7701-0', title: 'RT-MAT', variantTitle: null, sku: 'RT-MAT', quantity: 3, currentQuantity: 1, variant: null,
        originalUnitPriceSet: { shopMoney: { amount: '34.51' } }, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '34.51' } }, taxLines: [{ rate: 0.19 }] }] },
    }) as never)
    await webhook(GID_MAT)
    const [vorher] = await h.sql<{ status: string; erstattet: boolean }[]>`select status::text as status, erstattet_am is not null as erstattet from retouren where id = ${id}`
    assert.deepEqual([vorher.status, vorher.erstattet], ['eingegangen', true], 'erstattet erkannt, die Prüfung steht noch aus')
    const [{ frei: freiVorher }] = await h.sql<{ frei: number }[]>`select free_to_use(${v.mat})::float as frei`
    const [p] = await h.sql<{ id: string }[]>`select id from retoure_positionen where retoure_id = ${id}`
    const r = await aktion('versand.retoure_pruefen', id, { ergebnisse: [{ position: p.id, pruefung: 'verkaufsfaehig' }] })
    assert.match(r?.text ?? '', /Der Shop hatte schon erstattet — abgeschlossen/)
    const [nachher] = await h.sql<{ status: string }[]>`select status::text as status from retouren where id = ${id}`
    assert.equal(nachher.status, 'abgeschlossen')
    const [{ frei }] = await h.sql<{ frei: number }[]>`select free_to_use(${v.mat})::float as frei`
    assert.equal(frei, freiVorher + 2, 'verkaufsfähig zurück im freien Bestand')
    await assert.rejects(aktion('versand.retoure_stornieren', id, {}), /dieser Schritt geht nur aus/)
  })

  test('Gegenrechnung: verkaufsfähiger Rückläufer ohne wartenden Auftrag → der nächste Auftrag wird nicht gefertigt', async () => {
    fakeOrderHinterlegen(order(GID_KB, '#7702', 'RT-KB', 1, '236.81') as never)
    await webhook(GID_KB, 'orders/create')
    const kb = await auftrag(GID_KB)
    const [mo] = await h.sql<{ id: string }[]>`select id from manufacturing_orders where sales_order_id = ${kb} and state = 'confirmed'`
    assert.ok(mo, 'ohne Fertigbestand wird gefertigt')
    await aktion('fertigung.fertig_melden', mo.id, { mengen: {}, backorder: false })
    await liefern(kb)
    const rt = await aktion('versand.retoure_anlegen', kb, { positionen: [{ zeile: await zeile(kb), menge: 1, grund: 'Gefällt mir nicht / passt nicht' }] })
    await aktion('versand.retoure_genehmigen', rt.recordId, { label_senden: false })
    await aktion('versand.retoure_eingang', rt.recordId)
    const [p] = await h.sql<{ id: string }[]>`select id from retoure_positionen where retoure_id = ${rt.recordId!}`
    await aktion('versand.retoure_pruefen', rt.recordId, { ergebnisse: [{ position: p.id, pruefung: 'verkaufsfaehig' }] })
    const ab = await aktion('versand.retoure_abschliessen', rt.recordId, { erstattung_bestaetigt: true })
    assert.match(ab?.text ?? '', /keine wartende Fertigung — der Rückläufer liegt frei im Lager/)
    await assert.rejects(aktion('versand.retoure_abschliessen', rt.recordId, { erstattung_bestaetigt: false }), /bestätigen|Übergang|abgeschlossen/)

    // Nächster Kunde, dasselbe Board: aus dem Lager, ohne Fertigungsauftrag.
    fakeOrderHinterlegen(order('gid://shopify/Order/7703', '#7703', 'RT-KB', 1, '236.81') as never)
    await webhook('gid://shopify/Order/7703', 'orders/create')
    const naechster = await auftrag('gid://shopify/Order/7703')
    const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from manufacturing_orders where sales_order_id = ${naechster}`
    assert.equal(n, 0, 'der Rückläufer deckt den Auftrag — keine Fertigung')
    const [lief] = await h.sql<{ state: string }[]>`
      select state::text as state from stock_pickings where origin_model = 'sales_order' and origin_id = ${naechster}`
    assert.equal(lief.state, 'assigned', 'die Lieferung ist sofort reserviert')
    const [notiz] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from audit_log where model = 'sales_order' and record_id = ${naechster} and message like '%aus Rückläufer (Retoure) bedient%'`
    assert.equal(notiz.n, 1)
  })
})
