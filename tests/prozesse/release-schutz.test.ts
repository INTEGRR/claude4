/**
 * Release-Schutz (Entscheidungslog 2026-11-27, Pakete S1–S8): Was am
 * Release-Tag nicht passieren darf — doppelt reservierte Ware, Versand
 * unbezahlter Bestellungen, Überverkauf geteilter Teile.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'
import {
  fakeBestand, fakeBestandLeeren, fakeBestandSetzen, fakeKauf, fakeOrderHinterlegen,
} from '../../src/modules/integrationen/shopify-fake.ts'
import { buchAbgleichen, inventarAbgleichen, verarbeiteInventarWebhook } from '../../src/modules/integrationen/inventar.ts'
import { importShopifyOrder, processPendingWebhooks } from '../../src/modules/integrationen/import.ts'
import { packtischBelegLaden } from '../../src/modules/versand/packtisch-beleg.ts'
import { angehalteneLieferungen } from '../../src/modules/versand/angehalten.ts'

const DATENBANK = 'erp_release_schutz_check'
const ADMIN = { name: 'release-test', role: 'admin' as const }
let h: Harness
let webhookNr = 0

const aktion = (name: string, recordId: string | undefined, parameter: Record<string, unknown> = {}) =>
  aktionAusfuehrenGeprueft(name, { recordId, parameter }, ADMIN)

const gid = (nr: number) => `gid://shopify/Order/${nr}`

function bestellung(nr: number, sku: string, menge: number, zahlstatus = 'PAID', extra: Record<string, unknown> = {}) {
  return {
    id: gid(nr), name: `#${nr}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    email: 'kunde@example.com', tags: [], displayFinancialStatus: zahlstatus, displayFulfillmentStatus: 'UNFULFILLED',
    cancelledAt: null, taxesIncluded: true, paymentGatewayNames: ['shopify_payments'],
    customer: { id: 'gid://shopify/Customer/7000', firstName: 'Rita', lastName: 'Release', defaultEmailAddress: { emailAddress: 'kunde@example.com' } },
    totalPriceSet: { shopMoney: { amount: '34.51', currencyCode: 'EUR' } },
    currentTotalPriceSet: { shopMoney: { amount: '34.51' } },
    totalOutstandingSet: { shopMoney: { amount: zahlstatus === 'PAID' ? '0.00' : '34.51' } },
    shippingAddress: { name: 'Rita Release', address1: 'Am Markt 3', address2: null, zip: '32457', city: 'Porta Westfalica', countryCodeV2: 'DE', phone: null },
    billingAddress: { name: 'Rita Release', company: null, address1: 'Am Markt 3', address2: null, zip: '32457', city: 'Porta Westfalica', countryCodeV2: 'DE' },
    shippingLine: null,
    lineItems: {
      nodes: [{
        id: `gid://shopify/LineItem/${nr}-0`, title: sku, variantTitle: null, sku,
        quantity: menge, currentQuantity: menge, variant: null,
        originalUnitPriceSet: { shopMoney: { amount: '34.51' } },
        discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '34.51' } }, taxLines: [{ rate: 0.19 }],
      }],
    },
    ...extra,
  }
}

async function webhook(nr: number, topic = 'orders/updated'): Promise<void> {
  await h.sql`insert into shopify_webhook_events (webhook_id, topic, shopify_order_id, payload)
              values (${`rs-${++webhookNr}`}, ${topic}, ${gid(nr)}, '{}'::jsonb)`
  const r = await processPendingWebhooks(5)
  const [ev] = await h.sql<{ error: string | null }[]>`
    select error from shopify_webhook_events where webhook_id = ${`rs-${webhookNr}`}`
  assert.equal(r.failed, 0, `Webhook ohne Fehler: ${ev.error ?? ''}`)
}

async function lagerartikel(sku: string, bestand: number): Promise<string> {
  const r = await aktion('produkte.produkt_anlegen', undefined, {
    name: `Artikel ${sku}`, sku, verkaufspreis: 29, einstandspreis: 9, gewicht_g: 500,
    verkaufbar: true, einkaufbar: true, route: 'kaufen', attribute: [],
  })
  const [pv] = await h.sql<{ id: string }[]>`select id from product_variants where template_id = ${r.recordId!}`
  if (bestand > 0) {
    const z = await aktion('lager.zaehlung_erfassen', undefined, { variant_id: pv.id, counted_qty: bestand })
    await aktion('lager.zaehlung_buchen', z.recordId)
  }
  return pv.id
}

async function auftrag(nr: number) {
  const [so] = await h.sql<{ id: string; state: string; zahlstatus: string | null }[]>`
    select id, state::text as state, shopify_zahlstatus as zahlstatus from sales_orders where shopify_order_id = ${gid(nr)}`
  return so
}

async function lieferung(nr: number) {
  const [p] = await h.sql<{ id: string; number: string; state: string; reserviert: number }[]>`
    select p.id, p.number, p.state::text as state,
           (select coalesce(sum(m.reserved_qty), 0)::float from stock_moves m where m.picking_id = p.id) as reserviert
    from stock_pickings p
    join sales_orders so on so.id = p.origin_id and p.origin_model = 'sales_order'
    where so.shopify_order_id = ${gid(nr)}`
  return p
}

before(async () => {
  h = await harnessStart(DATENBANK)
  await aktion('einstellungen.shopify_modus_setzen', undefined, { modus: 'schreiben' })
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

describe('S2 — Reservierung mit Sperre', () => {
  test('zwei gleichzeitige Bestellungen um das letzte Stück: genau eine reserviert', async () => {
    const variante = await lagerartikel('RS-LETZTES', 1)
    // Beide Importe laufen gleichzeitig auf eigenen Verbindungen.
    const ergebnisse = await Promise.all(
      [7001, 7002].map((nr) => importShopifyOrder(bestellung(nr, 'RS-LETZTES', 1) as never)),
    )
    assert.ok(ergebnisse.every((e) => e.created), 'beide Bestellungen sind angelegt')
    const reserviert = [(await lieferung(7001)).reserviert, (await lieferung(7002)).reserviert]
    assert.equal(reserviert[0] + reserviert[1], 1, `genau ein Stück reserviert, nicht ${reserviert.join(' + ')}`)
    const [q] = await h.sql<{ on_hand: number; reserved: number }[]>`
      select sum(on_hand)::float as on_hand, sum(reserved)::float as reserved from stock_quants q
      join stock_locations l on l.id = q.location_id where q.variant_id = ${variante} and l.type = 'internal'`
    assert.deepEqual([q.on_hand, q.reserved], [1, 1], 'der Bestand ist nie doppelt vergeben')
  })

  test('zwanzig gleichzeitige Bestellungen auf zehn Stück: zehn reserviert, zehn warten', async () => {
    await lagerartikel('RS-ZEHN', 10)
    const nummern = Array.from({ length: 20 }, (_, i) => 7100 + i)
    await Promise.all(nummern.map((nr) => importShopifyOrder(bestellung(nr, 'RS-ZEHN', 1) as never)))
    const stand = await Promise.all(nummern.map((nr) => lieferung(nr)))
    assert.equal(stand.reduce((s, l) => s + l.reserviert, 0), 10)
    assert.equal(stand.filter((l) => l.state === 'assigned').length, 10)
  })
})

describe('Reservieren beim Eingang — unbezahlt wird reserviert, aber nicht versandt', () => {
  test('Bestellung mit offener Zahlung: bestätigt und reserviert, nicht versandbereit', async () => {
    await lagerartikel('RS-VORKASSE', 3)
    fakeOrderHinterlegen(bestellung(7200, 'RS-VORKASSE', 2, 'PENDING') as never)
    await webhook(7200, 'orders/create')

    const a = await auftrag(7200)
    assert.deepEqual([a.state, a.zahlstatus], ['sale', 'PENDING'])
    const l = await lieferung(7200)
    assert.deepEqual([l.state, l.reserviert], ['assigned', 2], 'die Ware ist der Bestellung vorbehalten')
    const [{ n }] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from shipping_ready where shopify_order_name = '#7200'`
    assert.equal(Number(n), 0, 'unbezahlt ist nicht versandbereit')
    assert.deepEqual(
      (await angehalteneLieferungen()).filter((x) => x.shopify === '#7200').map((x) => x.grund),
      ['Zahlung offen'],
    )
  })

  test('unbezahlt: Packtisch, Label und Ausbuchen verweigern', async () => {
    const l = await lieferung(7200)
    const pack = await packtischBelegLaden(l.number)
    assert.match(pack.ok ? '' : pack.error, /#7200 ist laut Shopify noch nicht bezahlt/)
    await assert.rejects(aktion('versand.label_erstellen', l.id), /noch nicht bezahlt/)
    await assert.rejects(h.sql`select picking_validate(${l.id}, '{}'::jsonb, false)`, /#7200 ist laut Shopify noch nicht bezahlt/)
  })

  test('Zahlung geht ein: versandbereit, Label geht durch', async () => {
    fakeOrderHinterlegen(bestellung(7200, 'RS-VORKASSE', 2, 'PAID') as never)
    await webhook(7200, 'orders/paid')
    const [{ n }] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from shipping_ready where shopify_order_name = '#7200'`
    assert.equal(Number(n), 1)
    const l = await lieferung(7200)
    await aktion('versand.label_erstellen', l.id)
    assert.equal((await lieferung(7200)).state, 'done')
  })

  test('unbezahlte Bestellung platzt: Storno gibt die Reservierung frei', async () => {
    fakeOrderHinterlegen(bestellung(7201, 'RS-VORKASSE', 1, 'PENDING') as never)
    await webhook(7201, 'orders/create')
    assert.equal((await lieferung(7201)).reserviert, 1)
    fakeOrderHinterlegen(bestellung(7201, 'RS-VORKASSE', 1, 'VOIDED', { cancelledAt: new Date().toISOString() }) as never)
    await webhook(7201, 'orders/cancelled')
    assert.equal((await auftrag(7201)).state, 'cancel')
    const [q] = await h.sql<{ reserved: number }[]>`
      select coalesce(sum(q.reserved), 0)::float as reserved from stock_quants q
      join product_variants pv on pv.id = q.variant_id where pv.sku = 'RS-VORKASSE'`
    assert.equal(q.reserved, 0, 'nichts bleibt gebunden')
  })
})

// --- Kontingent und Buch (S1, S3, S5–S7) -----------------------------------------

/** Drei Tastaturen, die sich EIN Gehäuse teilen; jede mit eigenen Switches. */
const kb: Record<string, { variante: string; item: string; gid: string; sku: string }> = {}
let gehaeuse = ''

