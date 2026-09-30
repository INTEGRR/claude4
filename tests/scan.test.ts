/**
 * Scans robust vergleichen (shared/scan.ts): ein Handscanner mit US-
 * Belegung an deutschem Windows tippt „/" als „-", „-" als „ß" und tauscht
 * Y/Z. Gesucht wird erst wie getippt, dann rückübersetzt — der Packtisch
 * fand „WH-OUT-00003" nicht (Befund 2026-09-30).
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { scanGleich, scanUsBelegung, scanVarianten } from '../src/modules/shared/scan.ts'
import { scanTreffer } from '../src/modules/versand/kommissionier-logik.ts'

describe('Scan: US-Scanner an deutschem Windows', () => {
  test('Belegnummern mit Schrägstrich kommen als Bindestrich an', () => {
    assert.equal(scanUsBelegung('WH-OUT-00003'), 'WH/OUT/00003')
    assert.equal(scanUsBelegung('MO-00012'), 'MO/00012')
    assert.deepEqual(scanVarianten(' WH-OUT-00003 '), ['WH-OUT-00003', 'WH/OUT/00003'])
  })

  test('Bindestrich, Y/Z, Raute und Unterstrich', () => {
    assert.equal(scanUsBelegung('KCß001'), 'KC-001')
    assert.equal(scanUsBelegung('ZELLOW-Y'), 'YELLOW/Z')
    assert.equal(scanUsBelegung('§1234'), '#1234')
    assert.equal(scanUsBelegung('A?B'), 'A_B')
  })

  test('Codes ohne betroffene Zeichen bleiben eine einzige Variante', () => {
    assert.deepEqual(scanVarianten('4260000000017'), ['4260000000017'])
    assert.deepEqual(scanVarianten('P00012'), ['P00012'])
    assert.deepEqual(scanVarianten('   '), [])
  })

  test('scanGleich: ohne Groß/Klein, in beiden Belegungen, nie gegen leer', () => {
    assert.ok(scanGleich('wh-out-00003', 'WH/OUT/00003'))
    assert.ok(scanGleich('KC-001', 'kc-001'), 'richtig eingestellter Scanner passt direkt')
    assert.ok(scanGleich('KCß001', 'KC-001'))
    assert.ok(!scanGleich('KC-002', 'KC-001'))
    assert.ok(!scanGleich('KC-001', null))
    assert.ok(!scanGleich('', ''))
  })

  test('Kommissionieren ordnet auch verdrehte Scans der Position zu', () => {
    const positionen = [{ variantId: 'v1', name: 'Keycap', sku: 'KC-001', barcode: null, soll: 2, uom: 'Stück' }]
    assert.deepEqual(scanTreffer(positionen, {}, 'KCß001'), { art: 'treffer', variantId: 'v1' })
    assert.deepEqual(scanTreffer(positionen, {}, 'kc-001'), { art: 'treffer', variantId: 'v1' })
    assert.deepEqual(scanTreffer(positionen, {}, 'KC-002'), { art: 'fremd' })
  })
})
