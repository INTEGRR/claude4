import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseQtyMap } from '../src/modules/shared/form.ts'

describe('parseQtyMap', () => {
  test('liest angegebene Mengen', () => {
    const fd = new FormData()
    fd.set('consumed_a', '5')
    fd.set('consumed_b', '2.5')
    fd.set('other', '99')
    assert.deepEqual(parseQtyMap(fd, 'consumed_'), { a: 5, b: 2.5 })
  })

  test('überspringt leere Felder — sie bedeuten "nicht angegeben", nicht 0', () => {
    // Genau hier lag der Fehler: Number('') ist 0, wodurch bei der
    // Fertigmeldung alle Komponenten mit Menge 0 gebucht (= storniert) wurden.
    const fd = new FormData()
    fd.set('consumed_a', '')
    fd.set('consumed_b', '   ')
    fd.set('consumed_c', '3')
    assert.deepEqual(parseQtyMap(fd, 'consumed_'), { c: 3 })
  })

  test('eine ausdrückliche 0 wird übernommen', () => {
    const fd = new FormData()
    fd.set('done_a', '0')
    assert.deepEqual(parseQtyMap(fd, 'done_'), { a: 0 })
  })

  test('ignoriert unsinnige Werte', () => {
    const fd = new FormData()
    fd.set('done_a', 'abc')
    fd.set('done_b', '-1')
    fd.set('done_c', '7')
    assert.deepEqual(parseQtyMap(fd, 'done_'), { c: 7 })
  })
})
