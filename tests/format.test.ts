import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { isoDatum, money, pct, qty } from '../src/modules/shared/format.ts'

/**
 * Zahlformate sind das Erste, was ein Kaufmann in einem ERP prüft. Vor diesem
 * Test standen `12.3 %` (toFixed, englischer Punkt) und `12,5 %` (qty) im
 * selben System nebeneinander, und `toISOString().slice(0,10)` lag 17× kopiert
 * herum — inklusive der Zeitzonenfalle, die bei einem reinen Datum den Vortag
 * liefern kann.
 */
describe('Formatierung: deutsche Zahlen', () => {
  test('pct rechnet den Anteil um und nutzt das Komma', () => {
    assert.equal(pct(0.123), '12,3 %')
    assert.equal(pct(0.9, 0), '90 %')
    assert.equal(pct(1), '100,0 %')
    assert.equal(pct(null), '—')
    assert.equal(pct(Number.NaN), '—')
  })

  test('qty und money bleiben deutsch', () => {
    assert.equal(qty(1234.5), '1.234,5')
    assert.ok(money(12.5).includes('12,50'))
    assert.equal(qty(null), '—')
  })
})

describe('Formatierung: Datum für Eingabefelder', () => {
  test('isoDatum nimmt Date-Objekte lokal, nicht nach UTC', () => {
    // 1. März, kurz nach Mitternacht Ortszeit: toISOString() läge in MEZ
    // beim 28./29. Februar — genau der Fehler, den der Helfer verhindert.
    assert.equal(isoDatum(new Date(2026, 2, 1, 0, 30)), '2026-03-01')
    assert.equal(isoDatum(new Date(2026, 11, 31, 23, 59)), '2026-12-31')
  })

  test('isoDatum lässt Strings vorne stehen und schluckt Leerwerte', () => {
    assert.equal(isoDatum('2026-08-21T10:00:00Z'), '2026-08-21')
    assert.equal(isoDatum('2026-08-21'), '2026-08-21')
    assert.equal(isoDatum(null), '')
    assert.equal(isoDatum(undefined), '')
  })
})
