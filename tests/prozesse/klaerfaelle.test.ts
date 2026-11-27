/**
 * Klärfälle gesammelt auflösen (Entscheidungslog 2026-11-23): ein Shop-Artikel,
 * den KRNL nicht kennt, hält jede Bestellung damit als Entwurf fest. Eine
 * Zuordnung löst alle Positionen dieses Artikels, die Bestellungen werden per
 * Job nachgezogen und bei Bezahlung bestätigt — der Fall vom November 2026:
 * 207 Bestellungen mit zwei neuen Shop-Produkten ohne Artikelnummer.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'
import { fakeOrderHinterlegen } from '../../src/modules/integrationen/shopify-fake.ts'
import { processPendingWebhooks } from '../../src/modules/integrationen/import.ts'
import { klaerfallGruppen } from '../../src/modules/integrationen/klaerfaelle.ts'

const DATENBANK = 'erp_klaerfaelle_check'
const ADMIN = { name: 'klaerfall-test', role: 'admin' as const }
const KEYCAPS_GID = 'gid://shopify/ProductVariant/9001'
let h: Harness
let nr = 0
const v: Record<string, string> = {}

const aktion = (name: string, recordId: string | undefined, parameter: Record<string, unknown> = {}) =>
  aktionAusfuehrenGeprueft(name, { recordId, parameter }, ADMIN)

type Zeile = { titel: string; sku: string | null; variantGid: string | null; menge: number }

function bestellung(nummer: number, zeilen: Zeile[], zahlstatus = 'PAID') {
  const gid = `gid://shopify/Order/${nummer}`
  return {
    id: gid, name: `#${nummer}`, createdAt: '2026-11-18T10:00:00Z', updatedAt: '2026-11-18T10:00:00Z',
    email: `kunde${nummer}@example.com`, tags: [], displayFinancialStatus: zahlstatus, displayFulfillmentStatus: 'UNFULFILLED',
    cancelledAt: null, taxesIncluded: true, paymentGatewayNames: ['shopify_payments'],
    customer: { id: `gid://shopify/Customer/${nummer}`, firstName: 'Kim', lastName: `Kunde ${nummer}`, defaultEmailAddress: { emailAddress: `kunde${nummer}@example.com` } },
    totalPriceSet: { shopMoney: { amount: '49.00', currencyCode: 'EUR' } },
    currentTotalPriceSet: { shopMoney: { amount: '49.00' } },
    shippingAddress: { name: 'Kim Kunde', address1: 'Testweg 1', address2: null, zip: '32457', city: 'Porta Westfalica', countryCodeV2: 'DE', phone: null },
    billingAddress: null,
    shippingLine: null,
    lineItems: {
      nodes: zeilen.map((z, i) => ({
        id: `gid://shopify/LineItem/${nummer}-${i}`, title: z.titel, variantTitle: null, sku: z.sku,
        quantity: z.menge, currentQuantity: z.menge, variant: z.variantGid ? { id: z.variantGid } : null,
        originalUnitPriceSet: { shopMoney: { amount: '49.00' } },
        discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '49.00' } }, taxLines: [{ rate: 0.19 }],
      })),
    },
  }
}

async function eingang(nummer: number, zeilen: Zeile[], zahlstatus = 'PAID'): Promise<void> {
  fakeOrderHinterlegen(bestellung(nummer, zeilen, zahlstatus))
  await h.sql`insert into shopify_webhook_events (webhook_id, topic, shopify_order_id, payload)
              values (${`kf-${++nr}`}, 'orders/create', ${`gid://shopify/Order/${nummer}`}, '{}'::jsonb)`
  const r = await processPendingWebhooks(5)
  assert.equal(r.failed, 0)
}

const auftrag = async (nummer: number) =>
  (await h.sql<{ id: string; state: string; zeilen: number }[]>`
    select so.id, so.state::text as state, (select count(*)::int from sales_order_lines l where l.order_id = so.id) as zeilen
    from sales_orders so where so.shopify_order_id = ${`gid://shopify/Order/${nummer}`}`)[0]

async function jobsAbarbeiten(): Promise<void> {
  const { runDueJobs } = await import('../../src/modules/integrationen/jobs.ts')
  for (let i = 0; i < 10; i++) if ((await runDueJobs(50)).ran === 0) break
}

const KEYCAPS: Zeile = { titel: 'ANVIL x Meinungsmache – Limited Edition Keycaps', sku: null, variantGid: KEYCAPS_GID, menge: 1 }
const TESTER: Zeile = { titel: 'ANVIL HE und MX Switch Tester', sku: null, variantGid: null, menge: 1 }

before(async () => {
  h = await harnessStart(DATENBANK)
  const anlegen = async (name: string, sku: string) => {
    const r = await aktion('produkte.produkt_anlegen', undefined, {
      name, sku, verkaufspreis: 41, einstandspreis: 12, gewicht_g: 300,
      verkaufbar: true, einkaufbar: true, route: 'kaufen', attribute: [],
    })
    const [pv] = await h.sql<{ id: string }[]>`select id from product_variants where template_id = ${r.recordId!}`
    const z = await aktion('lager.zaehlung_erfassen', undefined, { variant_id: pv.id, counted_qty: 50 })
    await aktion('lager.zaehlung_buchen', z.recordId)
    return pv.id
  }
  v.matte = await anlegen('Deskmat Klärfall', 'KF-MAT')
  v.keycaps = await anlegen('Keycaps Meinungsmache', 'KC-MM-001')
  v.tester = await anlegen('Switch Tester HE/MX', 'ST-HEMX-001')
  // Die Zuordnung zum Shop fehlt noch: der Shop kennt die Varianten, KRNL nicht.
  await h.sql`update product_variants set shopify_variant_id = null where id in (${v.keycaps}, ${v.tester})`
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

describe('Klärfälle gesammelt auflösen', () => {
  test('unbekannter Shop-Artikel: Bestellungen bleiben Entwurf, nichts wird reserviert', async () => {
    await eingang(7001, [KEYCAPS])
    await eingang(7002, [KEYCAPS, { titel: 'Deskmat', sku: 'KF-MAT', variantGid: null, menge: 2 }])
    await eingang(7003, [{ ...KEYCAPS, menge: 2 }], 'PENDING')
    await eingang(7004, [TESTER])
    await eingang(7005, [TESTER, KEYCAPS])

    for (const n of [7001, 7002, 7003, 7004, 7005]) assert.equal((await auftrag(n)).state, 'draft', `#${n}`)
    assert.equal((await auftrag(7002)).zeilen, 1, 'die bekannte Position steht drin, die unbekannte fehlt')
    const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from shopify_unmatched_lines where resolved_at is null`
    assert.equal(n, 6)
    const [{ reserviert }] = await h.sql<{ reserviert: number }[]>`
      select coalesce(sum(reserved), 0)::float as reserviert from stock_quants where variant_id = ${v.matte}`
    assert.equal(reserviert, 0, 'ohne Bestätigung keine Reservierung — auch nicht für die bekannte Position')

    // Die Karte im Monitor: je Shop-Artikel eine Zeile, größte Gruppe zuerst.
    const gruppen = await klaerfallGruppen(h.sql)
    assert.deepEqual(
      gruppen.map((g) => [g.title, g.variant_gid, g.zeilen, g.stueck, g.bestellungen, g.erkannt_id]),
      [
        [KEYCAPS.titel, KEYCAPS_GID, 4, 5, 4, null],
        [TESTER.titel, null, 2, 2, 2, null],
      ],
    )
  })

  test('eine Zuordnung je Shop-Artikel löst alle Positionen; Bestellungen werden nachgezogen und bestätigt', async () => {
    const r = await aktion('integrationen.klaerfaelle_aufloesen', undefined, {
      variant_id: v.keycaps, variant_gid: KEYCAPS_GID, titel: KEYCAPS.titel,
    })
    assert.match(r.text ?? '', /^4 Klärfälle zugeordnet\. 4 Bestellungen werden im Hintergrund nachgezogen/)
    const [pv] = await h.sql<{ shopify_variant_id: string | null }[]>`select shopify_variant_id from product_variants where id = ${v.keycaps}`
    assert.equal(pv.shopify_variant_id, KEYCAPS_GID, 'Zuordnung bleibt an der Variante — der nächste Import passt von selbst')

    // Die Gruppe ist weg; für die nächste Bestellung wäre die Variante „erkannt".
    assert.deepEqual((await klaerfallGruppen(h.sql)).map((g) => g.title), [TESTER.titel])

    // Vor den Jobs ist noch nichts nachgezogen.
    assert.equal((await auftrag(7001)).state, 'draft')
    await jobsAbarbeiten()

    assert.deepEqual(await auftrag(7001).then((a) => [a.state, a.zeilen]), ['sale', 1], 'bezahlt, vollständig → bestätigt')
    assert.deepEqual(await auftrag(7002).then((a) => [a.state, a.zeilen]), ['sale', 2])
    assert.deepEqual(await auftrag(7003).then((a) => [a.state, a.zeilen]), ['sale', 1], 'unbezahlt: reserviert beim Eingang (0135) — versandt wird erst nach Zahlung')
    assert.deepEqual(await auftrag(7005).then((a) => [a.state, a.zeilen]), ['draft', 1], 'der Switch Tester ist dort noch offen')
    assert.equal((await auftrag(7004)).state, 'draft')

    const [{ reserviert }] = await h.sql<{ reserviert: number }[]>`
      select coalesce(sum(reserved), 0)::float as reserviert from stock_quants where variant_id = ${v.matte}`
    assert.equal(reserviert, 2, 'mit der Bestätigung von #7002 sind die zwei Deskmats reserviert')
    const [{ menge }] = await h.sql<{ menge: number }[]>`
      select sum(l.qty)::float as menge from sales_order_lines l where l.variant_id = ${v.keycaps}`
    assert.equal(menge, 5, '1 + 1 + 2 + 1 Keycap-Sets in den Aufträgen')
  })

  test('ohne Shop-Variante zählt Titel + SKU als Gruppe; danach ist alles bestätigt und nichts mehr offen', async () => {
    const r = await aktion('integrationen.klaerfaelle_aufloesen', undefined, { variant_id: v.tester, titel: TESTER.titel })
    assert.match(r.text ?? '', /^2 Klärfälle zugeordnet\. 2 Bestellungen/)
    await jobsAbarbeiten()
    assert.deepEqual(await auftrag(7004).then((a) => [a.state, a.zeilen]), ['sale', 1])
    assert.deepEqual(await auftrag(7005).then((a) => [a.state, a.zeilen]), ['sale', 2])
    const [{ offen }] = await h.sql<{ offen: number }[]>`select count(*)::int as offen from shopify_unmatched_lines where resolved_at is null`
    assert.equal(offen, 0)

    await assert.rejects(
      aktion('integrationen.klaerfaelle_aufloesen', undefined, { variant_id: v.tester, titel: TESTER.titel }),
      /keine offenen Klärfälle mehr/,
    )
    // Die nächste Bestellung mit den Keycaps läuft ohne Klärfall durch.
    await eingang(7006, [KEYCAPS])
    assert.equal((await auftrag(7006)).state, 'sale')
  })
})
