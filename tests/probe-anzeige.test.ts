/** Debug-Box des Shopify-Probelaufs (0102): lesbare Zeilen aus „würde senden". */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { probeZeile } from '../src/modules/integrationen/probe-anzeige.ts'

describe('Probelauf-Anzeige', () => {
  test('Bestand: je Artikel vorher → neu, ausverkauft markiert, erste Meldung erkannt', () => {
    const z = probeZeile('probe:inventorySetQuantities', {
      aenderungen: [
        { sku: 'KB-1', name: 'Tastatur Blau', vorher: 5, neu: 4 },
        { sku: null, name: 'Tastatur Gelb', vorher: 1, neu: 0 },
      ],
    })
    assert.equal(z.titel, 'Bestand an Shopify: 2 Änderung(en)')
    assert.deepEqual(z.details, ['Tastatur Blau (KB-1): 5 → 4', 'Tastatur Gelb: 1 → 0 · ausverkauft'])
    const erste = probeZeile('probe:inventorySetQuantities', { aenderungen: [{ sku: 'X', name: 'X', vorher: null, neu: 3 }] })
    assert.match(erste.titel, /erste vollständige Meldung/)
    assert.deepEqual(erste.details, ['X (X): 3'])
  })

  test('Zweitangebote (0106): eigener Eintrag, je Zeile das Shop-Angebot', () => {
    const z = probeZeile('probe:inventorySetQuantities', {
      zweitangebote: true,
      aenderungen: [{ sku: 'KB-1', name: 'Tastatur Weiß', angebot: 'Black Week Editions', vorher: 3, neu: 2 }],
    })
    assert.equal(z.titel, 'Bestand an Zweitangebote: 1 Änderung(en)')
    assert.deepEqual(z.details, ['Tastatur Weiß (KB-1) → „Black Week Editions": 3 → 2'])
  })

  test('Made-to-Order-Einrichtung und andere Mutationen', () => {
    assert.match(probeZeile('probe:productVariantsBulkUpdate', { varianten: ['A', 'B'] }).titel, /2 Variante/)
    const f = probeZeile('probe:fulfillmentCreate', {
      variables: { fulfillment: { trackingInfo: { number: '00340434', company: 'DHL' } } },
    })
    assert.equal(f.titel, 'Bestellung als versendet melden')
    assert.deepEqual(f.details, ['number: 00340434', 'company: DHL'])
    assert.equal(probeZeile('probe:irgendwas', {}).titel, 'irgendwas')
  })
})
