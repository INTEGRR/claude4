/**
 * Gewichte im Versand (Entscheidungslog 2026-10-01): aus Shopify übernehmen
 * (nur wo KRNL keines führt, auf Wunsch überschreiben) und direkt im Versand
 * setzen — der Packablauf sieht das Gewicht je Position.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_gewichte_check'
const ADMIN = { name: 'gewichte-test', role: 'admin' as const }
const LAGER = { name: 'packer', role: 'lager' as const }
let h: Harness
const v: Record<string, string> = {}

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

async function artikel(name: string, gewicht: number, gid: string): Promise<string> {
  const [stueck] = await h.sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await h.sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, weight_g) values (${name}, ${stueck.id}, ${gewicht}) returning id`
  await h.sql`select generate_variants(${tpl.id})`
  const [x] = await h.sql<{ id: string }[]>`
    update product_variants set shopify_variant_id = ${gid}, sku = ${name.replace(/\s/g, '-')}
    where template_id = ${tpl.id} returning id`
  return x.id
}

const gewicht = async (variante: string) =>
  Number((await h.sql<{ g: number }[]>`
    select pt.weight_g as g from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.id = ${variante}`)[0].g)

describe('Gewichte im Versand', () => {
  test('aus Shopify: nur wo keines gepflegt ist — mit „überschreiben" auch gepflegte', async () => {
    v.ohne = await artikel('Deskmat XL', 0, 'gid://shopify/ProductVariant/8801')
    v.mit = await artikel('Keycap Set', 500, 'gid://shopify/ProductVariant/8802')
    v.leer = await artikel('Sticker', 0, 'gid://shopify/ProductVariant/8803')
    const { fakeShopStandHinterlegen } = await import('../../src/modules/integrationen/shopify-fake.ts')
    fakeShopStandHinterlegen([
      { id: 'gid://shopify/ProductVariant/8801', inventoryItem: { measurement: { weight: { unit: 'KILOGRAMS', value: 1.2 } } } },
      { id: 'gid://shopify/ProductVariant/8802', inventoryItem: { measurement: { weight: { unit: 'GRAMS', value: 640 } } } },
      { id: 'gid://shopify/ProductVariant/8803', inventoryItem: { measurement: { weight: { unit: 'GRAMS', value: 0 } } } },
      { id: 'gid://shopify/ProductVariant/9999', inventoryItem: { measurement: { weight: { unit: 'GRAMS', value: 10 } } } },
    ])
    const r = await aktionAusfuehrenGeprueft('versand.gewichte_aus_shopify', {}, ADMIN)
    assert.deepEqual(r.daten, { gelesen: 3, gesetzt: 1, ohneGewichtImShop: 1, schonGepflegt: 1 })
    assert.deepEqual([await gewicht(v.ohne), await gewicht(v.mit), await gewicht(v.leer)], [1200, 500, 0])

    const ueber = new FormData()
    ueber.set('ueberschreiben', 'on')
    await aktionAusfuehrenGeprueft('versand.gewichte_aus_shopify', { formData: ueber }, ADMIN)
    assert.equal(await gewicht(v.mit), 640, 'überschreiben ersetzt das gepflegte Gewicht')
  })

  test('im Versand setzen — auch die Lager-Rolle (Packtisch), Komma erlaubt', async () => {
    const fd = new FormData()
    fd.set('variant_id', v.leer)
    fd.set('weight_g', '12,4')
    const r = await aktionAusfuehrenGeprueft('versand.artikelgewicht_setzen', { formData: fd }, LAGER)
    assert.match(r.text ?? '', /Sticker: 12 g gespeichert/)
    assert.equal(await gewicht(v.leer), 12)
    await assert.rejects(
      aktionAusfuehrenGeprueft('versand.artikelgewicht_setzen', { parameter: { variant_id: v.leer, weight_g: 0 } }, LAGER),
      /mindestens 1/,
    )
  })
})
