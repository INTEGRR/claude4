/**
 * Odoo-Stücklisten in ein bestehendes KRNL (0090): Zuordnung per SKU,
 * Odoo-Filterlogik je Attribut, Vorlagen- vs. Varianten-Stückliste,
 * Einheiten, Preis/Bestand nur wo KRNL 0 hat, harte Blockaden.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  type KrnlDaten,
  type OdooDaten,
  bomFuer,
  stuecklistenPlan,
  zeileGilt,
} from '../src/modules/migration/odoo/stuecklisten-plan.ts'

// Attribute: Farbe (1: Weiß=11, Schwarz=12), Layout (2: ISO-DE=21, ANSI=22)
const PTAVS = [
  { id: 11, attributId: 1 },
  { id: 12, attributId: 1 },
  { id: 21, attributId: 2 },
  { id: 22, attributId: 2 },
]
const UOMS = [
  { id: 1, name: 'Units', faktor: 1, kategorieId: 1 },
  { id: 2, name: 'Dozens', faktor: 1 / 12, kategorieId: 1 },
  { id: 3, name: 'kg', faktor: 1, kategorieId: 2 },
  { id: 4, name: 'g', faktor: 1000, kategorieId: 2 },
  { id: 5, name: 'Rolle', faktor: 1, kategorieId: 9 },
]
const KRNL_UOMS = [
  { name: 'Stück', kategorie: 'Einheit', ratio: 1 },
  { name: 'Dutzend', kategorie: 'Einheit', ratio: 12 },
  { name: 'g', kategorie: 'Gewicht', ratio: 1 },
  { name: 'kg', kategorie: 'Gewicht', ratio: 1000 },
]

function variante(id: number, tmplId: number, code: string | null, ptavIds: number[] = [], teil = {}) {
  return { id, tmplId, code, barcode: null, name: code ?? `Variante ${id}`, ptavIds, standardPreis: 0, gewichtKg: null, uomId: 1, aktiv: true, ...teil }
}

const ODOO: OdooDaten = {
  vorlagen: [
    { id: 100, name: 'NATIVE 75', uomId: 1, fertigen: true, aufAuftrag: true },
    { id: 200, name: 'Switch-Tester', uomId: 1, fertigen: true, aufAuftrag: false },
    { id: 300, name: 'Teile', uomId: 1, fertigen: false, aufAuftrag: false },
  ],
  varianten: [
    variante(1, 100, 'KB-W-DE', [11, 21]),
    variante(2, 100, 'KB-W-US', [11, 22]),
    variante(3, 100, 'KB-B-DE', [12, 21]),
    variante(4, 100, 'KB-B-US', [12, 22]),
    variante(5, 200, 'ST-1'),
    variante(10, 300, 'GH-W', [], { standardPreis: 20 }),
    variante(11, 300, 'GH-B', [], { standardPreis: 20 }),
    variante(12, 300, 'PL-1', [], { standardPreis: 30 }),
    variante(13, 300, 'KC-DE', [], { standardPreis: 12 }),
    variante(14, 300, 'KC-US'),
    variante(15, 300, 'SW-1', [], { standardPreis: 0.25 }),
    variante(16, 300, null, [], { name: 'Schrauben', uomId: 2 }),
    variante(17, 300, 'KLEBER', [], { uomId: 4 }),
  ],
  ptavs: PTAVS,
  boms: [
    { id: 1000, tmplId: 100, variantId: null, menge: 1, uomId: 1, typ: 'normal', verbrauch: 'flexible', sequenz: 1 },
    { id: 2000, tmplId: 200, variantId: null, menge: 2, uomId: 1, typ: 'normal', verbrauch: 'strict', sequenz: 1 },
  ],
  bomZeilen: [
    { id: 1, bomId: 1000, variantId: 10, menge: 1, uomId: 1, sequenz: 1, filterPtavIds: [11] },
    { id: 2, bomId: 1000, variantId: 11, menge: 1, uomId: 1, sequenz: 2, filterPtavIds: [12] },
    { id: 3, bomId: 1000, variantId: 12, menge: 1, uomId: 1, sequenz: 3, filterPtavIds: [] },
    { id: 4, bomId: 1000, variantId: 13, menge: 1, uomId: 1, sequenz: 4, filterPtavIds: [21] },
    { id: 5, bomId: 1000, variantId: 14, menge: 1, uomId: 1, sequenz: 5, filterPtavIds: [22] },
    { id: 6, bomId: 1000, variantId: 15, menge: 70, uomId: 1, sequenz: 6, filterPtavIds: [] },
    // Schrauben werden in Dutzend geführt: 1 Dutzend je Tastatur
    { id: 7, bomId: 1000, variantId: 16, menge: 1, uomId: 2, sequenz: 7, filterPtavIds: [] },
    // Switch-Tester: Stückliste für 2 Stück → auf 1 normiert
    { id: 8, bomId: 2000, variantId: 15, menge: 18, uomId: 1, sequenz: 1, filterPtavIds: [] },
    { id: 9, bomId: 2000, variantId: 17, menge: 0.01, uomId: 3, sequenz: 2, filterPtavIds: [] },
  ],
  uoms: UOMS,
  lieferanten: [
    { tmplId: 300, variantId: 15, partnerId: 7, partnerName: 'Gateron', partnerEmail: 'sales@gateron.example', preis: 0.22, minMenge: 1000, lieferzeitTage: 30, waehrung: 'EUR', produktCode: 'G-SW' },
  ],
  bestand: { 15: 5000, 13: 40 },
}

function krnl(teil: Partial<KrnlDaten> = {}): KrnlDaten {
  const v = (id: string, templateId: string, sku: string, t = {}) => ({
    id, templateId, sku, barcode: null, aktiv: true, standardCost: 0, uomName: 'Stück', bestand: 0, ...t,
  })
  return {
    uoms: KRNL_UOMS,
    manuelleStuecklisten: [],
    varianten: [
      // Shopify: „NATIVE 75 Weiß" mit zwei Layouts, „Schwarz" nur DE, Switch-Tester
      v('k-w-de', 't-weiss', 'KB-W-DE'),
      v('k-w-us', 't-weiss', 'KB-W-US'),
      v('k-b-de', 't-schwarz', 'KB-B-DE'),
      v('k-st', 't-tester', 'ST-1'),
      // Keycaps DE werden im Shop auch einzeln verkauft — schon da, mit Preis und Bestand
      v('k-kc-de', 't-kc', 'KC-DE', { standardCost: 15, bestand: 3 }),
      // Switches schon da, aber ohne Preis
      v('k-sw', 't-sw', 'SW-1'),
    ],
    ...teil,
  }
}

describe('Odoo-Logik', () => {
  test('Filter: je Attribut einer der Werte (UND über Attribute, ODER innerhalb)', () => {
    const attr = new Map(PTAVS.map((p) => [p.id, p.attributId]))
    assert.equal(zeileGilt([], [11, 21], attr), true)
    assert.equal(zeileGilt([11], [11, 21], attr), true)
    assert.equal(zeileGilt([11, 21], [11, 22], attr), false, 'Weiß UND ISO-DE')
    assert.equal(zeileGilt([21, 22], [12, 22], attr), true, 'ISO-DE ODER ANSI')
  })

  test('Varianten-Stückliste vor Vorlagen-Stückliste', () => {
    const boms = [
      { id: 1, tmplId: 100, variantId: null, menge: 1, uomId: 1, typ: 'normal', verbrauch: 'warning', sequenz: 1 },
      { id: 2, tmplId: 100, variantId: 2, menge: 1, uomId: 1, typ: 'normal', verbrauch: 'warning', sequenz: 5 },
    ]
    assert.equal(bomFuer(ODOO.varianten[0], boms)?.id, 1)
    assert.equal(bomFuer(ODOO.varianten[1], boms)?.id, 2)
  })
})

describe('Plan', () => {
  const plan = stuecklistenPlan(ODOO, krnl())

  test('Fertigprodukte per SKU zugeordnet; fehlende gemeldet, nicht angelegt', () => {
    const status = Object.fromEntries(plan.fertigprodukte.map((f) => [f.code, f.status]))
    assert.deepEqual(status, {
      'KB-W-DE': 'zugeordnet',
      'KB-W-US': 'zugeordnet',
      'KB-B-DE': 'zugeordnet',
      'KB-B-US': 'fehlt',
      'ST-1': 'zugeordnet',
    })
  })

  test('verschiedene Listen je Variante → Varianten-Stücklisten; gleiche → Vorlagen-Stückliste', () => {
    const weiss = plan.stuecklisten.filter((s) => s.templateId === 't-weiss')
    assert.equal(weiss.length, 2, 'Weiß-DE und Weiß-US brauchen verschiedene Keycaps')
    assert.ok(weiss.every((s) => s.variantId !== null))
    const schwarz = plan.stuecklisten.filter((s) => s.templateId === 't-schwarz')
    assert.equal(schwarz.length, 1)
    assert.equal(schwarz[0].variantId, null, 'eine Variante → Vorlagen-Stückliste')

    const wDe = weiss.find((s) => s.variantId === 'k-w-de')!
    const zeilen = Object.fromEntries(wDe.zeilen.map((z) => [z.komponente, z.menge]))
    assert.deepEqual(zeilen, { 10: 1, 12: 1, 13: 1, 15: 70, 16: 1 }, 'Gehäuse Weiß, Platine, Keycaps DE, 70 Switches, 1 Dutzend Schrauben')
    assert.equal(wDe.zeilen.find((z) => z.komponente === 16)?.uomName, 'Dutzend', 'in der Einheit der Komponente')
  })

  test('Einheiten: auf 1 Stück normiert, kg → g', () => {
    const tester = plan.stuecklisten.find((s) => s.templateId === 't-tester')!
    assert.equal(tester.variantId, null)
    assert.equal(tester.verbrauch, 'blocked')
    const zeilen = Object.fromEntries(tester.zeilen.map((z) => [z.komponente, `${z.menge} ${z.uomName}`]))
    assert.deepEqual(zeilen, { 15: '9 Stück', 17: '5 g' }, '18 für 2 Stück → 9; 0,01 kg für 2 → 5 g')
  })

  test('Komponenten: vorhandene bleiben, Preis und Bestand nur wo KRNL 0 hat', () => {
    const k = Object.fromEntries(plan.komponenten.map((c) => [c.code ?? c.name, c]))
    assert.equal(k['KC-DE'].krnlId, 'k-kc-de')
    assert.equal(k['KC-DE'].preis, null, 'gepflegter Preis bleibt')
    assert.equal(k['KC-DE'].bestand, null, 'vorhandener Bestand bleibt')
    assert.equal(k['SW-1'].krnlId, 'k-sw')
    assert.equal(k['SW-1'].preis, 0.25, 'Preis 0 in KRNL → aus Odoo')
    assert.equal(k['SW-1'].bestand, 5000)
    assert.equal(k['SW-1'].lieferanten[0].partnerName, 'Gateron')
    assert.equal(k['GH-W'].krnlId, null, 'neu anzulegen')
    assert.equal(k['GH-W'].preis, 20)
    assert.equal(k.Schrauben.code, null, 'ohne SKU — wird angelegt und markiert')
    assert.equal(k.Schrauben.uomName, 'Dutzend')
    assert.equal(k['KLEBER'].uomName, 'g')
  })

  test('Routen nur, wenn jede aktive KRNL-Variante eine Stückliste bekommt', () => {
    const routen = Object.fromEntries(plan.routen.map((r) => [r.templateId, r]))
    assert.deepEqual(
      { fertigen: routen['t-weiss'].fertigen, aufAuftrag: routen['t-weiss'].aufAuftrag },
      { fertigen: true, aufAuftrag: true },
    )
    assert.equal(routen['t-tester'].aufAuftrag, false)

    // Eine zusätzliche KRNL-Variante ohne Odoo-Gegenstück: keine Routen für „Weiß".
    const mitLuecke = stuecklistenPlan(
      ODOO,
      krnl({
        varianten: [
          ...krnl().varianten,
          { id: 'k-w-uk', templateId: 't-weiss', sku: 'KB-W-UK', barcode: null, aktiv: true, standardCost: 0, uomName: 'Stück', bestand: 0 },
        ],
      }),
    )
    assert.ok(!mitLuecke.routen.some((r) => r.templateId === 't-weiss'))
    assert.ok(mitLuecke.stuecklisten.some((s) => s.variantId === 'k-w-de'), 'Stücklisten trotzdem')
  })

  test('hart statt still: unbekannte Einheit und Hand-Stückliste blockieren mit Grund', () => {
    const mitRolle: OdooDaten = {
      ...ODOO,
      varianten: ODOO.varianten.map((v) => (v.code === 'KLEBER' ? { ...v, uomId: 5 } : v)),
      bomZeilen: ODOO.bomZeilen.map((z) => (z.id === 9 ? { ...z, uomId: 5, menge: 1 } : z)),
    }
    const p = stuecklistenPlan(mitRolle, krnl({ manuelleStuecklisten: [{ templateId: 't-schwarz', variantId: null }] }))
    const grund = Object.fromEntries(p.blockiert.map((b) => [b.was, b.grund]))
    assert.match(grund['ST-1'], /Einheit „Rolle"/)
    assert.match(grund['KB-B-DE'], /von Hand angelegte Stückliste/)
    assert.ok(!p.stuecklisten.some((s) => s.templateId === 't-tester' || s.templateId === 't-schwarz'))
    assert.ok(p.stuecklisten.some((s) => s.templateId === 't-weiss'), 'der Rest läuft')
  })
})
