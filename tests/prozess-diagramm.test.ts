/** Layout des Prozessdiagramms — rein, ohne Datenbank. */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  type LayoutKante,
  type LayoutSchritt,
  layout,
} from '../src/modules/prozesse/diagramm-layout.ts'

const schritte: LayoutSchritt[] = [
  { code: 'start', name: 'Start', art: 'start' },
  { code: 'a', name: 'Schritt A', art: 'aktion' },
  { code: 'x', name: 'Entscheidung', art: 'xor' },
  { code: 'b', name: 'Zweig B', art: 'aktion' },
  { code: 'c', name: 'Zweig C', art: 'dienst' },
  { code: 'ende', name: 'Ende', art: 'ende' },
]
const kanten: LayoutKante[] = [
  { von: 'start', nach: 'a', sequence: 10 },
  { von: 'a', nach: 'x', sequence: 10 },
  { von: 'x', nach: 'b', sequence: 10 },
  { von: 'x', nach: 'c', sequence: 20 },
  { von: 'b', nach: 'ende', sequence: 10 },
  { von: 'c', nach: 'ende', sequence: 10 },
]

describe('Prozessdiagramm-Layout', () => {
  test('Ränge folgen dem längsten Pfad, Zweige öffnen Spalten', () => {
    const d = layout(schritte, kanten)
    const von = (code: string) => d.knoten.find((k) => k.code === code)!

    // Zeilen: start < a < x < b/c < ende.
    assert.ok(von('a').y > von('start').y)
    assert.ok(von('x').y > von('a').y)
    assert.equal(von('b').y, von('c').y, 'Zweige liegen auf einer Zeile')
    assert.ok(von('ende').y > von('b').y)

    // Spalten: Hauptpfad bleibt links, der zweite Zweig rückt nach rechts.
    assert.equal(von('b').x < von('c').x, true)
    // Der Join fällt auf die Spalte des Hauptpfads zurück.
    assert.ok(von('ende').x <= von('b').x + 1)

    assert.ok(d.breite > 0 && d.hoehe > 0)
    assert.equal(d.kanten.length, 6)
  })

  test('aktueller Schritt und Vorfahren sind markiert', () => {
    const d = layout(schritte, kanten, 'b')
    const von = (code: string) => d.knoten.find((k) => k.code === code)!
    assert.equal(von('b').aktuell, true)
    assert.equal(von('a').erledigt, true, 'Vorfahre des aktuellen Schritts')
    assert.equal(von('start').erledigt, true)
    assert.equal(von('c').erledigt, false, 'der nicht gegangene Zweig ist nicht erledigt')
    assert.equal(von('ende').erledigt, false)
  })

  test('unbekannte Kanten und leerer Standort stören nicht', () => {
    const d = layout(schritte, [...kanten, { von: 'geist', nach: 'a', sequence: 10 }], null)
    assert.equal(d.kanten.length, 6, 'Kanten zu unbekannten Schritten fallen weg')
    assert.ok(d.knoten.every((k) => !k.aktuell && !k.erledigt))
  })
})
