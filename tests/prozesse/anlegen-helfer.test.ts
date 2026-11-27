/**
 * Anlegen-Helfer (Entscheidungslog 2026-11-27, Block A): Stücklistenposition
 * ändern (A3), Teil mit Einheit anlegen (A4), Artikelnummern und Barcodes in
 * einer Tabelle (A5), Shop-Produkte mit Anlage-Lücken (A6).
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'
import { shopProdukteMitLuecken } from '../../src/modules/integrationen/shop-anlage.ts'

const DATENBANK = 'erp_anlegen_helfer_check'
const ADMIN = { name: 'anlege-test', role: 'admin' as const }
let h: Harness
const v: Record<string, string> = {}

const aktion = (name: string, recordId: string | undefined, parameter: Record<string, unknown> = {}) =>
  aktionAusfuehrenGeprueft(name, { recordId, parameter }, ADMIN)

async function teil(name: string, sku: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await aktion('produkte.produkt_anlegen', undefined, {
    name, sku, verkaufbar: false, einkaufbar: true, route: 'kaufen', attribute: [], ...extra,
  })
  const [pv] = await h.sql<{ id: string }[]>`select id from product_variants where template_id = ${r.recordId!}`
  return pv.id
}

async function board(name: string, switches: string[], route?: 'fertigen'): Promise<string> {
  const r = await aktion('produkte.produkt_anlegen', undefined, {
    name, verkaufspreis: 199, verkaufbar: true, einkaufbar: false, ...(route ? { route } : {}),
    attribute: [{ name: 'Switches', werte: switches.map((s) => ({ name: s })) }],
  })
  return r.recordId!
}

const ptav = async (template: string, wert: string) =>
  (await h.sql<{ id: string }[]>`
    select p.id from product_template_attribute_values p
    join product_template_attribute_lines l on l.id = p.line_id and l.template_id = ${template}
    join product_attribute_values w on w.id = p.value_id
    where w.name = ${wert}`)[0].id

const zeile = async (lineId: string) =>
  (await h.sql<{ qty: string; komponente: string; filter: string[] }[]>`
    select l.qty::text, l.component_variant_id as komponente,
           coalesce(array_agg(f.ptav_id::text order by f.ptav_id) filter (where f.ptav_id is not null), '{}') as filter
    from bom_lines l left join bom_line_variant_filters f on f.bom_line_id = l.id
    where l.id = ${lineId} group by l.id`)[0]

before(async () => {
  h = await harnessStart(DATENBANK)
  v.gelb = await teil('Switch Gelb', 'AH-SW-Y')
  v.braun = await teil('Switch Braun', 'AH-SW-B')
  v.a = await board('Board A', ['Yellow', 'Brown'], 'fertigen')
  v.b = await board('Board B', ['Yellow', 'Brown'], 'fertigen')
  v.bom = (await aktion('fertigung.stueckliste_anlegen', undefined, { template_id: v.a, qty: 1 })).recordId!
  await aktion('fertigung.stueckliste_position_hinzufuegen', v.bom, {
    component_variant_id: v.gelb, qty: 85, ptav_ids: [await ptav(v.a, 'Yellow')],
  })
  v.zeile = (await h.sql<{ id: string }[]>`select id from bom_lines where bom_id = ${v.bom}`)[0].id
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

describe('Stücklistenposition ändern (A3)', () => {
  test('Menge und Zuordnung in einem Schritt', async () => {
    const braun = await ptav(v.a, 'Brown')
    await aktion('fertigung.stueckliste_position_aendern', v.bom, { line_id: v.zeile, qty: 90, ptav_ids: [braun] })
    const z = await zeile(v.zeile)
    assert.equal(Number(z.qty), 90)
    assert.deepEqual(z.filter, [braun])
  })

  test('leere Zuordnung = gilt für alle Varianten', async () => {
    await aktion('fertigung.stueckliste_position_aendern', v.bom, { line_id: v.zeile, qty: 90, ptav_ids: [] })
    assert.deepEqual((await zeile(v.zeile)).filter, [])
  })

  test('andere Komponente: Position bleibt, Teil wechselt', async () => {
    await aktion('fertigung.stueckliste_position_aendern', v.bom, {
      line_id: v.zeile, qty: 85, ptav_ids: [], component_variant_id: v.braun,
    })
    const z = await zeile(v.zeile)
    assert.equal(z.komponente, v.braun)
    assert.equal(Number(z.qty), 85)
  })

  test('Zuordnung eines fremden Produkts wird abgelehnt — nichts ändert sich', async () => {
    const fremd = await ptav(v.b, 'Yellow')
    await assert.rejects(
      aktion('fertigung.stueckliste_position_aendern', v.bom, { line_id: v.zeile, qty: 1, ptav_ids: [fremd] }),
      /gehört nicht zu diesem Produkt/,
    )
    assert.equal(Number((await zeile(v.zeile)).qty), 85)
  })

  test('das Produkt selbst als Komponente und Menge 0 werden abgelehnt', async () => {
    const [selbst] = await h.sql<{ id: string }[]>`select id from product_variants where template_id = ${v.a} limit 1`
    await assert.rejects(
      aktion('fertigung.stueckliste_position_aendern', v.bom, {
        line_id: v.zeile, qty: 1, ptav_ids: [], component_variant_id: selbst.id,
      }),
      /Komponente seiner selbst/,
    )
    await assert.rejects(
      aktion('fertigung.stueckliste_position_aendern', v.bom, { line_id: v.zeile, qty: 0, ptav_ids: [] }),
    )
  })
})

describe('Teil mit Einheit, Preis und Route anlegen (A4)', () => {
  test('Meterware zum Kaufen', async () => {
    const id = await teil('Kabel', 'AH-KB', { einheit: 'm', einstandspreis: 0.35 })
    const [t] = await h.sql<{ uom: string; standard_cost: string; route_buy: boolean; can_be_purchased: boolean }[]>`
      select u.name as uom, pt.standard_cost::text, pt.route_buy, pt.can_be_purchased
      from product_variants pv join product_templates pt on pt.id = pv.template_id
      join uoms u on u.id = pt.uom_id where pv.id = ${id}`
    assert.equal(t.uom, 'm')
    assert.equal(Number(t.standard_cost), 0.35)
    assert.ok(t.route_buy && t.can_be_purchased)
  })

  test('unbekannte Einheit wird mit Klartext abgelehnt', async () => {
    await assert.rejects(teil('Draht', 'AH-DR', { einheit: 'Ellen' }), /Einheit „Ellen" gibt es nicht/)
    const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from product_templates where name = 'Draht'`
    assert.equal(n, 0)
  })
})

describe('Produkt speichern mit langer Shop-Beschreibung', () => {
  const basis = { name: 'Board B', list_price: 199, can_be_sold: true, route_manufacture: true, route_mto: true }

  test('Routen lassen sich speichern; die Beschreibung bleibt Zeichen für Zeichen', async () => {
    const html = `<p>${'Lange Beschreibung aus dem Shop. '.repeat(300)}</p>\n<ul>\n  <li>Punkt</li>\n</ul>`
    assert.ok(html.length > 2000)
    await h.sql`update product_templates set description_sale = ${html} where id = ${v.b}`
    // Das Formular liefert den Text ohne Zeilenumbrüche zurück.
    await aktion('produkte.produkt_aendern', v.b, { ...basis, description_sale: html.replace(/\s+/g, ' ') })
    const [t] = await h.sql<{ description_sale: string; route_mto: boolean }[]>`
      select description_sale, route_mto from product_templates where id = ${v.b}`
    assert.equal(t.route_mto, true)
    assert.equal(t.description_sale, html, 'nur Leerraum anders → gespeicherter Text bleibt')
  })

  test('ein wirklich geänderter Text wird übernommen', async () => {
    await aktion('produkte.produkt_aendern', v.b, { ...basis, description_sale: 'Neuer Text' })
    const [t] = await h.sql<{ description_sale: string }[]>`select description_sale from product_templates where id = ${v.b}`
    assert.equal(t.description_sale, 'Neuer Text')
  })
})

describe('Release per Knopfdruck: Shop-Projekt und Verkauf starten/stoppen', () => {
  const stand = () =>
    h.sql<{ name: string; projekt: string | null; shop_modus: string }[]>`
      select name, projekt, shop_modus from product_templates where id in (${v.a}, ${v.b}) order by name`

  test('Shop-Projekt für mehrere Produkte auf einmal — und wieder entfernen', async () => {
    const r = await aktion('produkte.shop_projekt_setzen', undefined, { template_ids: [v.a, v.b], projekt: 'NATIVE 1800' })
    assert.match(r.text ?? '', /2 Produkte im Shop-Projekt „NATIVE 1800" \(2 geändert\)/)
    assert.deepEqual((await stand()).map((s) => s.projekt), ['NATIVE 1800', 'NATIVE 1800'])
    await aktion('produkte.shop_projekt_setzen', undefined, { template_ids: [v.b], projekt: null })
    assert.deepEqual((await stand()).map((s) => s.projekt), ['NATIVE 1800', null])
    await assert.rejects(aktion('produkte.shop_projekt_setzen', undefined, { template_ids: [], projekt: 'X' }), /anhaken/)
  })

  test('Verkauf stoppen stellt alle auf „aus", starten alle auf „berechnet" — mit Hinweis auf den Shopify-Modus', async () => {
    const stopp = await aktion('verkauf.shop_verkauf_schalten', undefined, { template_ids: [v.a, v.b], start: false })
    assert.deepEqual((await stand()).map((s) => s.shop_modus), ['aus', 'aus'])
    assert.match(stopp.text ?? '', /Verkauf gestoppt: 2 Artikel auf „aus \(ausverkauft\)"/)
    const start = await aktion('verkauf.shop_verkauf_schalten', undefined, { template_ids: [v.a, v.b], start: true })
    assert.deepEqual((await stand()).map((s) => s.shop_modus), ['auto', 'auto'])
    assert.match(start.text ?? '', /Verkauf gestartet: 2 Artikel auf „berechnet"/)
    // Die Testdatenbank steht auf „nur lesen" — der Knopf sagt es, statt still nichts zu senden.
    assert.match(start.text ?? '', /an den Shop geht nichts hinaus/)
  })
})

describe('Artikelnummern und Barcodes in einer Tabelle (A5)', () => {
  const varianten = () =>
    h.sql<{ id: string; sku: string | null; barcode: string | null }[]>`
      select id, sku, barcode from product_variants where template_id = ${v.a} and active order by id`

  test('alle Varianten in einem Schritt', async () => {
    const [x, y] = await varianten()
    const r = await aktion('produkte.varianten_codes', v.a, {
      zeilen: [
        { variant_id: x.id, sku: 'AH-A-1', barcode: '4000000000011' },
        { variant_id: y.id, sku: 'AH-A-2' },
      ],
    })
    assert.match(r.text ?? '', /2 Varianten gespeichert/)
    const nach = await varianten()
    assert.deepEqual(nach.map((n) => n.sku), ['AH-A-1', 'AH-A-2'])
    assert.equal(nach[0].barcode, '4000000000011')
  })

  test('zwei Nummern tauschen geht in einem Speichern', async () => {
    const [x, y] = await varianten()
    await aktion('produkte.varianten_codes', v.a, {
      zeilen: [
        { variant_id: x.id, sku: 'AH-A-2', barcode: '4000000000011' },
        { variant_id: y.id, sku: 'AH-A-1' },
      ],
    })
    assert.deepEqual((await varianten()).map((n) => n.sku), ['AH-A-2', 'AH-A-1'])
  })

  test('unverändert → keine Änderung, kein Protokolleintrag', async () => {
    const [x] = await varianten()
    const vorher = (await h.sql<{ n: number }[]>`
      select count(*)::int as n from audit_log where model = 'product_template' and record_id = ${v.a}`)[0].n
    const r = await aktion('produkte.varianten_codes', v.a, {
      zeilen: [{ variant_id: x.id, sku: 'AH-A-2', barcode: '4000000000011' }],
    })
    assert.match(r.text ?? '', /Keine Änderung/)
    const nachher = (await h.sql<{ n: number }[]>`
      select count(*)::int as n from audit_log where model = 'product_template' and record_id = ${v.a}`)[0].n
    assert.equal(nachher, vorher)
  })

  test('doppelt in der Tabelle, vergeben an ein anderes Produkt, fremde Variante', async () => {
    const [x, y] = await varianten()
    await assert.rejects(
      aktion('produkte.varianten_codes', v.a, {
        zeilen: [{ variant_id: x.id, sku: 'DOPPELT' }, { variant_id: y.id, sku: 'DOPPELT' }],
      }),
      /steht zweimal/,
    )
    await assert.rejects(
      aktion('produkte.varianten_codes', v.a, { zeilen: [{ variant_id: x.id, sku: 'AH-SW-Y' }] }),
      /bereits vergeben \(.*Switch Gelb/,
    )
    await assert.rejects(
      aktion('produkte.varianten_codes', v.a, { zeilen: [{ variant_id: v.gelb, sku: 'X-1' }] }),
      /gehört nicht zu diesem Produkt/,
    )
    assert.deepEqual((await varianten()).map((n) => n.sku), ['AH-A-2', 'AH-A-1'], 'nichts halb gespeichert')
  })
})

describe('Shop-Produkte mit Anlage-Lücken (A6)', () => {
  test('nur Shop-Produkte, mit dem, was fehlt', async () => {
    // B ist im Shop: Route Fertigen, keine Stückliste, keine Artikelnummern.
    await h.sql`update product_variants set shopify_variant_id = 'gid://shopify/ProductVariant/' || id
                where template_id = ${v.b}`
    const liste = await shopProdukteMitLuecken()
    assert.deepEqual(liste.map((p) => p.name), ['Board B'], 'A ist nicht im Shop')
    assert.deepEqual(liste[0].luecken.map((l) => l.art), ['stueckliste', 'sku'])
  })

  test('vollständig angelegt → verschwindet aus der Liste', async () => {
    const kopie = await aktion('fertigung.stueckliste_kopieren', v.bom, { template_id: v.b })
    assert.ok(kopie.recordId)
    const vs = await h.sql<{ id: string }[]>`select id from product_variants where template_id = ${v.b} and active`
    await aktion('produkte.varianten_codes', v.b, { zeilen: vs.map((x, i) => ({ variant_id: x.id, sku: `AH-B-${i}` })) })
    assert.deepEqual(await shopProdukteMitLuecken(), [])
  })
})
