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
import { kiKatalog } from '../../src/modules/prozesse/introspektion.ts'

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

describe('KI: Stückliste in einem Schritt anlegen, kopieren, Positionen pflegen', () => {
  const zeilen = (bom: string) =>
    h.sql<{ sku: string; qty: string; filter: string[] }[]>`
      select pv.sku, l.qty::text,
             coalesce(array_agg(av.name order by av.name) filter (where av.id is not null), '{}') as filter
      from bom_lines l
      join product_variants pv on pv.id = l.component_variant_id
      left join bom_line_variant_filters f on f.bom_line_id = l.id
      left join product_template_attribute_values ptav on ptav.id = f.ptav_id
      left join product_attribute_values av on av.id = ptav.value_id
      where l.bom_id = ${bom} group by l.id, pv.sku order by l.sequence`

  test('die Stücklisten-Aktionen stehen im Katalog der KI', () => {
    const namen = new Set(kiKatalog().map((a) => a.name))
    for (const a of [
      'fertigung.stueckliste_erfassen', 'fertigung.stueckliste_kopieren', 'fertigung.stueckliste_position_hinzufuegen',
      'fertigung.stueckliste_position_aendern', 'fertigung.stueckliste_position_entfernen',
    ]) assert.ok(namen.has(a), a)
  })

  test('komplette Stückliste: Produkt per Name, Komponenten per SKU, „gilt für" per Attribut und Wert', async () => {
    v.c = await board('Board C', ['Yellow', 'Brown'], 'fertigen')
    const r = await aktion('fertigung.stueckliste_erfassen', undefined, {
      produkt: 'Board C',
      positionen: [
        { komponente: 'AH-SW-Y', menge: 85, gilt_fuer: [{ attribut: 'switches', wert: 'yellow' }] },
        { komponente: 'ah-sw-b', menge: 85, gilt_fuer: [{ attribut: 'Switches', wert: 'Brown' }] },
        { komponente: 'AH-KB', menge: 1.5 },
      ],
    })
    assert.match(r.text ?? '', /Stückliste für Board C angelegt: 3 Positionen, davon 2 nur für bestimmte Varianten/)
    v.bomC = r.recordId!
    assert.deepEqual(
      (await zeilen(v.bomC)).map((z) => [z.sku, Number(z.qty), z.filter]),
      [['AH-SW-Y', 85, ['Yellow']], ['AH-SW-B', 85, ['Brown']], ['AH-KB', 1.5, []]],
    )
  })

  test('Fehler nennen die Position; nichts wird halb angelegt', async () => {
    v.d = await board('Board D', ['Yellow'], 'fertigen')
    const versuch = (positionen: unknown[]) => aktion('fertigung.stueckliste_erfassen', undefined, { produkt: 'Board D', positionen })
    await assert.rejects(
      versuch([{ komponente: 'AH-SW-Y', menge: 1 }, { komponente: 'GIBTS-NICHT', menge: 1 }]),
      /Position 2 \(GIBTS-NICHT\): Produkt „GIBTS-NICHT" nicht gefunden/,
    )
    await assert.rejects(
      versuch([{ komponente: 'AH-SW-Y', menge: 1, gilt_fuer: [{ attribut: 'Switches', wert: 'Silver' }] }]),
      /Position 1 \(AH-SW-Y\): Board D hat beim Attribut „Switches" keinen Wert „Silver" \(möglich: Yellow\)/,
    )
    const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from boms where template_id = ${v.d}`
    assert.equal(n, 0)
    await assert.rejects(
      aktion('fertigung.stueckliste_erfassen', undefined, { produkt: 'Board C', positionen: [{ komponente: 'AH-KB', menge: 1 }] }),
      /hat schon eine aktive Stückliste/,
    )
  })

  test('kopieren und eine Komponente per SKU ergänzen', async () => {
    const kopie = await aktion('fertigung.stueckliste_kopieren', v.bomC, { template_id: v.d })
    const neu = kopie.recordId!
    assert.deepEqual((await zeilen(neu)).map((z) => z.sku), ['AH-SW-Y', 'AH-KB'], 'Brown gibt es an Board D nicht — die Zeile entfällt')
    await aktion('fertigung.stueckliste_position_hinzufuegen', neu, { component_variant_id: 'AH-SW-B', qty: 2, ptav_ids: [] })
    assert.deepEqual((await zeilen(neu)).map((z) => z.sku), ['AH-SW-Y', 'AH-KB', 'AH-SW-B'])
  })
})

describe('Produkt löschen: ohne Belege endgültig, mit Belegen ins Archiv', () => {
  const lager = async () => (await h.sql<{ id: string }[]>`select id from stock_locations where full_path = 'WH/Stock'`)[0].id
  const zaehlen = async (variant: string, menge: number) => {
    const ort = await lager()
    const [z] = await h.sql<{ id: string }[]>`
      insert into inventory_counts (location_id, variant_id, counted_qty, book_qty, note)
      values (${ort}, ${variant}, ${menge},
              (select coalesce(sum(on_hand), 0) from stock_quants where variant_id = ${variant} and location_id = ${ort}), 'Test')
      returning id`
    await h.sql`select inventory_apply(${z.id}, 'test')`
  }
  const tplVon = async (variant: string) =>
    (await h.sql<{ template_id: string }[]>`select template_id from product_variants where id = ${variant}`)[0].template_id

  test('ohne Belege: Produkt, Varianten und Stückliste sind weg', async () => {
    const id = await board('Wegwerf-Board', ['Yellow'], 'fertigen')
    await aktion('fertigung.stueckliste_erfassen', undefined, { produkt: 'Wegwerf-Board', positionen: [{ komponente: 'AH-KB', menge: 1 }] })
    const r = await aktion('produkte.produkt_loeschen', id)
    assert.match(r.text ?? '', /„Wegwerf-Board" gelöscht/)
    const [{ n }] = await h.sql<{ n: number }[]>`
      select (select count(*) from product_templates where id = ${id})::int
           + (select count(*) from product_variants where template_id = ${id})::int
           + (select count(*) from boms where template_id = ${id})::int as n`
    assert.equal(n, 0)
  })

  test('mit Bestand, als Komponente oder mit offenen Bewegungen: abgelehnt mit Grund', async () => {
    const teilId = await teil('Lösch-Teil', 'AH-DEL')
    await zaehlen(teilId, 5)
    await assert.rejects(aktion('produkte.produkt_loeschen', await tplVon(teilId)), /hat noch Bestand \(5\)/)
    // AH-KB steckt in der Stückliste von Board C.
    await assert.rejects(aktion('produkte.produkt_loeschen', await tplVon(await teil('Kabel 2', 'AH-KB2').then(async (k) => {
      await aktion('fertigung.stueckliste_position_hinzufuegen', v.bomC, { component_variant_id: k, qty: 1, ptav_ids: [] })
      return k
    }))), /ist Komponente in aktiven Stücklisten \(Board C\)/)
  })

  test('mit Belegen (Bestand wieder 0): archiviert, aus der Auswahl verschwunden, wiederherstellbar', async () => {
    const [teilV] = await h.sql<{ id: string }[]>`select id from product_variants where sku = 'AH-DEL'`
    await zaehlen(teilV.id, 0)
    const tpl = await tplVon(teilV.id)
    const r = await aktion('produkte.produkt_loeschen', tpl)
    assert.match(r.text ?? '', /kommt in (Lagerbewegungen|Inventuren|Lagerbeständen|der Lagerbewertung) vor und wurde deshalb archiviert/)
    const aktiv = async () =>
      (await h.sql<{ t: boolean; v: boolean }[]>`
        select pt.active as t, pv.active as v from product_templates pt join product_variants pv on pv.template_id = pt.id where pt.id = ${tpl}`)[0]
    assert.deepEqual({ ...(await aktiv()) }, { t: false, v: false })
    await assert.rejects(
      aktion('fertigung.stueckliste_position_hinzufuegen', v.bomC, { component_variant_id: 'AH-DEL', qty: 1, ptav_ids: [] }),
      /nicht gefunden/,
      'archivierte Artikel lassen sich nicht mehr verbauen',
    )
    await aktion('produkte.produkt_wiederherstellen', tpl)
    assert.deepEqual({ ...(await aktiv()) }, { t: true, v: true })
    await assert.rejects(aktion('produkte.produkt_wiederherstellen', tpl), /nicht archiviert/)
  })
})

describe('Variante als eigenes Produkt herauslösen (0143)', () => {
  test('die Variante zieht mit ID, Bestand und Stücklistenzeile in ein eigenes Produkt um', async () => {
    const r = await aktion('produkte.produkt_anlegen', undefined, {
      name: 'GATERON Switches', verkaufspreis: 30, verkaufbar: true, einkaufbar: true, route: 'kaufen',
      attribute: [{ name: 'Typ', werte: [{ name: 'Yellow' }, { name: 'Brown' }, { name: 'Silent Red', aufpreis: 5 }] }],
    })
    const gateron = r.recordId!
    const [cherry] = await h.sql<{ id: string }[]>`
      update product_variants set sku = 'SW-CH-LSR-T', shopify_variant_id = 'gid://shopify/ProductVariant/cherry'
      where template_id = ${gateron} and display_name like '%Silent Red%' returning id`
    const [ort] = await h.sql<{ id: string }[]>`select id from stock_locations where full_path = 'WH/Stock'`
    const [z] = await h.sql<{ id: string }[]>`
      insert into inventory_counts (location_id, variant_id, counted_qty, book_qty, note)
      values (${ort.id}, ${cherry.id}, 1470, 0, 'Test') returning id`
    await h.sql`select inventory_apply(${z.id}, 'test')`
    await aktion('fertigung.stueckliste_position_hinzufuegen', v.bomC, { component_variant_id: cherry.id, qty: 85, ptav_ids: [] })

    const e = await aktion('produkte.variante_herausloesen', cherry.id, { name: 'Cherry MX2A Silent Red' })
    assert.match(e.text ?? '', /ist jetzt ein eigenes Produkt.*Im Shop bleibt es Variante von „GATERON Switches"/)
    const [nach] = await h.sql<
      { name: string; produkt: string; sku: string; bestand: number; preis: number; herausgeloest: boolean; gid: string; in_stl: number }[]
    >`
      select pv.display_name as name, pt.name as produkt, pv.sku, on_hand_qty(pv.id)::float as bestand,
             (pt.list_price + pv.price_extra)::float as preis, pv.shop_herausgeloest as herausgeloest, pv.shopify_variant_id as gid,
             (select count(*)::int from bom_lines l where l.component_variant_id = pv.id) as in_stl
      from product_variants pv join product_templates pt on pt.id = pv.template_id where pv.id = ${cherry.id}`
    assert.deepEqual({ ...nach }, {
      name: 'Cherry MX2A Silent Red', produkt: 'Cherry MX2A Silent Red', sku: 'SW-CH-LSR-T', bestand: 1470, preis: 35,
      herausgeloest: true, gid: 'gid://shopify/ProductVariant/cherry', in_stl: 1,
    })
    assert.equal(e.recordId, (await h.sql<{ template_id: string }[]>`select template_id from product_variants where id = ${cherry.id}`)[0].template_id)

    // Das alte Produkt: zwei Varianten, der Wert ist weg — „Varianten erzeugen" bringt ihn nicht zurück.
    await h.sql`select generate_variants(${gateron})`
    const rest = await h.sql<{ name: string }[]>`
      select display_name as name from product_variants where template_id = ${gateron} and active order by display_name`
    assert.deepEqual(rest.map((x) => x.name), ['GATERON Switches (Typ: Brown)', 'GATERON Switches (Typ: Yellow)'])
    v.gateron = gateron
    v.cherry = cherry.id
  })

  test('nicht für die einzige Variante und nicht für gefertigte Produkte', async () => {
    await assert.rejects(aktion('produkte.variante_herausloesen', v.cherry, { name: 'Noch einmal' }), /einzige Variante/)
    const [board] = await h.sql<{ id: string }[]>`select id from product_variants where template_id = ${v.c} and active limit 1`
    await assert.rejects(aktion('produkte.variante_herausloesen', board.id, { name: 'Board einzeln' }), /hat eine Stückliste/)
    await assert.rejects(aktion('produkte.variante_herausloesen', v.cherry, { name: '  ' }))
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