async function rohartikel(name: string, bestand: number): Promise<string> {
  const [uom] = await h.sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await h.sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, can_be_sold) values (${name}, ${uom.id}, false) returning id`
  await h.sql`select generate_variants(${tpl.id})`
  const [v] = await h.sql<{ id: string }[]>`select id from product_variants where template_id = ${tpl.id}`
  await bestandSetzen(v.id, bestand)
  return v.id
}

async function bestandSetzen(variante: string, menge: number): Promise<void> {
  const [lager] = await h.sql<{ id: string }[]>`select id from stock_locations where full_path = 'WH/Stock'`
  const [ist] = await h.sql<{ n: number }[]>`
    select coalesce(sum(on_hand), 0)::float as n from stock_quants where variant_id = ${variante} and location_id = ${lager.id}`
  const [z] = await h.sql<{ id: string }[]>`
    insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
    values (${lager.id}, ${variante}, ${menge}, ${ist.n}) returning id`
  await h.sql`select inventory_apply(${z.id}, 'test')`
}

async function tastatur(kuerzel: string, nr: number, switches: number): Promise<void> {
  const [uom] = await h.sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const sw = await rohartikel(`Switch ${kuerzel}`, switches)
  const [tpl] = await h.sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, can_be_sold, route_manufacture, route_mto)
    values (${`Tastatur ${kuerzel}`}, ${uom.id}, true, true, true) returning id`
  await h.sql`select generate_variants(${tpl.id})`
  const gidV = `gid://shopify/ProductVariant/${nr}`
  const item = `gid://shopify/InventoryItem/${nr}`
  const sku = `KB-${kuerzel}`
  const [v] = await h.sql<{ id: string }[]>`
    update product_variants set sku = ${sku}, shopify_variant_id = ${gidV}, shopify_inventory_item_gid = ${item}
    where template_id = ${tpl.id} returning id`
  const [bom] = await h.sql<{ id: string }[]>`
    insert into boms (template_id, qty, uom_id) values (${tpl.id}, 1, ${uom.id}) returning id`
  await h.sql`insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
              values (${bom.id}, 10, ${gehaeuse}, 1, ${uom.id}), (${bom.id}, 20, ${sw}, 85, ${uom.id})`
  kb[kuerzel] = { variante: v.id, item, gid: gidV, sku }
}

