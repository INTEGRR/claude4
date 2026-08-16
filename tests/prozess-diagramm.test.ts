/** Datenaufbereitung des Prozessdiagramms — rein, ohne Datenbank. */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  type FlowKante,
  type FlowSchritt,
  MASSE,
  flowDaten,
} from '../src/modules/prozesse/flow-daten.ts'

const schritte: FlowSchritt[] = [
  { code: 'start', name: 'Start', art: 'start' },
  { code: 'a', name: 'Schritt A', art: 'aktion', aktion: 'lager.transfer_buchen', zustand: 'done' },
  { code: 'x', name: 'Entscheidung', art: 'xor' },
  { code: 'b', name: 'Zweig B', art: 'aktion', aktion: 'fehler.ticket_melden' },
  { code: 'c', name: 'Zweig C', art: 'dienst', job_kind: 'shopify_fulfillment_create' },
  { code: 't', name: 'Teil', art: 'prozess', teilprozess: 'wareneingang' },
  { code: 'ende', name: 'Ende', art: 'ende' },
]
const kanten: FlowKante[] = [
  { von: 'start', nach: 'a', sequence: 10 },
  { von: 'a', nach: 'x', sequence: 10 },
  { von: 'x', nach: 'b', sequence: 10, beschriftung: 'links' },
  { von: 'x', nach: 'c', sequence: 20 },
  { von: 'b', nach: 't', sequence: 10 },
  { von: 'c', nach: 't', sequence: 10 },
  { von: 't', nach: 'ende', sequence: 10 },
  // Kante zu unbekanntem Schritt fliegt raus statt zu crashen.
  { von: 'a', nach: 'gibtsnicht', sequence: 10 },
]

describe('Prozessdiagramm: Datenaufbereitung', () => {
  test('Größen je Art, Verknüpfung wird sichtbar', () => {
    const d = flowDaten(schritte, kanten)
    const von = (code: string) => d.knoten.find((k) => k.id === code)!

    assert.equal(von('start').breite, MASSE.rund.b)
    assert.equal(von('x').breite, MASSE.xor.b)
    assert.equal(von('a').breite, MASSE.schritt.b)
    assert.equal(von('a').daten.verknuepfung, 'lager.transfer_buchen')
    assert.equal(von('c').daten.verknuepfung, 'shopify_fulfillment_create')
    assert.equal(von('t').daten.verknuepfung, 'wareneingang')

    // Ungültige Kanten sind gefiltert, gültige tragen die Beschriftung.
    assert.equal(d.verbindungen.length, kanten.length - 1)
    assert.equal(d.verbindungen.find((v) => v.id === 'x->b')?.beschriftung, 'links')
  })

  test('Standort: aktuell leuchtet, Vorfahren sind erledigt, Kanten folgen', () => {
    const d = flowDaten(schritte, kanten, 'x')
    const von = (code: string) => d.knoten.find((k) => k.id === code)!

    assert.equal(von('x').daten.aktuell, true)
    assert.equal(von('a').daten.erledigt, true)
    assert.equal(von('start').daten.erledigt, true)
    assert.equal(von('b').daten.erledigt, false)
    assert.equal(von('ende').daten.erledigt, false)

    // Der gelaufene Weg ist markiert, die Kanten AUS dem Standort sind aktiv.
    assert.equal(d.verbindungen.find((v) => v.id === 'start->a')?.erledigt, true)
    assert.equal(d.verbindungen.find((v) => v.id === 'x->b')?.aktiv, true)
    assert.equal(d.verbindungen.find((v) => v.id === 'b->t')?.aktiv, false)
  })

  test('ohne Standort ist nichts markiert', () => {
    const d = flowDaten(schritte, kanten)
    assert.ok(d.knoten.every((k) => !k.daten.aktuell && !k.daten.erledigt))
    assert.ok(d.verbindungen.every((v) => !v.aktiv && !v.erledigt))
  })
})
