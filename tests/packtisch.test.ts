import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { packtischAbgleich } from '../src/modules/versand/packtisch-logik.ts'

const soll = [
  { qty: 2, sku: 'KC-RED', barcode: '4001234567890', product: 'Keycaps Rot' },
  { qty: 1, sku: 'KB-0001-BLK', barcode: null, product: 'Tastatur Schwarz' },
]

describe('Packtisch: Positionsabgleich (gescannt ⊇ Soll)', () => {
  test('vollständig gescannt — per SKU und per Barcode gemischt', () => {
    const r = packtischAbgleich(soll, { '4001234567890': 2, 'kb-0001-blk': 1 })
    assert.equal(r.vollstaendig, true)
    assert.deepEqual(r.fehlend, [])
    assert.deepEqual(r.fremd, [])
  })

  test('fehlende Menge wird beim Namen genannt (ist/soll)', () => {
    const r = packtischAbgleich(soll, { 'KC-RED': 1, 'KB-0001-BLK': 1 })
    assert.equal(r.vollstaendig, false)
    assert.deepEqual(r.fehlend, ['KC-RED (1/2)'])
  })

  test('gar nichts gescannt — alle Zeilen fehlen', () => {
    const r = packtischAbgleich(soll, {})
    assert.equal(r.fehlend.length, 2)
  })

  test('fremder Artikel blockiert den Abschluss', () => {
    const r = packtischAbgleich(soll, { 'KC-RED': 2, 'KB-0001-BLK': 1, 'FALSCH-123': 1 })
    assert.equal(r.vollstaendig, false)
    assert.deepEqual(r.fremd, ['falsch-123'])
  })

  test('Groß-/Kleinschreibung und Leerraum sind egal', () => {
    const r = packtischAbgleich(soll, { ' kc-red ': 2, 'KB-0001-blk': 1 })
    assert.equal(r.vollstaendig, true)
  })
})