/** Freien Gehäuse-Bestand setzen (Bestand = schon Reserviertes + n). */
async function gehaeuseFreiSetzen(n: number): Promise<void> {
  const [{ reserviert }] = await h.sql<{ reserviert: number }[]>`
    select coalesce(sum(reserved), 0)::float as reserviert from stock_quants where variant_id = ${gehaeuse}`
  await bestandSetzen(gehaeuse, reserviert + n)
}

const shop = (k: string): number => fakeBestand(kb[k].item) ?? 0

/** Wie shopStandHolen im Viertelstunden-Abgleich: was der Shop je Angebot gerade zeigt. */
async function shopStandLesen(): Promise<void> {
  for (const k of Object.keys(kb)) {
    await h.sql`update shopify_inventory_state set shop_qty = ${shop(k)}, shop_seen_at = now() + interval '1 second'
                where variant_id = ${kb[k].variante}`
  }
}
const shopSumme = (): number => Object.keys(kb).reduce((s, k) => s + shop(k), 0)
const gehaeuseFrei = async (): Promise<number> =>
  Number((await h.sql<{ n: number }[]>`select free_to_use(${gehaeuse})::float as n`)[0].n)
const buch = async (k: string): Promise<number> =>
  Number((await h.sql<{ n: number }[]>`select pushed_qty::float as n from shopify_inventory_state where variant_id = ${kb[k].variante}`)[0].n)

