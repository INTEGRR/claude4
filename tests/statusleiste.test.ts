import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { type LeistenSchritt, hauptpfad, istAbbruch, leiste, mitFolgestufen } from '../src/modules/prozesse/statusleiste.ts'

/**
 * Statusleiste (Entscheidungslog 2026-10-18, UX-Audit M1): Stufen aus der
 * Prozessdefinition, Abbruch-Wege nicht im Hauptpfad.
 */

const s = (code: string, sequence: number, zustand: string | null, extra: Partial<LeistenSchritt> = {}): LeistenSchritt => ({
  code, name: code, art: 'aktion', optional: false, zustand, sequence, ...extra,
})

// Wie der Reparatur-Seed (0037): Teile optional, Storno optional mit cancel.
const REPARATUR = [
  s('start', 0, null, { art: 'start' }),
  s('anlegen', 10, 'draft'),
  s('bestaetigen', 20, 'confirmed'),
  s('beginnen', 30, 'under_repair'),
  s('teile', 40, null, { optional: true }),
  s('abschliessen', 50, 'done'),
  s('xor', 60, null, { art: 'xor' }),
  s('angebot', 70, 'done'),
  s('stornieren', 80, 'cancel', { optional: true }),
  s('ende', 90, null, { art: 'ende' }),
]

describe('Statusleiste', () => {
  test('Hauptpfad: nach sequence, ohne optionale, Abbruch und Doppel', () => {
    assert.deepEqual(hauptpfad(REPARATUR).map((p) => p.zustand), ['draft', 'confirmed', 'under_repair', 'done'])
  })

  test('Stand: erledigt vor, aktuell auf, offen nach dem Belegstatus', () => {
    const l = leiste(REPARATUR, 'under_repair')
    assert.deepEqual(l.stufen.map((x) => x.stand), ['erledigt', 'erledigt', 'aktuell', 'offen'])
    assert.equal(l.abseits, null)
  })

  test('Storniert: kein Schritt aktuell, der Beleg steht abseits', () => {
    const l = leiste(REPARATUR, 'cancel')
    assert.ok(l.stufen.every((x) => x.stand === 'offen'))
    assert.equal(l.abseits, 'cancel')
  })

  test('Ablehnen ohne optional-Flag (Retoure) bleibt trotzdem aus dem Hauptpfad', () => {
    const retoure = [s('anfragen', 10, 'angefragt'), s('ablehnen', 25, 'abgelehnt'), s('genehmigen', 20, 'genehmigt')]
    assert.deepEqual(hauptpfad(retoure).map((p) => p.zustand), ['angefragt', 'genehmigt'])
    assert.ok(istAbbruch('abgelehnt') && istAbbruch('storniert') && !istAbbruch('done'))
  })

  test('abgeschaltete optionale Schritte zählen nicht', () => {
    const p = hauptpfad([s('a', 10, 'draft'), s('b', 20, 'geprueft', { optional: true, abgeschaltet: true }), s('c', 30, 'done')])
    assert.deepEqual(p.map((x) => x.zustand), ['draft', 'done'])
  })

  test('Folgestufen: begonnene Lieferung schließt die aktuelle Stufe ab', () => {
    const verkauf = [s('anlegen', 10, 'draft'), s('bestaetigen', 30, 'sale'), s('stornieren', 50, 'cancel', { optional: true })]
    const l = mitFolgestufen(leiste(verkauf, 'sale'), [{ name: 'Geliefert', stand: 'aktuell' }, { name: 'Berechnet', stand: 'offen' }])
    assert.deepEqual(l.stufen.map((x) => [x.schritt, x.stand]), [
      ['anlegen', 'erledigt'], ['bestaetigen', 'erledigt'], ['Geliefert', 'aktuell'], ['Berechnet', 'offen'],
    ])
    const ohne = mitFolgestufen(leiste(verkauf, 'sale'), [{ name: 'Geliefert', stand: 'offen' }])
    assert.equal(ohne.stufen[1].stand, 'aktuell', 'nichts begonnen — Bestätigt bleibt aktuell')
  })
})
