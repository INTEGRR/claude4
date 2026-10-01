/**
 * Shop-Verfügbarkeit (0101) durch den Torwächter: zwei Gehäusefarben als
 * eigene Shopify-Produkte werden ein Projekt (Farb-Pills), ein Optionswert
 * wird in allen Farben gesperrt, ein Gehäuse bekommt eine Schwelle, ein
 * Artikel wird abgeschaltet — und der Shop-Stand (Ist) wird gelesen.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_shop_verfuegbarkeit_check'
const ADMIN = { name: 'shop-test', role: 'admin' as const }
let h: Harness
const t: Record<string, string> = {}
const v: Record<string, string> = {}
const ptav: Record<string, string> = {}

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

async function lagern(variante: string, menge: number): Promise<void> {
  const [lager] = await h.sql<{ id: string }[]>`select id from stock_locations where full_path = 'WH/Stock'`
  const [z] = await h.sql<{ id: string }[]>`
    insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
    values (${lager.id}, ${variante}, ${menge}, 0) returning id`
  await h.sql`select inventory_apply(${z.id}, 'test')`
}

async function teil(name: string, menge: number): Promise<string> {
  const [uom] = await h.sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await h.sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, can_be_sold) values (${name}, ${uom.id}, false) returning id`
  await h.sql`select generate_variants(${tpl.id})`
  const [x] = await h.sql<{ id: string }[]>`select id from product_variants where template_id = ${tpl.id}`
  if (menge) await lagern(x.id, menge)
  return x.id
}

const soll = async (variante: string) =>
  (await h.sql<{ n: number }[]>`select shopify_soll_menge(${variante}) as n`)[0].n

describe('Shop-Verfügbarkeit: Projekte, Regeln, Shop-Stand', () => {
  test('Vorbereitung: TEST 75 in Blau und Gelb, Option Switches (Clicky Blue, Linear Yellow)', async () => {
    await h.sql`insert into settings (key, value) values ('shopify', ${h.sql.json({ mto: { modus: 'baubar', puffer: 0, deckel: 99 } })})
                on conflict (key) do update set value = excluded.value`
    const [uom] = await h.sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
    v.caseBlau = await teil('Case Blau', 5)
    v.caseGelb = await teil('Case Gelb', 30)
    v.swBlue = await teil('Switch Clicky Blue', 87 * 20)
    v.swYellow = await teil('Switch Linear Yellow', 87 * 20)
    const [attr] = await h.sql<{ id: string }[]>`insert into product_attributes (name) values ('Switches T') returning id`
    await h.sql`insert into product_attribute_values (attribute_id, name, sequence)
                values (${attr.id}, 'Clicky Blue', 1), (${attr.id}, 'Linear Yellow', 2)`
    let nr = 600
    for (const [farbe, gehaeuse] of [['Blau', v.caseBlau], ['Gelb', v.caseGelb]] as const) {
      const [tpl] = await h.sql<{ id: string }[]>`
        insert into product_templates (name, uom_id, can_be_sold, route_manufacture, route_mto)
        values (${`TEST 75 ${farbe}`}, ${uom.id}, true, true, true) returning id`
      t[farbe] = tpl.id
      const [line] = await h.sql<{ id: string }[]>`
        insert into product_template_attribute_lines (template_id, attribute_id) values (${tpl.id}, ${attr.id}) returning id`
      const werte = await h.sql<{ id: string; name: string }[]>`
        insert into product_template_attribute_values (line_id, value_id)
        select ${line.id}, id from product_attribute_values where attribute_id = ${attr.id}
        returning id, (select name from product_attribute_values x where x.id = value_id) as name`
      for (const w of werte) ptav[`${farbe}:${w.name}`] = w.id
      await h.sql`select generate_variants(${tpl.id})`
      const varianten = await h.sql<{ id: string; display_name: string }[]>`
        select id, display_name from product_variants where template_id = ${tpl.id}`
      for (const x of varianten) {
        const wert = x.display_name.includes('Clicky Blue') ? 'Blue' : 'Yellow'
        await h.sql`update product_variants set shopify_variant_id = ${`gid://shopify/ProductVariant/${++nr}`} where id = ${x.id}`
        v[`${farbe}:${wert}`] = x.id
      }
      const [bom] = await h.sql<{ id: string }[]>`
        insert into boms (template_id, qty, uom_id) values (${tpl.id}, 1, ${uom.id}) returning id`
      await h.sql`insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
                  values (${bom.id}, 10, ${gehaeuse}, 1, ${uom.id})`
      for (const [wert, sw] of [['Clicky Blue', v.swBlue], ['Linear Yellow', v.swYellow]] as const) {
        const [z] = await h.sql<{ id: string }[]>`
          insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
          values (${bom.id}, 20, ${sw}, 87, ${uom.id}) returning id`
        await h.sql`insert into bom_line_variant_filters (bom_line_id, ptav_id) values (${z.id}, ${ptav[`${farbe}:${wert}`]})`
      }
    }
    assert.deepEqual([await soll(v['Blau:Blue']), await soll(v['Gelb:Yellow'])], [5, 20])
  })

  test('Projekt: beide Farben erscheinen als ein Artikel mit Pills', async () => {
    for (const farbe of ['Blau', 'Gelb']) {
      await aktionAusfuehrenGeprueft('verkauf.shop_artikel_setzen', { parameter: { template_id: t[farbe], projekt: 'TEST 75' } }, ADMIN)
    }
    const { shopVerfuegbarkeit } = await import('../../src/modules/integrationen/shop-verfuegbarkeit.ts')
    const d = await shopVerfuegbarkeit()
    const p = d.projekte.find((x) => x.name === 'TEST 75')!
    assert.deepEqual(p.artikel.map((a) => a.kurz), ['Blau', 'Gelb'])
    const blau = p.artikel[0]
    assert.equal(blau.gemeinsam[0].name, 'Case Blau')
    const blue = blau.optionen[0].werte.find((w) => w.name === 'Clicky Blue')!
    assert.deepEqual([blue.teile[0].name, blue.teile[0].reicht, blue.aktiv], ['Switch Clicky Blue', 20, 1])
  })

  test('Option in allen Farben deaktivieren und wieder freigeben', async () => {
    const formular = new FormData()
    formular.set('template_id', t.Blau)
    formular.set('ptav_id', ptav['Blau:Clicky Blue'])
    formular.set('gesperrt', 'true')
    formular.set('alle_farben', 'on')
    const r = await aktionAusfuehrenGeprueft('verkauf.shop_option_setzen', { formData: formular }, ADMIN)
    assert.match(r.text ?? '', /gesperrt in 2 Artikel/)
    assert.deepEqual(
      [await soll(v['Blau:Blue']), await soll(v['Gelb:Blue']), await soll(v['Gelb:Yellow'])],
      [0, 0, 20],
      'Clicky Blue in beiden Farben aus, Linear Yellow bleibt',
    )
    await aktionAusfuehrenGeprueft(
      'verkauf.shop_option_setzen',
      { parameter: { template_id: t.Gelb, ptav_id: ptav['Gelb:Clicky Blue'], gesperrt: false } },
      ADMIN,
    )
    assert.deepEqual([await soll(v['Blau:Blue']), await soll(v['Gelb:Blue'])], [0, 20], 'nur Gelb freigegeben')
  })

  test('Teil: Schwelle und zurückhalten; Artikel aus', async () => {
    const regel = new FormData()
    regel.set('variant_id', v.caseGelb)
    regel.set('oos_unter', '28')
    regel.set('zurueckhalten_feld', '1')
    await aktionAusfuehrenGeprueft('verkauf.shop_variante_setzen', { formData: regel }, ADMIN)
    assert.equal(await soll(v['Gelb:Yellow']), 3, '30 Gelb-Cases, unter 28 aus → 3')

    await aktionAusfuehrenGeprueft(
      'verkauf.shop_variante_setzen',
      { parameter: { variant_id: v.caseGelb, zurueckhalten: true } },
      ADMIN,
    )
    assert.equal(await soll(v['Gelb:Yellow']), 0, 'Yellow Cases zurückgehalten')

    await aktionAusfuehrenGeprueft('verkauf.shop_artikel_setzen', { parameter: { template_id: t.Blau, modus: 'aus' } }, ADMIN)
    assert.equal(await soll(v['Blau:Yellow']), 0, 'ganzer Artikel aus')
    const [anstoss] = await h.sql<{ n: string }[]>`select value ->> 'n' as n from shopify_sync_state where key = 'inventar_anstoss'`
    assert.ok(Number(anstoss.n) >= 4, 'jede Änderung stößt den Abgleich an')
  })

  test('Shop-Stand holen: Ist aus Shopify je Variante', async () => {
    const { fakeShopStandHinterlegen } = await import('../../src/modules/integrationen/shopify-fake.ts')
    fakeShopStandHinterlegen([
      {
        id: 'gid://shopify/ProductVariant/601', inventoryQuantity: 4, inventoryPolicy: 'CONTINUE', availableForSale: true,
        product: { status: 'ACTIVE' }, inventoryItem: { id: 'gid://shopify/InventoryItem/601', tracked: false },
      },
      {
        id: 'gid://shopify/ProductVariant/999', inventoryQuantity: 0, inventoryPolicy: 'DENY', availableForSale: false,
        product: { status: 'ACTIVE' }, inventoryItem: { id: 'gid://shopify/InventoryItem/999', tracked: true },
      },
    ])
    const r = await aktionAusfuehrenGeprueft('verkauf.shop_stand_holen', {}, ADMIN)
    assert.deepEqual(r.daten, { varianten: 2, verkaufbar: 1, zugeordnet: 1 })
    const [ist] = await h.sql<{ shop_qty: number; shop_verkaufbar: boolean; shop_policy: string }[]>`
      select s.shop_qty::float as shop_qty, s.shop_verkaufbar, s.shop_policy
      from shopify_inventory_state s join product_variants pv on pv.id = s.variant_id
      where pv.shopify_variant_id = 'gid://shopify/ProductVariant/601'`
    assert.deepEqual({ ...ist }, { shop_qty: 4, shop_verkaufbar: true, shop_policy: 'CONTINUE' })
  })
})