let bestellNr = 8000
/** Ein Kauf im Shop: der Shop zählt sofort herunter; die Bestellung kommt erst mit `einlesen` bei KRNL an. */
function kaufen(k: string, menge = 1): (() => Promise<void>) | null {
  if (!fakeKauf(kb[k].item, menge)) return null
  const nr = ++bestellNr
  const b = bestellung(nr, kb[k].sku, menge, 'PAID')
  ;(b.lineItems.nodes[0] as { variant: unknown }).variant = { id: kb[k].gid }
  return async () => {
    await importShopifyOrder(b as never)
  }
}

describe('Kontingent und Buch — geteilte Teile werden nie doppelt angeboten', () => {
  test('Vorbereitung: drei Tastaturen teilen sich 12 Gehäuse', async () => {
    fakeBestandLeeren()
    await h.sql`update settings set value = value || ${h.sql.json({ mto: { modus: 'baubar', puffer: 0, deckel: 99 } })}::jsonb where key = 'shopify'`
    // Alles aus den Tests davor abkoppeln — hier zählt nur das Trio.
    await h.sql`update product_variants set shopify_variant_id = null where shopify_variant_id is not null`
    gehaeuse = await rohartikel('Gehäuse geteilt', 12)
    await tastatur('GELB', 9101, 850)
    await tastatur('BRAUN', 9102, 850)
    await tastatur('BLAU', 9103, 850)
  })

  test('S3: jede Tastatur allein könnte 10 — angeboten werden zusammen 12, nicht 30', async () => {
    const r = await inventarAbgleichen()
    assert.equal(r.uebertragen, 3)
    assert.deepEqual([shop('GELB'), shop('BRAUN'), shop('BLAU')], [4, 4, 4])
    assert.equal(shopSumme(), await gehaeuseFrei())
    // Das Buch läuft seit einer Minute (die Bestellungen unten sind „später" angelegt).
    await h.sql`update shopify_inventory_state set buch_ab = buch_ab - interval '1 minute'`
  })

  test('S1: ein Kauf, den KRNL noch nicht kennt, wird von der nächsten Meldung NICHT überschrieben', async () => {
    const einlesen = kaufen('GELB', 2)!
    assert.equal(shop('GELB'), 2, 'der Shop hat sofort heruntergezählt')

    // KRNL meldet neu, ohne die Bestellung zu kennen (hier: Inventur findet nur 9 Gehäuse).
    await bestandSetzen(gehaeuse, 9)
    await inventarAbgleichen()
    assert.deepEqual([shop('GELB'), shop('BRAUN'), shop('BLAU')], [1, 3, 3],
      'Differenz −1 je Angebot — eine absolute Menge hätte Gelb wieder auf 3 gehoben')
    assert.equal(shopSumme(), 9 - 2, 'im Shop steht genau, was nach dem unbekannten Kauf noch da ist')

    // Die Bestellung kommt an: Buch und Shop stimmen wieder überein.
    await einlesen()
    assert.equal(await buch('GELB'), shop('GELB'))
    assert.equal(await gehaeuseFrei(), 7)
    await inventarAbgleichen()
    assert.equal(shopSumme(), 7, 'neu verteilt — die Summe bleibt der freie Bestand')
    assert.ok(shop('GELB') > shop('BLAU'), 'was sich verkauft, bekommt den größeren Anteil')
  })

  test('S1: 300 Schritte kreuz und quer — kaufen, verspätet einlesen, melden — nie mehr verkauft als Gehäuse da', async () => {
    let saat = 4711
    const zufall = () => {
      saat = (saat * 1664525 + 1013904223) % 4294967296
      return saat / 4294967296
    }
    const anfang = await gehaeuseFrei()
    const unterwegs: (() => Promise<void>)[] = []
    let verkauft = 0
    const namen = Object.keys(kb)
    for (let schritt = 0; schritt < 300; schritt++) {
      const w = zufall()
      if (w < 0.5) {
        const k = namen[Math.floor(zufall() * namen.length)]
        const einlesen = kaufen(k, 1)
        if (einlesen) {
          verkauft++
          unterwegs.push(einlesen)
        }
      } else if (w < 0.8 && unterwegs.length > 0) {
        // Bestellungen kommen in beliebiger Reihenfolge an.
        const [b] = unterwegs.splice(Math.floor(zufall() * unterwegs.length), 1)
        await b()
      } else {
        await inventarAbgleichen()
      }
      // Die Garantie gilt in JEDEM Augenblick: was der Shop noch anbietet,
      // plus was er schon verkauft hat, übersteigt nie den Anfangsbestand.
      assert.ok(verkauft + shopSumme() <= anfang, `Schritt ${schritt}: ${verkauft} verkauft + ${shopSumme()} angeboten > ${anfang}`)
    }
    for (const b of unterwegs) await b()
    await inventarAbgleichen()
    assert.ok(verkauft <= anfang, `${verkauft} verkauft bei ${anfang} Gehäusen`)
    assert.equal(await gehaeuseFrei(), anfang - verkauft)
    assert.equal(shopSumme(), anfang - verkauft, 'am Ende steht im Shop genau der Rest')
    for (const k of namen) assert.equal(await buch(k), shop(k), `Buch ${k}`)
  })

  test('Storno: die Menge zählt wieder zum Angebot; lagert der Shop nicht zurück, heilt der Abgleich in ruhiger Zeit', async () => {
    await gehaeuseFreiSetzen(6)
    await inventarAbgleichen()
    const einlesen = kaufen('BRAUN', 1)!
    await einlesen()
    const [so] = await h.sql<{ shopify_order_id: string }[]>`
      select shopify_order_id from sales_orders where shopify_order_name = ${`#${bestellNr}`}`
    const b = bestellung(bestellNr, kb.BRAUN.sku, 1, 'REFUNDED', { cancelledAt: new Date().toISOString() })
    ;(b.lineItems.nodes[0] as { variant: unknown }).variant = { id: kb.BRAUN.gid }
    b.id = so.shopify_order_id
    await importShopifyOrder(b as never)
    assert.equal(await gehaeuseFrei(), 6, 'die Reservierung ist frei')
    await inventarAbgleichen()
    // Der Fake lagert nicht zurück: der Shop zeigt eins weniger als das Buch — die sichere Seite.
    assert.equal(shopSumme(), 5)

    // Viertelstunden-Abgleich liest den Shop-Stand; in ruhiger Zeit übernimmt das Buch ihn.
    await shopStandLesen()
    assert.equal((await buchAbgleichen()).runter, 0, 'eben erst kam eine Bestellung für diesen Artikel — nichts anfassen')
    await inventarAbgleichen()
    assert.equal(shopSumme(), 5)
    await h.sql`update sales_orders set created_at = created_at - interval '10 minutes' where source = 'shopify'`
    await shopStandLesen()
    const r = await buchAbgleichen()
    assert.deepEqual([r.ruhe, r.runter, r.hoch], [true, 1, 0])
    await inventarAbgleichen()
    assert.equal(shopSumme(), 6, 'der Shop hat den Rest zurück')
  })

  test('S7: jemand bucht im Shop von Hand hoch — das Buch übernimmt, der Abgleich senkt, Telegram meldet', async () => {
    const vorher = shop('BLAU')
    fakeBestandSetzen(kb.BLAU.item, vorher + 20)
    const m = await verarbeiteInventarWebhook({
      inventory_item_id: kb.BLAU.item, available: vorher + 20, updated_at: new Date(Date.now() + 5000).toISOString(),
    })
    assert.match(m, /Buch übernimmt den Shop-Stand/)
    await inventarAbgleichen()
    assert.equal(shop('BLAU'), vorher)
    assert.equal(shopSumme(), await gehaeuseFrei())

    // Dasselbe über den Viertelstunden-Abgleich (ohne Webhook).
    fakeBestandSetzen(kb.GELB.item, shop('GELB') + 7)
    await shopStandLesen()
    const r = await buchAbgleichen()
    assert.equal(r.hoch, 1)
    await inventarAbgleichen()
    assert.equal(shopSumme(), await gehaeuseFrei())
    const [{ n }] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from benachrichtigungen where art = 'ueberverkauf' and schluessel like 'abweichung:%'`
    assert.equal(Number(n), 1)
  })

  test('S3: erwartete Nachfrage — doppeltes Gewicht bekommt doppelt so viel', async () => {
    await h.sql`update sales_orders set order_date = order_date - interval '1 day' where source = 'shopify'`
    await gehaeuseFreiSetzen(8)
    const [tpl] = await h.sql<{ template_id: string }[]>`select template_id from product_variants where id = ${kb.BLAU.variante}`
    const r = await aktion('verkauf.shop_gewicht_setzen', undefined, { template_id: tpl.template_id, gewicht: 2, alle_farben: false })
    assert.match(r.text ?? '', /Gewicht von „Tastatur BLAU": 2/)
    await inventarAbgleichen()
    assert.deepEqual([shop('GELB'), shop('BRAUN'), shop('BLAU')], [2, 2, 4])
  })

  test('S6: Not-Aus setzt alles sofort auf ausverkauft; Aufheben verteilt neu', async () => {
    const r = await aktion('verkauf.shop_not_aus', undefined, { aktiv: true })
    assert.match(r.text ?? '', /Not-Aus aktiv/)
    assert.equal(shopSumme(), 0)
    assert.equal(kaufen('GELB'), null, 'nichts mehr zu kaufen')
    await inventarAbgleichen()
    assert.equal(shopSumme(), 0, 'bleibt aus, auch nach weiteren Abgleichen')

    await aktion('verkauf.shop_not_aus', undefined, { aktiv: false })
    assert.deepEqual([shop('GELB'), shop('BRAUN'), shop('BLAU')], [2, 2, 4])
    const [{ n }] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from benachrichtigungen where art = 'ueberverkauf' and schluessel like 'not-aus:%'`
    assert.equal(Number(n), 2, 'Auslösen und Aufheben gehen per Telegram hinaus')
  })

  test('S5: eine Bestellung ohne volle Deckung steht am Auftrag und geht per Telegram hinaus', async () => {
    await h.sql`update shopify_inventory_state set buch_ab = now() - interval '1 minute'`
    // Der Shop verkauft drei, obwohl nur noch ein Gehäuse frei ist (hier erzwungen).
    await gehaeuseFreiSetzen(1)
    fakeBestandSetzen(kb.GELB.item, 3)
    const einlesen = kaufen('GELB', 3)!
    await einlesen()
    const [so] = await h.sql<{ id: string }[]>`select id from sales_orders where shopify_order_name = ${`#${bestellNr}`}`
    const [n] = await h.sql<{ text: string }[]>`
      select text from benachrichtigungen where art = 'ueberverkauf' and schluessel = ${`ueberverkauf:${so.id}`}`
    assert.match(n.text, /Überverkauf<\/b>: Bestellung #\d+ ist nicht voll gedeckt — es fehlen: 2 × /)
    const [log] = await h.sql<{ message: string }[]>`
      select message from audit_log where model = 'sales_order' and record_id = ${so.id} and kind = 'error'`
    assert.match(log.message, /Nicht voll gedeckt — es fehlen: 2 × /)
  })
})
