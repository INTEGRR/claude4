/**
 * Montage-Übersicht (0141, Entscheidungslog 2026-11-27): offene
 * Fertigungsaufträge → Baum nach HE/MX, Plate, Switch. Gezählt wird, was in
 * bestätigten Aufträgen noch nicht gebaut ist; die Gruppierung ist eine
 * Einstellung.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'
import { montageStand } from '../../src/modules/fertigung/montage.ts'

const DATENBANK = 'erp_montage_check'
const ADMIN = { name: 'montage-test', role: 'admin' as const }
let h: Harness
const v: Record<string, string> = {}

const aktion = (name: string, recordId: string | undefined, parameter: Record<string, unknown> = {}) =>
  aktionAusfuehrenGeprueft(name, { recordId, parameter }, ADMIN)

async function board(name: string, switches: string[]): Promise<string> {
  const r = await aktion('produkte.produkt_anlegen', undefined, {
    name, verkaufspreis: 249, verkaufbar: true, einkaufbar: false, route: 'fertigen',
    attribute: [
      { name: 'Mounting Plate', werte: [{ name: 'FR4' }, { name: 'PC' }] },
      { name: 'Switches', werte: switches.map((s) => ({ name: s })) },
    ],
  })
  const bom = await aktion('fertigung.stueckliste_anlegen', undefined, { template_id: r.recordId, qty: 1 })
  await aktion('fertigung.stueckliste_position_hinzufuegen', bom.recordId, { component_variant_id: v.teil, qty: 1, ptav_ids: [] })
  return r.recordId!
}

const variante = async (template: string, plate: string, sw: string) =>
  (await h.sql<{ id: string }[]>`
    select pv.id from product_variants pv
    where pv.template_id = ${template} and pv.active
      and pv.display_name like ${`%${plate}%`} and pv.display_name like ${`%${sw}%`}`)[0].id

/** Fertigungsauftrag anlegen und bestätigen; liefert die ID. */
async function auftrag(variantId: string, menge: number): Promise<string> {
  const mo = await aktion('fertigung.auftrag_anlegen', undefined, { variant_id: variantId, qty: menge })
  await h.sql`update manufacturing_orders set state = 'confirmed' where id = ${mo.recordId!} and state = 'draft'`
  return mo.recordId!
}

before(async () => {
  h = await harnessStart(DATENBANK)
  const teil = await aktion('produkte.produkt_anlegen', undefined, {
    name: 'Schraube', sku: 'MO-T-1', verkaufbar: false, einkaufbar: true, route: 'kaufen', attribute: [],
  })
  v.teil = (await h.sql<{ id: string }[]>`select id from product_variants where template_id = ${teil.recordId!}`)[0].id
  v.he = await board('NATIVE 1800 HE (QWERTZ) Plague Black', ['Jade Max', 'Jade Gaming'])
  v.heGruen = await board('NATIVE 1800 HE (QWERTZ) Emerald Green', ['Jade Max', 'Jade Gaming'])
  v.mx = await board('NATIVE 1800 MX (QWERTZ) Plague Black', ['Linear Yellow'])
  await aktion('fertigung.montage_ebenen_setzen', undefined, { name_teile: ['HE', 'MX'], attribute: ['Mounting Plate', 'Switches'] })
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

describe('Montage-Übersicht', () => {
  test('wie viele HE und MX, je Plate, je Switch — über Farben hinweg', async () => {
    await auftrag(await variante(v.he, 'FR4', 'Jade Max'), 6)
    await auftrag(await variante(v.heGruen, 'FR4', 'Jade Max'), 4)
    await auftrag(await variante(v.he, 'PC', 'Jade Gaming'), 3)
    v.moMx = await auftrag(await variante(v.mx, 'FR4', 'Linear Yellow'), 5)

    const s = await montageStand()
    assert.equal(s.gesamt, 18)
    assert.equal(s.auftraege, 4)
    assert.deepEqual(s.knoten.map((k) => [k.label, k.offen]), [['HE', 13], ['MX', 5]])
    assert.deepEqual(s.knoten[0].kinder.map((k) => [k.label, k.offen]), [['FR4', 10], ['PC', 3]])
    assert.deepEqual(s.knoten[0].kinder[0].kinder.map((k) => [k.label, k.offen]), [['Jade Max', 10]])
    assert.deepEqual(s.buendel[0], { schluessel: 'HE › FR4 › Jade Max', pfad: ['HE', 'FR4', 'Jade Max'], offen: 10 })
    assert.deepEqual(s.attributeBekannt, ['Mounting Plate', 'Switches'])
  })

  test('gebaut zählt nicht mehr, Entwurf und Storno zählen nie', async () => {
    await h.sql`update manufacturing_orders set qty_produced = 2 where id = ${v.moMx}`
    const entwurf = await aktion('fertigung.auftrag_anlegen', undefined, { variant_id: await variante(v.mx, 'PC', 'Linear Yellow'), qty: 9 })
    await h.sql`update manufacturing_orders set state = 'draft' where id = ${entwurf.recordId!}`
    const s = await montageStand()
    assert.deepEqual(s.knoten.map((k) => [k.label, k.offen]), [['HE', 13], ['MX', 3]])
    await h.sql`update manufacturing_orders set state = 'cancel' where id = ${v.moMx}`
    assert.deepEqual((await montageStand()).knoten.map((k) => k.label), ['HE'])
  })

  test('Gruppierung ist eine Einstellung: nur nach Switch', async () => {
    const r = await aktion('fertigung.montage_ebenen_setzen', undefined, { name_teile: [], attribute: ['Switches'] })
    assert.match(r.text ?? '', /Gruppierung: Switches/)
    const s = await montageStand()
    assert.deepEqual(s.knoten.map((k) => [k.label, k.offen]), [['Jade Max', 10], ['Jade Gaming', 3]])
  })
})
