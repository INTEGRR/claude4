/**
 * Stückliste kopieren (Entscheidungslog 2026-11-23): die Kopie hängt die
 * „gilt nur für …"-Zuordnungen über Attribut + Wert auf das Zielprodukt um.
 * Was dort fehlt, wird nie stillschweigend zu „gilt für alle".
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_stueckliste_kopieren_check'
const ADMIN = { name: 'kopier-test', role: 'admin' as const }
let h: Harness
const v: Record<string, string> = {}

const aktion = (name: string, recordId: string | undefined, parameter: Record<string, unknown> = {}) =>
  aktionAusfuehrenGeprueft(name, { recordId, parameter }, ADMIN)

async function teil(name: string, sku: string): Promise<string> {
  const r = await aktion('produkte.produkt_anlegen', undefined, {
    name, sku, verkaufspreis: 0, einstandspreis: 1, gewicht_g: 10,
    verkaufbar: false, einkaufbar: true, route: 'kaufen', attribute: [],
  })
  const [pv] = await h.sql<{ id: string }[]>`select id from product_variants where template_id = ${r.recordId!}`
  return pv.id
}

async function board(name: string, sku: string, switches: string[]): Promise<string> {
  const r = await aktion('produkte.produkt_anlegen', undefined, {
    name, sku, verkaufspreis: 199, einstandspreis: 0, gewicht_g: 900,
    verkaufbar: true, einkaufbar: false, route: 'fertigen',
    attribute: [{ name: 'Switches', werte: switches.map((s) => ({ name: s, kuerzel: s.slice(0, 2).toUpperCase() })) }],
  })
  return r.recordId!
}

/** Attributwert-ID (ptav) eines Produkts über den Wertnamen. */
const ptav = async (template: string, wert: string) =>
  (await h.sql<{ id: string }[]>`
    select p.id from product_template_attribute_values p
    join product_template_attribute_lines l on l.id = p.line_id and l.template_id = ${template}
    join product_attribute_values w on w.id = p.value_id
    where w.name = ${wert}`)[0].id

const variante = async (template: string, wert: string) =>
  (await h.sql<{ id: string }[]>`
    select pv.id from product_variants pv
    join product_variant_attribute_values a on a.variant_id = pv.id
    where pv.template_id = ${template} and pv.active and a.ptav_id = ${await ptav(template, wert)}`)[0].id

