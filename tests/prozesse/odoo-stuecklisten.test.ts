/**
 * Odoo-Stücklisten per API (Migration 0090) gegen die echte Datenbank und
 * die Odoo-Attrappe (ODOO_FAKE=1): Tastaturen und Switch-Tester stehen
 * vorher in KRNL (wie aus Shopify), die Übernahme hängt die Stücklisten an,
 * legt fehlende Komponenten an, setzt Preis und Bestand nur wo 0, schaltet
 * die Routen — und ein zweiter Lauf ändert nichts.
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
  })

  test('Vorschau schreibt nichts und zeigt Plan, Neues und Fehlendes', async () => {
    const vorher = (await h.sql<{ n: number }[]>`select count(*)::int as n from boms`)[0].n
    const r = await aktionAusfuehrenGeprueft('integrationen.odoo_vorschau', {}, ADMIN)
    const d = r.daten as {
      uebersicht: Record<string, number>
      fertigprodukte: { code: string; status: string }[]
    }
    assert.equal(d.uebersicht.stuecklisten, 4, 'Weiß je Variante (2), Schwarz, Switch-Tester')
    assert.equal(d.uebersicht.komponentenNeu, 6)
    assert.equal(d.uebersicht.komponentenVorhanden, 2)
    assert.equal(d.fertigprodukte.find((f) => f.code === 'FAKE-KB-B-US')?.status, 'fehlt')
    assert.equal((await h.sql<{ n: number }[]>`select count(*)::int as n from boms`)[0].n, vorher)
  })

  test('Übernahme: Stücklisten je Variante, Komponenten, Preise und Bestand nur wo 0, Routen', async () => {
    const r = await aktionAusfuehrenGeprueft('integrationen.odoo_stuecklisten_uebernehmen', {}, ADMIN)
    const b = r.daten as Record<string, number>
    assert.equal(b.stuecklistenNeu, 4)
    assert.equal(b.komponentenNeu, 6)
    assert.equal(b.komponentenZugeordnet, 2)

    // Weiß-DE: Gehäuse Weiß, Platine, Keycaps DE, 70 Switches, 1 Dutzend Schrauben — über resolve_bom.
    const zeilen = async (variante: string) =>
      Object.fromEntries(
        (await h.sql<{ sku: string | null; name: string; qty: number; uom: string }[]>`
          select pv.sku, pt.name, l.qty::float as qty, u.name as uom
          from bom_lines l
          join product_variants pv on pv.id = l.component_variant_id
          join product_templates pt on pt.id = pv.template_id
          join uoms u on u.id = l.uom_id
          where l.bom_id = resolve_bom(${variante})`).map((z) => [z.sku ?? z.name, `${z.qty} ${z.uom}`]),
      )
    assert.deepEqual(await zeilen(v['FAKE-KB-W-DE']), {
      'FAKE-GH-W': '1 Stück',
      'FAKE-PL-1': '1 Stück',
      'FAKE-KC-DE': '1 Stück',
      'FAKE-SW-1': '70 Stück',
      'Schrauben M2': '1 Dutzend',
    })
    assert.equal((await zeilen(v['FAKE-KB-W-US']))['FAKE-KC-US'], '1 Stück', 'ANSI-Variante: ANSI-Keycaps')
    assert.deepEqual(await zeilen(v['FAKE-ST-1']), { 'FAKE-SW-1': '9 Stück', 'FAKE-KLEBER': '5 g' })

    // Zugeordnete bleiben, wie sie sind; Preis/Bestand nur, wo KRNL 0 hatte.
    const artikel = async (id: string) =>
      (await h.sql<{ name: string; standard_cost: number; bestand: number }[]>`
        select pt.name, pt.standard_cost, on_hand_qty(pv.id, null)::float as bestand
        from product_variants pv join product_templates pt on pt.id = pv.template_id where pv.id = ${id}`)[0]
    assert.deepEqual(await artikel(v['FAKE-KC-DE']), { name: 'Keycaps ISO-DE (Shop)', standard_cost: 15, bestand: 3 })
    assert.deepEqual(await artikel(v['FAKE-SW-1']), { name: 'Switch linear (Shop)', standard_cost: 0.25, bestand: 5000 })

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
    assert.equal(b.stuecklistenUnveraendert, 4)
    assert.equal(b.lieferantenpreise, 0)
    assert.equal(b.bestand, 0)
    assert.equal((await h.sql<{ n: number }[]>`select count(*)::int as n from product_templates`)[0].n, vorher)
  })

  test('von Hand angelegte Stückliste bleibt; Geschwister-Stückliste gilt nicht für fremde Variante', async () => {
    // Eine dritte, neue Weiß-Variante ohne eigene Stückliste bekommt KEINE fremde Varianten-Stückliste.
    const [neu] = await h.sql<{ id: string }[]>`
      insert into product_variants (template_id, sku, active) values (${t.weiss}, 'FAKE-KB-W-UK', true) returning id`
    const [{ bom }] = await h.sql<{ bom: string | null }[]>`select resolve_bom(${neu.id}) as bom`
    assert.equal(bom, null, 'bis 0090 bekam sie die Stückliste von Weiß-DE')

    // Hand-Stückliste auf dem Switch-Tester: der Lauf blockiert ihn, statt zu überschreiben.
    await h.sql`update boms set active = false where template_id = ${t.tester}`
    await h.sql`insert into boms (template_id, qty, uom_id) values (${t.tester}, 1, ${await stueck()})`
    const r = await aktionAusfuehrenGeprueft('integrationen.odoo_vorschau', {}, ADMIN)
    const d = r.daten as { blockiert: { was: string; grund: string }[] }
    assert.match(d.blockiert.find((x) => x.was === 'FAKE-ST-1')?.grund ?? '', /von Hand/)
  })

  test('Odoo wird nur gelesen: schreibende Methoden sind gesperrt', async () => {
    const { odooLesen } = await import('../../src/modules/migration/odoo/api.ts')
    await assert.rejects(odooLesen('mrp.bom', 'write', [[1], { active: false }]), /gesperrt/)
    await assert.rejects(odooLesen('mrp.bom', 'unlink', [[1]]), /gesperrt/)
  })
})
