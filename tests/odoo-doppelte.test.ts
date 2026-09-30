/**
 * Vorschlag für doppelte Artikel (Shop-Artikel ↔ aus Odoo angelegte
 * Komponente): nur eindeutige Treffer, bei Zweifel keiner — mit den echten
 * Namen aus Prod (2026-09-30).
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { aehnlichkeit, namensMerkmale, vorschlagen } from '../src/modules/migration/odoo/doppelte-vorschlag.ts'

const ODOO = [
  { id: 'ly', name: '[SW-GT-LY-001] Gateron Switch Linear Yellow' },
  { id: 'tb', name: '[SW-GT-TB-001] Gateron Switch Tactile Brown' },
  { id: 'cb', name: '[SW-GT-CB-001] Gateron Switch Clicky Blue' },
  { id: 'ls', name: '[SW-GT-LS-001] Gateron Switch Linear Speed Silver' },
  { id: 'lsr', name: '[SW-CH-LSR-001] Cherry Linear Silent Red' },
  { id: 'fb', name: '[FM-B-N75-001] Bottom Foam für Native 75' },
  { id: 'fm', name: '[FM-M-ISO-N75-001] Middle Foam ISO für Native 75' },
]
const SHOP = [
  { id: 'y', name: 'GATERON Switches (Typ: G PRO 2.0 YELLOW)' },
  { id: 'b', name: 'GATERON Switches (Typ: G PRO 2.0 BROWN)' },
  { id: 'bl', name: 'GATERON Switches (Typ: G PRO 2.0 BLUE)' },
  { id: 's', name: 'GATERON Switches (Typ: G PRO 2.0 Silver)' },
  { id: 'r', name: 'GATERON Switches (Typ: Silent Red)' },
  { id: 'pf-iso', name: 'NATIVE 75 PCB Foam (Layout: ISO)' },
  { id: 'pf-ansi', name: 'NATIVE 75 PCB Foam (Layout: ANSI)' },
  { id: 'st-y', name: 'Switchtausch Service (Switches: Linear Yellow, Reinigung: Nein)' },
  { id: 'st-r', name: 'Switchtausch Service (Switches: Silent Red, Reinigung: Ja +29€)' },
]

describe('Doppelte Artikel: Vorschlag', () => {
  test('Merkmale ohne SKU und Füllwörter', () => {
    assert.deepEqual([...namensMerkmale('[SW-GT-LY-001] Gateron Switch Linear Yellow')], ['gateron', 'yellow'])
    assert.deepEqual([...namensMerkmale('GATERON Switches (Typ: G PRO 2.0 YELLOW)')], ['gateron', 'yellow'])
    assert.equal(aehnlichkeit(new Set(), new Set(['x'])), 0)
  })

  test('eindeutige Switches vorausgewählt, Service-Varianten nie', () => {
    const v = vorschlagen(ODOO, SHOP)
    assert.equal(v.get('ly'), 'y')
    assert.equal(v.get('tb'), 'b')
    assert.equal(v.get('cb'), 'bl')
    assert.equal(v.get('ls'), 's')
  })

  test('bei Zweifel keiner: Cherry gegen Gateron, Foams ohne unterscheidendes Wort', () => {
    const v = vorschlagen(ODOO, SHOP)
    assert.equal(v.get('lsr'), undefined, 'Cherry Silent Red ≠ sicher GATERON Silent Red')
    assert.equal(v.get('fb'), undefined)
    assert.equal(v.get('fm'), undefined)
  })

  test('zwei Odoo-Teile, ein Shop-Artikel gleich gut → keiner', () => {
    const v = vorschlagen(
      [{ id: 'a', name: 'Gateron Yellow' }, { id: 'b', name: 'Yellow Gateron' }],
      [{ id: 'y', name: 'GATERON Yellow' }],
    )
    assert.equal(v.size, 0)
  })
})