before(async () => {
  h = await harnessStart(DATENBANK)
  v.gehaeuse = await teil('Gehäuse 1800', 'KP-CS')
  v.gelb = await teil('Switch Gelb', 'KP-SW-Y')
  v.braun = await teil('Switch Braun', 'KP-SW-B')
  v.silber = await teil('Switch Silber', 'KP-SW-S')
  v.platte = await teil('Platte', 'KP-PL')
  v.a = await board('Board 1800', 'KP-A', ['Yellow', 'Brown', 'Silver'])
  v.b = await board('Board 1800 Founders', 'KP-B', ['Yellow', 'Brown'])
  v.c = await board('Board 1800 Sonder', 'KP-C', ['Yellow', 'Brown', 'Silver'])
  // Auftragsfertigung: „Fertigen" setzt die Anlage, „Auf Bestellung" gehört bei den Boards dazu.
  await h.sql`update product_templates set route_mto = true where id in (${v.a}, ${v.b}, ${v.c})`

  const bom = await aktion('fertigung.stueckliste_anlegen', undefined, { template_id: v.a, qty: 1 })
  v.bomA = bom.recordId!
  const zeile = (komponente: string, menge: number, werte: string[]) =>
    Promise.all(werte.map((w) => ptav(v.a, w))).then((ptav_ids) =>
      aktion('fertigung.stueckliste_position_hinzufuegen', v.bomA, { component_variant_id: komponente, qty: menge, ptav_ids }))
  await zeile(v.gehaeuse, 1, [])
  await zeile(v.gelb, 85, ['Yellow'])
  await zeile(v.braun, 85, ['Brown'])
  await zeile(v.silber, 85, ['Silver'])
  await zeile(v.platte, 1, ['Yellow', 'Silver'])
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

const bedarf = async (bom: string, variant: string) =>
  (await h.sql<{ sku: string; qty: number }[]>`
    select pv.sku, k.qty::float as qty from bom_components_for_variant(${bom}, ${variant}) k
    join product_variants pv on pv.id = k.component_variant_id order by pv.sku`).map((z) => `${z.sku}×${z.qty}`)

describe('Stückliste kopieren', () => {
  test('gleiches Attribut-Set: alle Positionen, Zuordnungen hängen am Zielprodukt', async () => {
    const r = await aktion('fertigung.stueckliste_kopieren', v.bomA, { template_id: v.c })
    assert.match(r.text ?? '', /^Stückliste auf „Board 1800 Sonder" kopiert: 5 Positionen\.$/)
    v.bomC = r.recordId!
    assert.deepEqual(await bedarf(v.bomC, await variante(v.c, 'Silver')), ['KP-CS×1', 'KP-PL×1', 'KP-SW-S×85'])
    assert.deepEqual(await bedarf(v.bomC, await variante(v.c, 'Brown')), ['KP-CS×1', 'KP-SW-B×85'])
    // Kein Filter zeigt mehr auf das Quellprodukt.
    const [{ fremd }] = await h.sql<{ fremd: number }[]>`
      select count(*)::int as fremd from bom_line_variant_filters f
      join bom_lines bl on bl.id = f.bom_line_id and bl.bom_id = ${v.bomC}
      join product_template_attribute_values p on p.id = f.ptav_id
      join product_template_attribute_lines l on l.id = p.line_id
      where l.template_id <> ${v.c}`
    assert.equal(fremd, 0)
    // Die Quelle ist unverändert.
    assert.deepEqual(await bedarf(v.bomA, await variante(v.a, 'Yellow')), ['KP-CS×1', 'KP-PL×1', 'KP-SW-Y×85'])
  })

  test('fehlt ein Wert am Ziel: Position entfällt bzw. wird gekürzt — nie „gilt für alle"', async () => {
    const r = await aktion('fertigung.stueckliste_kopieren', v.bomA, { template_id: v.b })
    assert.match(r.text ?? '', /kopiert: 4 Positionen\./)
    assert.match(r.text ?? '', /Nicht übernommen, weil die Zuordnung am Zielprodukt fehlt: .*Switch Silber \(Switches: Silver\)/)
    assert.match(r.text ?? '', /Zuordnung gekürzt: .*Platte \(ohne Switches: Silver\)/)
    v.bomB = r.recordId!
    assert.deepEqual(await bedarf(v.bomB, await variante(v.b, 'Yellow')), ['KP-CS×1', 'KP-PL×1', 'KP-SW-Y×85'])
    assert.deepEqual(await bedarf(v.bomB, await variante(v.b, 'Brown')), ['KP-CS×1', 'KP-SW-B×85'], 'keine Silber-Switches, keine Platte')
  })

  test('Ziel mit Stückliste, dasselbe Produkt: abgelehnt', async () => {
    await assert.rejects(aktion('fertigung.stueckliste_kopieren', v.bomA, { template_id: v.b }), /hat schon eine aktive Stückliste/)
    await assert.rejects(aktion('fertigung.stueckliste_kopieren', v.bomA, { template_id: v.a }), /dasselbe Produkt/)
  })

  test('Hinweis, wenn dem Zielprodukt die Routen fehlen', async () => {
    const r = await aktion('produkte.produkt_anlegen', undefined, {
      name: 'Board ohne Route', sku: 'KP-D', verkaufspreis: 199, einstandspreis: 0, gewicht_g: 900,
      verkaufbar: true, einkaufbar: false, route: 'kaufen',
      attribute: [{ name: 'Switches', werte: [{ name: 'Yellow', kuerzel: 'YE' }] }],
    })
    const k = await aktion('fertigung.stueckliste_kopieren', v.bomA, { template_id: r.recordId! })
    assert.match(k.text ?? '', /Achtung: Am Produkt fehlt .*kein Fertigungsauftrag/)
  })
})
