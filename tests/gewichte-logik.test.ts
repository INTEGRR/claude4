/** Shopify-Gewicht → Gramm (Entscheidungslog 2026-10-01, Gewichte im Versand). */
import test from 'node:test'
import assert from 'node:assert/strict'
import { inGramm } from '../src/modules/integrationen/gewichte-logik.ts'

test('Einheiten werden in Gramm umgerechnet und gerundet', () => {
  assert.equal(inGramm({ unit: 'GRAMS', value: 850 }), 850)
  assert.equal(inGramm({ unit: 'KILOGRAMS', value: 1.2 }), 1200)
  assert.equal(inGramm({ unit: 'KILOGRAMS', value: '0.35' }), 350)
  assert.equal(inGramm({ unit: 'OUNCES', value: 10 }), 283)
  assert.equal(inGramm({ unit: 'POUNDS', value: 2 }), 907)
  assert.equal(inGramm({ unit: 'GRAMS', value: 0.2 }), 1, 'nie 0 bei positivem Gewicht')
})

test('kein, leeres oder unbekanntes Gewicht → null', () => {
  assert.equal(inGramm(null), null)
  assert.equal(inGramm(undefined), null)
  assert.equal(inGramm({ unit: 'GRAMS', value: 0 }), null)
  assert.equal(inGramm({ unit: 'GRAMS', value: null }), null)
  assert.equal(inGramm({ unit: 'STONES', value: 3 }), null)
})
