/**
 * Odoo-Stücklisten per API (Migration 0090) gegen die echte Datenbank und
 * die Odoo-Attrappe (ODOO_FAKE=1): Tastaturen und Switch-Tester stehen
 * vorher in KRNL (wie aus Shopify), die Übernahme hängt EINE Stückliste je
 * Artikel mit Variantenfiltern an (und löst frühere Varianten-Stücklisten
 * ab), legt fehlende Komponenten an, setzt Preis und Bestand nur wo 0 —
 * auch für Zubehör, nie für Fertigprodukte —, schaltet die Routen, und ein
 * zweiter Lauf ändert nichts.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_odoo_stuecklisten_check'
const ADMIN = { name: 'odoo-test', role: 'admin' as const }

let h: Harness
const v: Record<string, string> = {}
const t: Record<string, string> = {}

before(async () => {
  process.env.ODOO_FAKE = '1'
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

async function stueck(): Promise<string> {
  return (await h.sql<{ id: string }[]>`select id from uoms where name = 'Stück'`)[0].id
}

/** Vorlage mit einer Variante je Layout (wie ein Shopify-Produkt mit Varianten). */
async function vorlage(name: string, skus: string[]): Promise<string> {
  const [tpl] = await h.sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, can_be_sold) values (${name}, ${await stueck()}, true)
    returning id`
  if (skus.length > 1) {
    const [attr] = await h.sql<{ id: string }[]>`
      insert into product_attributes (name) values (${`Layout ${name}`}) returning id`
    for (const sku of skus) {
      await h.sql`insert into product_attribute_values (attribute_id, name) values (${attr.id}, ${sku})`
    }
    const [line] = await h.sql<{ id: string }[]>`
      insert into product_template_attribute_lines (template_id, attribute_id)
      values (${tpl.id}, ${attr.id}) returning id`
    await h.sql`insert into product_template_attribute_values (line_id, value_id)
                select ${line.id}, id from product_attribute_values where attribute_id = ${attr.id}`
  }
  await h.sql`select generate_variants(${tpl.id})`
  const varianten = await h.sql<{ id: string; display_name: string }[]>`
    select id, display_name from product_variants where template_id = ${tpl.id} and active order by display_name`
  for (const sku of skus) {
    const passend = varianten.find((x) => skus.length === 1 || x.display_name.includes(sku))!
    await h.sql`update product_variants set sku = ${sku} where id = ${passend.id}`
    v[sku] = passend.id
  }
  return tpl.id
}

describe('Odoo-Stücklisten übernehmen', () => {
  test('Vorbereitung: Artikel wie aus Shopify', async () => {
    t.weiss = await vorlage('NATIVE 75 Weiß', ['FAKE-KB-W-DE', 'FAKE-KB-W-US'])
    t.schwarz = await vorlage('NATIVE 75 Schwarz', ['FAKE-KB-B-DE'])
    t.tester = await vorlage('Switch-Tester', ['FAKE-ST-1'])
    // Keycaps DE werden im Shop einzeln verkauft: schon da, mit Preis und 3 Stück.
    t.kc = await vorlage('Keycaps ISO-DE (Shop)', ['FAKE-KC-DE'])
    await h.sql`update product_templates set standard_cost = 15 where id = ${t.kc}`
    const [lager] = await h.sql<{ id: string }[]>`select id from stock_locations where full_path = 'WH/Stock'`
    const [z] = await h.sql<{ id: string }[]>`
      insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
      values (${lager.id}, ${v['FAKE-KC-DE']}, 3, 0) returning id`
    await h.sql`select inventory_apply(${z.id}, 'test')`
    // Switches schon da, ohne Preis und Bestand.
    t.sw = await vorlage('Switch linear (Shop)', ['FAKE-SW-1'])
    // Zubehör aus dem Shop, ohne Stückliste — Odoo hat 375 Stück.
    t.dm = await vorlage('Deskmat (Shop)', ['FAKE-DM-1'])
    // Ein früherer Lauf (vor 2026-09-30) schrieb Weiß je Variante.
    for (const sku of ['FAKE-KB-W-DE', 'FAKE-KB-W-US']) {
      await h.sql`insert into boms (template_id, variant_id, qty, uom_id, herkunft)
                  values (${t.weiss}, ${v[sku]}, 1, ${await stueck()}, 'odoo')`
    }
  })

  test('Vorschau schreibt nichts und zeigt Plan, Neues und Fehlendes', async () => {
    const vorher = (await h.sql<{ n: number }[]>`select count(*)::int as n from boms`)[0].n
    const r = await aktionAusfuehrenGeprueft('integrationen.odoo_vorschau', {}, ADMIN)
    const d = r.daten as {
      uebersicht: Record<string, number>
      fertigprodukte: { code: string; status: string }[]
      stuecklisten: { jeVariante: boolean; skus: string[]; zeilen: { komponente: string; filter: string }[] }[]
      lagerbestaende: { code: string; status: string; menge: number }[]
    }
    assert.equal(d.uebersicht.stuecklisten, 3, 'Weiß (eine für beide Layouts), Schwarz, Switch-Tester')
    assert.equal(d.uebersicht.vorlagenStuecklisten, 3)
    assert.equal(d.uebersicht.komponentenNeu, 6)
    assert.equal(d.uebersicht.komponentenVorhanden, 2)
    assert.equal(d.fertigprodukte.find((f) => f.code === 'FAKE-KB-B-US')?.status, 'fehlt')
    const weiss = d.stuecklisten.find((s) => s.skus.includes('FAKE-KB-W-DE'))!
    assert.equal(weiss.jeVariante, false)
    assert.match(weiss.zeilen.find((z) => z.komponente === 'FAKE-KC-US')?.filter ?? '', /FAKE-KB-W-US/, 'ANSI-Keycaps nur für die ANSI-Variante')
    assert.equal(weiss.zeilen.find((z) => z.komponente === 'FAKE-PL-1')?.filter, '', 'Platine für alle')
    const lager = Object.fromEntries(d.lagerbestaende.map((l) => [l.code, `${l.status} ${l.menge}`]))
    assert.deepEqual(lager, { 'FAKE-DM-1': 'buchen 375', 'FAKE-DM-X': 'fehlt 4', 'FAKE-ST-1': 'fertigprodukt 12' })
    assert.equal((await h.sql<{ n: number }[]>`select count(*)::int as n from boms`)[0].n, vorher)
  })

  test('Übernahme: eine Stückliste je Artikel mit Filtern, Komponenten, Preise und Bestand nur wo 0, Routen', async () => {
    const r = await aktionAusfuehrenGeprueft('integrationen.odoo_stuecklisten_uebernehmen', {}, ADMIN)
    const b = r.daten as Record<string, number>
    assert.equal(b.stuecklistenNeu, 3)
    assert.equal(b.stuecklistenAbgeloest, 2, 'die alten Varianten-Stücklisten von Weiß')
    assert.equal(b.komponentenNeu, 6)
    assert.equal(b.komponentenZugeordnet, 2)
    assert.equal(b.bestandWeitere, 1, 'Deskmat — der Switch-Tester ist Fertigprodukt')

    // Beide Weiß-Varianten lösen dieselbe Vorlagen-Stückliste auf; die Filter
    // entscheiden je Variante (wie „Auf Varianten anwenden" in Odoo).
    const [bomDe, bomUs] = await Promise.all(
      ['FAKE-KB-W-DE', 'FAKE-KB-W-US'].map(async (sku) =>
        (await h.sql<{ bom: string }[]>`select resolve_bom(${v[sku]}) as bom`)[0].bom),
    )
    assert.equal(bomDe, bomUs)
    const [kopf] = await h.sql<{ variant_id: string | null; herkunft: string }[]>`
      select variant_id, herkunft from boms where id = ${bomDe}`
    assert.deepEqual(kopf, { variant_id: null, herkunft: 'odoo' })

    // Weiß-DE: Gehäuse Weiß, Platine, Keycaps DE, 70 Switches, 1 Dutzend Schrauben.
    const zeilen = async (variante: string) =>
      Object.fromEntries(
        (await h.sql<{ sku: string | null; name: string; qty: number; uom: string }[]>`
          select pv.sku, pt.name, c.qty::float as qty, u.name as uom
          from bom_components_for_variant(resolve_bom(${variante}), ${variante}) c
          join product_variants pv on pv.id = c.component_variant_id
          join product_templates pt on pt.id = pv.template_id
          join uoms u on u.id = c.uom_id`).map((z) => [z.sku ?? z.name, `${z.qty} ${z.uom}`]),
      )
    assert.deepEqual(await zeilen(v['FAKE-KB-W-DE']), {
      'FAKE-GH-W': '1 Stück',
      'FAKE-PL-1': '1 Stück',
      'FAKE-KC-DE': '1 Stück',
      'FAKE-SW-1': '70 Stück',
      'Schrauben M2': '1 Dutzend',
    })
    const us = await zeilen(v['FAKE-KB-W-US'])
    assert.equal(us['FAKE-KC-US'], '1 Stück', 'ANSI-Variante: ANSI-Keycaps')
    assert.equal(us['FAKE-KC-DE'], undefined, '… und keine DE-Keycaps')
    assert.deepEqual(await zeilen(v['FAKE-ST-1']), { 'FAKE-SW-1': '9 Stück', 'FAKE-KLEBER': '5 g' })

    // Zugeordnete bleiben, wie sie sind; Preis/Bestand nur, wo KRNL 0 hatte.
    const artikel = async (id: string) =>
      (await h.sql<{ name: string; standard_cost: number; bestand: number }[]>`
        select pt.name, pt.standard_cost, on_hand_qty(pv.id, null)::float as bestand
        from product_variants pv join product_templates pt on pt.id = pv.template_id where pv.id = ${id}`)[0]
    assert.deepEqual(await artikel(v['FAKE-KC-DE']), { name: 'Keycaps ISO-DE (Shop)', standard_cost: 15, bestand: 3 })
    assert.deepEqual(await artikel(v['FAKE-SW-1']), { name: 'Switch linear (Shop)', standard_cost: 0.25, bestand: 5000 })
    // Auch Artikel ohne Stückliste: Deskmat (zwei Odoo-Lagerorte summiert). Das
    // Fertigprodukt nicht — sein Odoo-Bestand stimmt nicht (nicht ausgebucht).
    assert.deepEqual(await artikel(v['FAKE-DM-1']), { name: 'Deskmat (Shop)', standard_cost: 6, bestand: 375 })
    assert.equal((await artikel(v['FAKE-ST-1'])).bestand, 0)
    const [notiz] = await h.sql<{ note: string }[]>`
      select note from inventory_counts where variant_id = ${v['FAKE-DM-1']}`
    assert.match(notiz.note, /^Odoo-Übernahme odoo-api /, 'Übernahme-Buchungen sind markiert')

    // Neue Komponente mit Preis und Lieferant; der Bestand der Switches ist bewertet.
    const [gh] = await h.sql<{ standard_cost: number; can_be_sold: boolean }[]>`
      select pt.standard_cost, pt.can_be_sold from product_variants pv
      join product_templates pt on pt.id = pv.template_id where pv.sku = 'FAKE-GH-W'`
    assert.deepEqual(gh, { standard_cost: 20, can_be_sold: false })
    const [lief] = await h.sql<{ name: string; price: number; min_qty: number }[]>`
      select p.name, vp.price, vp.min_qty from vendor_prices vp join partners p on p.id = vp.vendor_id
      where vp.template_id = ${t.sw}`
    assert.deepEqual(lief, { name: 'Gateron (Fake)', price: 0.22, min_qty: 1000 })
    const [wert] = await h.sql<{ valuation_total: number }[]>`
      select valuation_total from product_variants where id = ${v['FAKE-SW-1']}`
    assert.equal(Number(wert.valuation_total), 1250, '5000 × 0,25 € — Preis vor Bestand')

    // Routen: Weiß und Schwarz (alle aktiven Varianten abgedeckt) auf Auftrag; Tester nur Fertigen.
    const routen = await h.sql<{ id: string; route_manufacture: boolean; route_mto: boolean }[]>`
      select id, route_manufacture, route_mto from product_templates
      where id in (${t.weiss}, ${t.schwarz}, ${t.tester}) order by name`
    const nach = Object.fromEntries(routen.map((x) => [x.id, [x.route_manufacture, x.route_mto]]))
    assert.deepEqual(nach[t.weiss], [true, true])
    assert.deepEqual(nach[t.schwarz], [true, true])
    assert.deepEqual(nach[t.tester], [true, false])
  })

  test('zweiter Lauf: nichts doppelt, nichts neu geschrieben — auch die Komponente ohne SKU', async () => {
    const vorher = (await h.sql<{ n: number }[]>`select count(*)::int as n from product_templates`)[0].n
    const r = await aktionAusfuehrenGeprueft('integrationen.odoo_stuecklisten_uebernehmen', {}, ADMIN)
    const b = r.daten as Record<string, number>
    assert.equal(b.komponentenNeu, 0)
    assert.equal(b.stuecklistenNeu, 0)
    assert.equal(b.stuecklistenUnveraendert, 3)
    assert.equal(b.stuecklistenAbgeloest, 0)
    assert.equal(b.lieferantenpreise, 0)
    assert.equal(b.bestand, 0)
    assert.equal(b.bestandWeitere, 0)
    assert.equal((await h.sql<{ n: number }[]>`select count(*)::int as n from product_templates`)[0].n, vorher)
  })

  test('von Hand angelegte Stückliste bleibt; gefilterte Zeilen gelten nicht für fremde Variante', async () => {
    // Eine dritte, neue Weiß-Variante ohne Layout-Wert: die Vorlagen-Stückliste
    // gilt, aber keine der nach Layout gefilterten Keycap-Zeilen (wie in Odoo).
    const [neu] = await h.sql<{ id: string }[]>`
      insert into product_variants (template_id, sku, active) values (${t.weiss}, 'FAKE-KB-W-UK', true) returning id`
    const teile = await h.sql<{ sku: string | null }[]>`
      select pv.sku from bom_components_for_variant(resolve_bom(${neu.id}), ${neu.id}) c
      join product_variants pv on pv.id = c.component_variant_id`
    assert.ok(!teile.some((x) => x.sku?.startsWith('FAKE-KC-')), 'keine Keycaps ohne Layout')
    // Der nächste Lauf sieht die unbekannte Variante und fällt auf je Variante zurück.
    const vorschau = await aktionAusfuehrenGeprueft('integrationen.odoo_vorschau', {}, ADMIN)
    const weiss = (vorschau.daten as { stuecklisten: { jeVariante: boolean; skus: string[] }[] }).stuecklisten
      .filter((s) => s.skus.some((x) => x.startsWith('FAKE-KB-W-')))
    assert.ok(weiss.length === 2 && weiss.every((s) => s.jeVariante))
    await h.sql`update product_variants set active = false where id = ${neu.id}`

    // Hand-Stückliste auf dem Switch-Tester: der Lauf blockiert ihn, statt zu überschreiben.
    await h.sql`update boms set active = false where template_id = ${t.tester}`
    await h.sql`insert into boms (template_id, qty, uom_id) values (${t.tester}, 1, ${await stueck()})`
    const r = await aktionAusfuehrenGeprueft('integrationen.odoo_vorschau', {}, ADMIN)
    const d = r.daten as { blockiert: { was: string; grund: string }[] }
    assert.match(d.blockiert.find((x) => x.was === 'FAKE-ST-1')?.grund ?? '', /von Hand/)
  })

  test('Fertigbestand zurücknehmen: nur Odoo-Zählungen, Reservierung gelöst, Fertigung nachgezogen', async () => {
    const [lager] = await h.sql<{ id: string }[]>`select id from stock_locations where full_path = 'WH/Stock'`
    const zaehlen = async (variante: string, menge: number, note: string | null) => {
      const [z] = await h.sql<{ id: string }[]>`
        insert into inventory_counts (location_id, variant_id, counted_qty, book_qty, note)
        values (${lager.id}, ${variante}, ${menge}, 0, ${note}) returning id`
      await h.sql`select inventory_apply(${z.id}, 'test')`
    }
    // Wie der Lauf von 09:11: 5 Weiß-DE aus Odoo. Weiß-US dagegen von Hand gezählt — echt.
    await zaehlen(v['FAKE-KB-W-DE'], 5, 'Odoo-Übernahme odoo-api 2026-09-30T09:11')
    await zaehlen(v['FAKE-KB-W-US'], 3, null)

    // Auftrag von vor den Stücklisten (ohne Route bestätigt): reserviert 2 vom Scheinbestand, kein Fertigungsauftrag.
    const [kunde] = await h.sql<{ id: string }[]>`
      insert into partners (name, is_customer) values ('Odoo-Testkunde', true) returning id`
    const auftrag = async (sku: string, menge: number) => {
      const [o] = await h.sql<{ id: string; number: string }[]>`
        insert into sales_orders (number, partner_id) values (next_sequence('sale'), ${kunde.id}) returning id, number`
      await h.sql`insert into sales_order_lines (order_id, variant_id, name, qty, uom_id, price_unit)
                  values (${o.id}, ${v[sku]}, ${sku}, ${menge}, ${await stueck()}, 199)`
      await h.sql`select confirm_sales_order(${o.id}, 'test')`
      return o
    }
    await h.sql`update product_templates set route_mto = false where id = ${t.weiss}`
    const alt = await auftrag('FAKE-KB-W-DE', 2)
    await h.sql`update product_templates set route_mto = true where id = ${t.weiss}`
    const neu = await auftrag('FAKE-KB-W-US', 1)
    const reserviert = async (o: string) =>
      (await h.sql<{ reserved: number; state: string }[]>`
        select m.reserved_qty::float as reserved, m.state::text as state from stock_moves m
        join stock_pickings p on p.id = m.picking_id where p.origin_model = 'sales_order' and p.origin_id = ${o}`)[0]
    assert.deepEqual(await reserviert(alt.id), { reserved: 2, state: 'assigned' }, 'vom Scheinbestand reserviert')
    const mos = async (o: string) =>
      (await h.sql<{ qty: number; state: string; origin: string | null }[]>`
        select qty_to_produce::float as qty, state::text as state, origin from manufacturing_orders
        where sales_order_id = ${o} order by created_at`).map((x) => ({ ...x }))
    assert.equal((await mos(alt.id)).length, 0)
    assert.equal((await mos(neu.id)).length, 1, 'neue Aufträge bekommen ihn bei der Bestätigung')

    const r = await aktionAusfuehrenGeprueft('integrationen.odoo_fertigbestand_zuruecknehmen', {}, ADMIN)
    const b = r.daten as {
      varianten: number; menge: number; reservierungenGeloest: number
      uebersprungen: { sku: string }[]; fertigungsauftraege: { nummer: string; sku: string; menge: number }[]
    }
    assert.deepEqual([b.varianten, b.menge, b.reservierungenGeloest], [1, 5, 1])
    assert.deepEqual(b.uebersprungen.map((u) => u.sku), ['FAKE-KB-W-US'], 'von Hand gezählter Bestand bleibt')
    assert.deepEqual(b.fertigungsauftraege, [{ nummer: alt.number, sku: 'FAKE-KB-W-DE', menge: 2 }])

    const bestand = async (sku: string) =>
      (await h.sql<{ n: number }[]>`select on_hand_qty(${v[sku]}, null)::float as n`)[0].n
    assert.equal(await bestand('FAKE-KB-W-DE'), 0)
    assert.equal(await bestand('FAKE-KB-W-US'), 3)
    assert.deepEqual(await reserviert(alt.id), { reserved: 0, state: 'confirmed' }, 'Lieferung wartet wieder')
    assert.deepEqual(await mos(alt.id), [{ qty: 2, state: 'confirmed', origin: alt.number }])
    assert.equal((await mos(neu.id)).length, 1, 'kein doppelter Fertigungsauftrag')
    const [korrektur] = await h.sql<{ note: string; counted_qty: number }[]>`
      select note, counted_qty::float as counted_qty from inventory_counts
      where variant_id = ${v['FAKE-KB-W-DE']} order by created_at desc limit 1`
    assert.deepEqual({ ...korrektur }, { note: 'Odoo-Fertigbestand zurückgenommen (in Odoo nicht ausgebucht)', counted_qty: 0 })

    // Zweiter Klick: nichts mehr zu tun.
    const nochmal = (await aktionAusfuehrenGeprueft('integrationen.odoo_fertigbestand_zuruecknehmen', {}, ADMIN))
      .daten as { varianten: number; fertigungsauftraege: unknown[] }
    assert.deepEqual([nochmal.varianten, nochmal.fertigungsauftraege.length], [0, 0])

    // Die eigene Korrektur zählt nicht als echte Buchung: bucht ein späterer Lauf wieder, greift der Knopf erneut.
    await zaehlen(v['FAKE-KB-W-DE'], 2, 'Odoo-Übernahme odoo-api 2026-09-30T12:00')
    const wieder = (await aktionAusfuehrenGeprueft('integrationen.odoo_fertigbestand_zuruecknehmen', {}, ADMIN))
      .daten as { varianten: number; menge: number }
    assert.deepEqual([wieder.varianten, wieder.menge], [1, 2])
    assert.equal(await bestand('FAKE-KB-W-DE'), 0)
  })

  test('Doppelte Artikel: Odoo-Komponente in den gleichen Shop-Artikel zusammenführen', async () => {
    const [lager] = await h.sql<{ id: string }[]>`select id from stock_locations where full_path = 'WH/Stock'`
    const [pl] = await h.sql<{ id: string }[]>`select id from product_variants where sku = 'FAKE-PL-1'`
    // Kommapreis wie bei den echten Switches (0,15 €) — ganzzahlige Preise verdeckten einen Typfehler.
    await h.sql`update product_templates set standard_cost = 0.15
                where id = (select template_id from product_variants where id = ${pl.id})`
    // Odoo-Bestand der Platine (steht in den Stücklisten Weiß und Schwarz); die zwei
    // Fertigungsaufträge von oben reservieren davon 3.
    const [z] = await h.sql<{ id: string }[]>`
      insert into inventory_counts (location_id, variant_id, counted_qty, book_qty, note)
      values (${lager.id}, ${pl.id}, 30, 0, 'Odoo-Übernahme odoo-api 2026-09-30T09:11') returning id`
    await h.sql`select inventory_apply(${z.id}, 'test')`
    const moRes = async (variante: string) =>
      (await h.sql<{ n: number }[]>`
        select coalesce(sum(reserved_qty), 0)::float as n from stock_moves
        where variant_id = ${variante} and production_id is not null and state not in ('done', 'cancel')`)[0].n
    assert.equal(await moRes(pl.id), 3)

    // Derselbe Teil als Shop-Artikel: ohne SKU, ohne Preis, mit Shopify-Kopplung.
    const [tpl] = await h.sql<{ id: string }[]>`
      insert into product_templates (name, uom_id, can_be_sold) values ('Platine', ${await stueck()}, true) returning id`
    await h.sql`select generate_variants(${tpl.id})`
    const [shop] = await h.sql<{ id: string }[]>`
      update product_variants set shopify_variant_id = 'gid://shopify/ProductVariant/4711'
      where template_id = ${tpl.id} returning id`

    const { zusammenfuehrenKandidaten } = await import('../../src/modules/migration/odoo/doppelte.ts')
    const k = await zusammenfuehrenKandidaten()
    assert.equal(k.links.find((l) => l.id === pl.id)?.vorschlag, shop.id, 'eindeutiger Namenstreffer')

    // Nur, was die Übernahme selbst angelegt hat, lässt sich auflösen.
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'integrationen.odoo_artikel_zusammenfuehren',
        { parameter: { aufloesen_id: v['FAKE-SW-1'], behalten_id: shop.id } },
        ADMIN,
      ),
      /angelegt hat/,
    )

    // Aus dem Formular der Seite (FormData): ohne Auswahl eine klare Meldung.
    const leer = new FormData()
    leer.set('aufloesen_id', pl.id)
    leer.set('behalten_id', '')
    await assert.rejects(
      aktionAusfuehrenGeprueft('integrationen.odoo_artikel_zusammenfuehren', { formData: leer }, ADMIN),
      /Shop-Artikel wählen/,
    )

    const formular = new FormData()
    formular.set('aufloesen_id', pl.id)
    formular.set('behalten_id', shop.id)
    const r = await aktionAusfuehrenGeprueft('integrationen.odoo_artikel_zusammenfuehren', { formData: formular }, ADMIN)
    const b = r.daten as Record<string, unknown>
    assert.deepEqual(
      [b.bestand, b.stuecklistenzeilen, b.offeneBewegungen, b.preisUebernommen, b.sku],
      [30, 2, 2, true, 'sku'],
    )

    const [nachher] = await h.sql<{ sku: string; bestand: number; preis: number; alt_aktiv: boolean; alt_sku: string | null }[]>`
      select pv.sku, on_hand_qty(pv.id, null)::float as bestand, pt.standard_cost::float as preis,
             (select active from product_variants where id = ${pl.id}) as alt_aktiv,
             (select sku from product_variants where id = ${pl.id}) as alt_sku
      from product_variants pv join product_templates pt on pt.id = pv.template_id where pv.id = ${shop.id}`
    assert.deepEqual({ ...nachher }, { sku: 'FAKE-PL-1', bestand: 30, preis: 0.15, alt_aktiv: false, alt_sku: null })
    assert.equal(await moRes(shop.id), 3, 'Fertigungsaufträge reservieren jetzt den Shop-Artikel')
    const teile = await h.sql<{ id: string }[]>`
      select c.component_variant_id as id from bom_components_for_variant(resolve_bom(${v['FAKE-KB-W-DE']}), ${v['FAKE-KB-W-DE']}) c`
    assert.ok(teile.some((x) => x.id === shop.id), 'Stückliste zeigt auf den Shop-Artikel')
    const [verweis] = await h.sql<{ krnl_id: string; herkunft: string }[]>`
      select krnl_id, herkunft from odoo_verweise where odoo_tabelle = 'product_product' and odoo_id = 12`
    assert.deepEqual({ ...verweis }, { krnl_id: shop.id, herkunft: 'zugeordnet' })

    // Der nächste Lauf erkennt die Platine als Shop-Artikel und ändert nichts.
    const lauf = (await aktionAusfuehrenGeprueft('integrationen.odoo_stuecklisten_uebernehmen', {}, ADMIN))
      .daten as Record<string, number>
    assert.deepEqual([lauf.komponentenNeu, lauf.stuecklistenNeu, lauf.bestand], [0, 0, 0])
  })

  test('Odoo wird nur gelesen: schreibende Methoden sind gesperrt', async () => {
    const { odooLesen } = await import('../../src/modules/migration/odoo/api.ts')
    await assert.rejects(odooLesen('mrp.bom', 'write', [[1], { active: false }]), /gesperrt/)
    await assert.rejects(odooLesen('mrp.bom', 'unlink', [[1]]), /gesperrt/)
  })
})
