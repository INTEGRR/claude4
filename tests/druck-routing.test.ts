/**
 * Druckwege auflösen (0087): erst der Weg des Arbeitsplatzes, dann der
 * Ersatz, sonst Browser — und nur wohlgeformte IDs aus Cookie bzw.
 * Agent-Anfrage zählen.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  DRUCKART_LABELS,
  DRUCKART_TYP,
  DRUCKARTEN,
  type Druckweg,
  druckerFuer,
  idOderNull,
} from '../src/modules/druck/routing.ts'

const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '22222222-2222-4222-8222-222222222222'

const WEGE: Druckweg[] = [
  { work_center_id: P1, druckart: 'versandlabel', drucker_id: 'ql1' },
  { work_center_id: P2, druckart: 'versandlabel', drucker_id: 'ql2' },
  { work_center_id: null, druckart: 'versandlabel', drucker_id: 'ersatz-label' },
  { work_center_id: null, druckart: 'fertigungszettel', drucker_id: 'hp' },
]

describe('Druckwege', () => {
  test('der eigene Weg des Platzes gewinnt', () => {
    assert.deepEqual(druckerFuer(WEGE, P1, 'versandlabel'), { druckerId: 'ql1', ersatz: false })
    assert.deepEqual(druckerFuer(WEGE, P2, 'versandlabel'), { druckerId: 'ql2', ersatz: false })
  })

  test('ohne eigenen Weg springt der Ersatz ein — auch ohne Arbeitsplatz', () => {
    assert.deepEqual(druckerFuer(WEGE, P1, 'fertigungszettel'), { druckerId: 'hp', ersatz: true })
    assert.deepEqual(druckerFuer(WEGE, null, 'versandlabel'), { druckerId: 'ersatz-label', ersatz: true })
  })

  test('weder Weg noch Ersatz: null (= Browser)', () => {
    assert.equal(druckerFuer(WEGE, P1, 'packzettel'), null)
    assert.equal(druckerFuer([], null, 'versandlabel'), null)
  })

  test('jede Druckart hat Beschriftung und üblichen Druckertyp', () => {
    for (const art of DRUCKARTEN) {
      assert.ok(DRUCKART_LABELS[art], art)
      assert.ok(['label', 'a4'].includes(DRUCKART_TYP[art]), art)
    }
  })
})

describe('IDs aus fremder Hand', () => {
  test('eine UUID zählt, kleingeschrieben und ohne Leerraum', () => {
    assert.equal(idOderNull(` ${P1.toUpperCase()} `), P1)
  })

  test('alles andere ist kein Arbeitsplatz bzw. Drucker', () => {
    for (const wert of [undefined, null, '', '   ', 'PACK1', `${P1}x`, "' or 1=1 --"]) {
      assert.equal(idOderNull(wert), null, String(wert))
    }
  })
})
