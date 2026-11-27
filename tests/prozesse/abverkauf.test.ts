/**
 * Abverkauf und nummerierte Auflage (0144, Entscheidungslog 2026-11-27):
 * das Command Center rechnet aus den Bestellungen, welches Teil als
 * Nächstes ausgeht; „Ausverkauft setzen" nimmt alles mit, was das Teil in
 * der Stückliste hat; die Auflage vergibt ihre Nummern in Bestellreihenfolge.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'
import { abverkaufStand } from '../../src/modules/verkauf/abverkauf.ts'

const DATENBANK = 'erp_abverkauf_check'
const ADMIN = { name: 'abverkauf-test', role: 'admin' as const }
let h: Harness
const v: Record<string, string> = {}
const t: Record<string, string> = {}
let kunde = ''
let nr = 100

const aktion = (name: string, recordId: string | undefined, parameter: Record<string, unknown> = {}) =>
  aktionAusfuehrenGeprueft(name, { recordId, parameter }, ADMIN)

async function teil(name: string, menge: number): Promise<string> {
  const [uom] = await h.sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await h.sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, can_be_sold) values (${name}, ${uom.id}, false) returning id`
  await h.sql`select generate_variants(${tpl.id})`
  const [x] = await h.sql<{ id: string }[]>`select id from product_variants where template_id = ${tpl.id}`
  const [lager] = await h.sql<{ id: string }[]>`select id from stock_locations where full_path = 'WH/Stock'`
  const [z] = await h.sql<{ id: string }[]>`
    insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
    values (${lager.id}, ${x.id}, ${menge}, 0) returning id`
  await h.sql`select inventory_apply(${z.id}, 'test')`
  return x.id
}

/** Bestätigte Bestellung, die vor so vielen Minuten einging; liefert die Auftrags-ID. */
async function bestellen(variante: string, menge: number, minutenHer: number): Promise<string> {
  const [uom] = await h.sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [so] = await h.sql<{ id: string }[]>`
    insert into sales_orders (number, partner_id, source, shopify_order_name, order_date)
    values (next_sequence('sale'), ${kunde}, 'shopify', ${`#${++nr}`}, now() - make_interval(mins => ${minutenHer}))
    returning id`
  await h.sql`insert into sales_order_lines (order_id, variant_id, name, qty, uom_id, price_unit)
              values (${so.id}, ${variante}, 'Tastatur', ${menge}, ${uom.id}, 249)`
  await h.sql`select confirm_sales_order(${so.id}, 'test')`
  return so.id
}

const nummern = async (auftrag: string) =>
  (await h.sql<{ nummer: number }[]>`
    select n.nummer from auflage_nummern n
    join sales_order_lines sol on sol.id = n.sales_order_line_id
    where sol.order_id = ${auftrag} order by n.nummer`).map((x) => x.nummer)

before(async () => {
  h = await harnessStart(DATENBANK)
  await h.sql`insert into settings (key, value) values ('shopify', ${h.sql.json({ mto: { modus: 'baubar', puffer: 0, deckel: 99 } })})
              on conflict (key) do update set value = excluded.value`
  const [uom] = await h.sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  kunde = (await h.sql<{ id: string }[]>`
    insert into partners (name, is_customer) values ('Rita Release', true) returning id`)[0].id
  v.caseSchwarz = await teil('Case Schwarz', 10)
  v.caseFounders = await teil('Case Founders', 6)
  v.swMax = await teil('Switch Jade Max', 99 * 20)
  v.swGaming = await teil('Switch Jade Gaming', 99 * 3)
  const [attr] = await h.sql<{ id: string }[]>`insert into product_attributes (name) values ('Switches A') returning id`
  await h.sql`insert into product_attribute_values (attribute_id, name, sequence)
              values (${attr.id}, 'Jade Max', 1), (${attr.id}, 'Jade Gaming', 2)`
  for (const [kurz, gehaeuse] of [['Schwarz', v.caseSchwarz], ['Founders', v.caseFounders]] as const) {
    const [tpl] = await h.sql<{ id: string }[]>`
      insert into product_templates (name, uom_id, can_be_sold, route_manufacture, route_mto, projekt)
      values (${`TEST 1800 ${kurz}`}, ${uom.id}, true, true, true, 'TEST 1800') returning id`
    t[kurz] = tpl.id
    const [line] = await h.sql<{ id: string }[]>`
      insert into product_template_attribute_lines (template_id, attribute_id) values (${tpl.id}, ${attr.id}) returning id`
    const werte = await h.sql<{ id: string; name: string }[]>`
      insert into product_template_attribute_values (line_id, value_id)
      select ${line.id}, id from product_attribute_values where attribute_id = ${attr.id}
      returning id, (select name from product_attribute_values x where x.id = value_id) as name`
    await h.sql`select generate_variants(${tpl.id})`
    for (const x of await h.sql<{ id: string; display_name: string }[]>`
      select id, display_name from product_variants where template_id = ${tpl.id}`) {
      v[`${kurz}:${x.display_name.includes('Jade Max') ? 'Max' : 'Gaming'}`] = x.id
    }
    const [bom] = await h.sql<{ id: string }[]>`
      insert into boms (template_id, qty, uom_id) values (${tpl.id}, 1, ${uom.id}) returning id`
    await h.sql`insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
                values (${bom.id}, 10, ${gehaeuse}, 1, ${uom.id})`
    for (const [wert, sw] of [['Jade Max', v.swMax], ['Jade Gaming', v.swGaming]] as const) {
      const [z] = await h.sql<{ id: string }[]>`
        insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
        values (${bom.id}, 20, ${sw}, 99, ${uom.id}) returning id`
      await h.sql`insert into bom_line_variant_filters (bom_line_id, ptav_id)
                  values (${z.id}, ${werte.find((w) => w.name === wert)!.id})`
    }
  }
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

describe('Abverkauf: Ranking aus den Bestellungen', () => {
  test('Reichweite, Tempo und Reihenfolge in Tastaturen', async () => {
    await bestellen(v['Schwarz:Max'], 2, 5)
    await bestellen(v['Schwarz:Gaming'], 1, 30)
    const s = await abverkaufStand('heute', 'TEST 1800')
    assert.equal(s.stueck, 3)
    assert.equal(s.bestellungen, 2)
    assert.equal(s.tempo, 8, 'zwei Stück in 15 Minuten = acht je Stunde')
    assert.deepEqual(s.projekte, ['TEST 1800'])
    const z = (id: string) => s.teile.find((x) => x.id === id)!
    // Gehäuse: 10 − 3 reserviert; Tempo 8/Std → in 53 Minuten leer.
    assert.deepEqual(
      [z(v.caseSchwarz).reicht, z(v.caseSchwarz).verkauft, z(v.caseSchwarz).tempo, z(v.caseSchwarz).minuten, z(v.caseSchwarz).zustand],
      [7, 3, 8, 53, 'knapp'],
    )
    // Switches zählen in Tastaturen (99 je Stück): 3 − 1 = 2, eine in der letzten Stunde.
    assert.deepEqual(
      [z(v.swGaming).reicht, z(v.swGaming).verkauft, z(v.swGaming).tempo, z(v.swGaming).minuten, z(v.swGaming).je],
      [2, 1, 1, 120, 99],
    )
    assert.deepEqual([z(v.swMax).reicht, z(v.swMax).artikel], [18, 2], 'steckt in beiden Produkten')
    // Oben steht, was zuerst ausgeht; ohne Abverkauf (Founders-Gehäuse) folgt nach Reichweite.
    assert.deepEqual(s.teile.map((x) => x.name), ['Case Schwarz', 'Switch Jade Gaming', 'Switch Jade Max', 'Case Founders'])
    assert.deepEqual(s.teile.map((x) => x.rang), [1, 2, 3, 4])
    assert.deepEqual(s.artikel.map((a) => [a.name, a.menge]), [['TEST 1800 Schwarz', 3]])
    assert.deepEqual(s.optionen.map((o) => [o.wert, o.menge]), [['Jade Max', 2], ['Jade Gaming', 1]])
    assert.equal(s.verlauf.reduce((a, b) => a + b, 0), 3)
    assert.equal(s.verlauf[10], 2, 'vor fünf Minuten = vorletzte Fünf-Minuten-Scheibe')
  })

  test('das Zeitfenster zählt nur, was darin bestellt wurde — die Reichweite bleibt', async () => {
    const s = await abverkaufStand('15', 'TEST 1800')
    assert.equal(s.stueck, 2)
    const gaming = s.teile.find((x) => x.id === v.swGaming)!
    assert.deepEqual([gaming.verkauft, gaming.reicht, gaming.tempo], [0, 2, 1])
    assert.equal((await abverkaufStand('heute', 'Gibt es nicht')).teile.length, 0)
  })

  test('„Ausverkauft setzen": das Teil zählt als 0 — in jeder Stückliste, die es braucht', async () => {
    const soll = async (variante: string) =>
      (await h.sql<{ n: number }[]>`select shopify_soll_menge(${variante}) as n`)[0].n
    assert.ok((await soll(v['Schwarz:Gaming'])) > 0 && (await soll(v['Founders:Gaming'])) > 0)
    await aktion('verkauf.shop_variante_setzen', undefined, { variant_id: v.swGaming, zurueckhalten: true })
    assert.deepEqual([await soll(v['Schwarz:Gaming']), await soll(v['Founders:Gaming'])], [0, 0])
    assert.ok((await soll(v['Schwarz:Max'])) > 0, 'andere Switches laufen weiter')
    const s = await abverkaufStand('heute', 'TEST 1800')
    const gaming = s.teile.find((x) => x.id === v.swGaming)!
    assert.deepEqual([gaming.zustand, gaming.rang, gaming.reicht], ['gesperrt', null, 0])
    assert.equal(s.teile.at(-1)!.id, v.swGaming, 'von Hand Gesperrtes steht am Ende')
    await aktion('verkauf.shop_variante_setzen', undefined, { variant_id: v.swGaming, zurueckhalten: false })
    assert.ok((await soll(v['Founders:Gaming'])) > 0)
  })

  test('überverkauft: mehr bestellt als da ist — steht ganz oben', async () => {
    // Drei Gaming-Tastaturen mehr, es reicht nur noch für zwei.
    await bestellen(v['Schwarz:Gaming'], 3, 1)
    const s = await abverkaufStand('heute', 'TEST 1800')
    assert.deepEqual([s.teile[0].id, s.teile[0].zustand, s.teile[0].fehlt, s.teile[0].rang], [v.swGaming, 'ueberverkauft', 1, 1])
  })
})

describe('Nummerierte Auflage: Nummern in Bestellreihenfolge', () => {
  const vergeben = async (ruhe = '0 seconds') =>
    (await h.sql<{ vergeben: number; frei_geworden: number }[]>`
      select * from auflage_nummern_vergeben(${ruhe}::interval)`)[0]
  const o: Record<string, string> = {}

  test('Auflage setzen: Name und Bereich, Produkte hängen daran', async () => {
    await assert.rejects(
      aktion('produkte.auflage_setzen', undefined, { template_ids: [t.Founders], name: 'Founders Edition' }),
      /letzte Nummer/,
    )
    const r = await aktion('produkte.auflage_setzen', undefined, { template_ids: [t.Founders], name: 'Founders Edition', bis: 3 })
    assert.match(r.text ?? '', /Founders Edition.*Nr\. 1–3.*1 Produkt/)
    assert.deepEqual(await vergeben(), { vergeben: 0, frei_geworden: 0 })
  })

  test('egal welche Variante: jedes Stück bekommt die nächste Nummer — nach Bestellzeit, nicht nach Eingang', async () => {
    // Eingang in KRNL: A, B, C — bestellt wurde aber B (vor 20 Min), A (vor 10), C (vor 5).
    o.a = await bestellen(v['Founders:Max'], 2, 10)
    o.b = await bestellen(v['Founders:Gaming'], 1, 20)
    o.c = await bestellen(v['Founders:Max'], 1, 5)
    assert.deepEqual(await vergeben(), { vergeben: 3, frei_geworden: 0 })
    assert.deepEqual([await nummern(o.b), await nummern(o.a), await nummern(o.c)], [[1], [2, 3], []])
    const [text] = await h.sql<{ zeile: string | null; mo: string | null }[]>`
      select auflage_nummern_text(sol.id) as zeile,
             (select auflage_nummern_fertigung(mo.id) from manufacturing_orders mo where mo.sales_order_id = sol.order_id limit 1) as mo
      from sales_order_lines sol where sol.order_id = ${o.a}`
    assert.deepEqual(text, { zeile: 'Founders Edition Nr. 2, 3', mo: 'Founders Edition Nr. 2, 3' })
    // Die Auflage ist voll: das vierte Stück bleibt ohne Nummer und wird gemeldet.
    const s = await abverkaufStand('heute', 'TEST 1800')
    assert.deepEqual(
      s.auflagen.map((a) => [a.name, a.von, a.bis, a.vergeben, a.ohneNummer]),
      [['Founders Edition', 1, 3, 3, 1]],
    )
    assert.equal(s.auflagen[0].letzte.length, 3)
    assert.equal(await vergeben().then((x) => x.vergeben), 0, 'ein zweiter Lauf ändert nichts')
  })

  test('Storno gibt die Nummer frei — sie geht an das nächste Stück ohne Nummer', async () => {
    await h.sql`select cancel_sales_order(${o.b}, 'test')`
    assert.deepEqual(await vergeben(), { vergeben: 1, frei_geworden: 1 })
    assert.deepEqual([await nummern(o.b), await nummern(o.a), await nummern(o.c)], [[], [2, 3], [1]])
    const [log] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from audit_log where model = 'sales_order' and record_id = ${o.c} and message like '%Nr. 1 vergeben%'`
    assert.equal(log.n, 1, 'steht in der Chronik der Bestellung')
  })

  test('Ruhezeit: eine ganz frische Bestellung wartet, bis sie sich einsortieren kann', async () => {
    await aktion('produkte.auflage_setzen', undefined, { template_ids: [t.Founders], name: 'Founders Edition', bis: 5 })
    o.d = await bestellen(v['Founders:Gaming'], 1, 0)
    assert.equal((await vergeben('60 seconds')).vergeben, 0)
    assert.deepEqual(await nummern(o.d), [])
    assert.equal((await vergeben()).vergeben, 1)
    assert.deepEqual(await nummern(o.d), [4])
  })

  test('der Bereich lässt sich nicht unter vergebene Nummern kürzen; Auflage entfernen gibt alles frei', async () => {
    await assert.rejects(
      aktion('produkte.auflage_setzen', undefined, { template_ids: [t.Founders], name: 'Founders Edition', bis: 2 }),
      /schon die Nummern 1–4 vergeben/,
    )
    const r = await aktion('produkte.auflage_setzen', undefined, { template_ids: [t.Founders], name: null })
    assert.match(r.text ?? '', /entfernt/)
    const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from auflage_nummern`
    assert.equal(n, 0)
  })
})
