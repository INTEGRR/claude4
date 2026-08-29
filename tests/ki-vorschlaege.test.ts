import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  gruppenSpalten,
  gruppiereVorschlaege,
  istFlach,
} from '../src/modules/ki/vorschlag-gruppen.ts'

/**
 * Die Sammel-Bestätigung im KI-Chat: viele gleichartige Vorschläge einer
 * Antwort (16 Meldebestände) werden EINE Tabelle. Hier die reine
 * Gruppierungslogik — das Rendern testet der Blick auf die Seite.
 */

const v = (id: string, aktion: string, parameter: Record<string, unknown>) => ({
  id,
  aktion,
  parameter,
})

describe('KI: Vorschlagsgruppen für die Sammel-Bestätigung', () => {
  test('flach heißt: nur Skalare und null', () => {
    assert.equal(istFlach({ produkt: 'M2x6', minimum: 500, maximum: 4000, route: null }), true)
    assert.equal(istFlach({ name: 'X', positionen: [{ menge: 1 }] }), false)
    assert.equal(istFlach({ name: 'X', attribute: {} }), false)
    assert.equal(istFlach({}), true)
  })

  test('aufeinanderfolgende gleiche Aktionen mit flachen Feldern werden eine Gruppe', () => {
    const gruppen = gruppiereVorschlaege([
      v('a', 'meldebestand_anlegen', { produkt: 'A', minimum: 1, maximum: 2 }),
      v('b', 'meldebestand_anlegen', { produkt: 'B', minimum: 3, maximum: 4 }),
      v('c', 'meldebestand_anlegen', { produkt: 'C', minimum: 5, maximum: 6 }),
    ])
    assert.equal(gruppen.length, 1)
    assert.deepEqual(gruppen[0].map((e) => e.id), ['a', 'b', 'c'])
  })

  test('Aktionswechsel trennt Gruppen, die Reihenfolge bleibt', () => {
    const gruppen = gruppiereVorschlaege([
      v('a', 'meldebestand_anlegen', { produkt: 'A' }),
      v('b', 'meldebestand_anlegen', { produkt: 'B' }),
      v('c', 'kontakt_anlegen', { name: 'Neu' }),
      v('d', 'meldebestand_anlegen', { produkt: 'D' }),
    ])
    assert.deepEqual(
      gruppen.map((g) => g.map((e) => e.id)),
      [['a', 'b'], ['c'], ['d']],
    )
  })

  test('verschachtelte Feldsätze bleiben allein — sie brauchen den vollen Editor', () => {
    const gruppen = gruppiereVorschlaege([
      v('a', 'produkte.produkt_anlegen', { name: 'A', attribute: [{ name: 'Farbe', werte: [] }] }),
      v('b', 'produkte.produkt_anlegen', { name: 'B', attribute: [{ name: 'Farbe', werte: [] }] }),
    ])
    assert.equal(gruppen.length, 2)
  })

  test('Spalten sind die Vereinigung der Feldnamen in Erst-Auftritts-Reihenfolge', () => {
    const spalten = gruppenSpalten([
      v('a', 'x', { produkt: 'A', minimum: 1 }),
      v('b', 'x', { produkt: 'B', maximum: 2, route: 'buy' }),
    ])
    assert.deepEqual(spalten, ['produkt', 'minimum', 'maximum', 'route'])
  })
})
