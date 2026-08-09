import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  echteOptionen,
  istStandardOption,
  ordneVariantenZu,
  preisAufteilung,
} from '../src/modules/integrationen/produkt-import-logik.ts'

describe('Produktübernahme aus Shopify: Zuordnung', () => {
  const shop = (id: string, optionen: [string, string][], price = '100.00') => ({
    id,
    sku: null,
    barcode: null,
    price,
    optionen: optionen.map(([name, value]) => ({ name, value })),
  })

  test('erkennt Shopifys Title-Platzhalter als „keine Optionen"', () => {
    assert.equal(istStandardOption([{ name: 'Title', value: 'Default Title' }]), true)
    assert.equal(istStandardOption([{ name: 'Farbe', value: 'Weiß' }]), false)
    assert.deepEqual(echteOptionen([{ name: 'Title', values: ['Default Title'] }]), [])
    assert.equal(echteOptionen([{ name: 'Farbe', values: ['Weiß', 'Schwarz'] }]).length, 1)
  })

  test('ordnet über Attributwerte zu — Reihenfolge und Schreibung egal', () => {
    const erp = [
      { id: 'e1', werte: [{ attribut: 'Farbe', wert: 'Weiß' }, { attribut: 'Layout', wert: 'ISO' }] },
      { id: 'e2', werte: [{ attribut: 'Farbe', wert: 'Schwarz' }, { attribut: 'Layout', wert: 'ISO' }] },
    ]
    const { paare, ohnePartner } = ordneVariantenZu(erp, [
      shop('s1', [['Layout', 'ISO'], ['farbe', 'weiß']]),
      shop('s2', [['Farbe', 'Schwarz'], ['Layout', 'ISO']]),
    ])
    assert.deepEqual(paare.map((p) => [p.erpId, p.shop.id]), [['e1', 's1'], ['e2', 's2']])
    assert.equal(ohnePartner.length, 0)
  })

  test('benennt Shop-Varianten ohne Gegenstück, statt sie zu verschlucken', () => {
    const erp = [{ id: 'e1', werte: [{ attribut: 'Farbe', wert: 'Weiß' }] }]
    const { paare, ohnePartner } = ordneVariantenZu(erp, [
      shop('s1', [['Farbe', 'Weiß']]),
      shop('s2', [['Farbe', 'Lila']]),
    ])
    assert.equal(paare.length, 1)
    assert.deepEqual(ohnePartner.map((v) => v.id), ['s2'])
  })

  test('Einzelvariante mit Title-Platzhalter trifft die attributlose ERP-Variante', () => {
    const erp = [{ id: 'e1', werte: [] }]
    const { paare } = ordneVariantenZu(erp, [shop('s1', [['Title', 'Default Title']])])
    assert.deepEqual(paare.map((p) => [p.erpId, p.shop.id]), [['e1', 's1']])
  })

  test('teilt Preise in Basis und Aufpreis', () => {
    const { basis, extra } = preisAufteilung([
      shop('s1', [], '329.00'),
      shop('s2', [], '349.00'),
    ])
    assert.equal(basis, 329)
    assert.equal(extra.get('s1'), 0)
    assert.equal(extra.get('s2'), 20)
  })
})
