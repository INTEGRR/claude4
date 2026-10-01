import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  datumAufloesen,
  heuteInBerlin,
  istSelbst,
  teamAusText,
  uhrzeitAufloesen,
} from '../src/modules/aufgaben/termin.ts'
import { darfAbhaken, darfVerwerfen } from '../src/modules/aufgaben/rechte.ts'
import { AUFGABEN } from '../src/modules/prozesse/registry/aufgaben.ts'

/** Aufgaben (0104): gesprochene Termine und Teams, Rechte, Formular-Adapter. */

// Donnerstag, 1. Oktober 2026
const HEUTE = '2026-10-01'

describe('Termin aus Sprache und Formular', () => {
  test('relative Tage und Wochentage (heute eingeschlossen)', () => {
    assert.equal(datumAufloesen('heute', HEUTE), HEUTE)
    assert.equal(datumAufloesen('', HEUTE), HEUTE)
    assert.equal(datumAufloesen('Morgen', HEUTE), '2026-10-02')
    assert.equal(datumAufloesen('übermorgen', HEUTE), '2026-10-03')
    assert.equal(datumAufloesen('Freitag', HEUTE), '2026-10-02')
    assert.equal(datumAufloesen('bis Montag', HEUTE), '2026-10-05')
    assert.equal(datumAufloesen('nächsten Mittwoch', HEUTE), '2026-10-07')
    assert.equal(datumAufloesen('Donnerstag', HEUTE), HEUTE)
  })

  test('Datumsformate: ISO (Formular), deutsch, ohne Jahr (nächstes, wenn vorbei)', () => {
    assert.equal(datumAufloesen('2026-12-24', HEUTE), '2026-12-24')
    assert.equal(datumAufloesen('24.12.2026', HEUTE), '2026-12-24')
    assert.equal(datumAufloesen('am 3.11.', HEUTE), '2026-11-03')
    assert.equal(datumAufloesen('15.1.', HEUTE), '2027-01-15')
    assert.throws(() => datumAufloesen('31.02.2027', HEUTE), /verstehe ich nicht/)
    assert.throws(() => datumAufloesen('irgendwann', HEUTE), /verstehe ich nicht/)
  })

  test('Uhrzeit: 15, 15 Uhr, 15:30, 9.05 — leer ist erlaubt', () => {
    assert.equal(uhrzeitAufloesen('15'), '15:00')
    assert.equal(uhrzeitAufloesen('15 Uhr'), '15:00')
    assert.equal(uhrzeitAufloesen('um 15:30 Uhr'), '15:30')
    assert.equal(uhrzeitAufloesen('9.05'), '09:05')
    assert.equal(uhrzeitAufloesen(''), null)
    assert.equal(uhrzeitAufloesen(undefined), null)
    assert.throws(() => uhrzeitAufloesen('25:00'), /verstehe ich nicht/)
    assert.throws(() => uhrzeitAufloesen('nachmittags'), /verstehe ich nicht/)
  })

  test('heute in Berlin, nicht in UTC', () => {
    assert.equal(heuteInBerlin(new Date('2026-10-01T22:30:00Z')), '2026-10-02')
    assert.equal(heuteInBerlin(new Date('2026-10-01T21:30:00Z')), '2026-10-01')
  })
})

describe('Zuständig: Team oder Person', () => {
  test('Teams in Alltagssprache', () => {
    for (const t of ['Lager', 'das Lager', 'ans Lager', 'Lagerteam', 'Lager-Team', 'rolle:lager', 'alle aus dem Lager', 'Versand']) {
      assert.equal(teamAusText(t), 'lager', t)
    }
    for (const t of ['Fertigung', 'die Produktion', 'Montage-Team', 'rolle:fertigung']) {
      assert.equal(teamAusText(t), 'fertigung', t)
    }
    assert.equal(teamAusText('Büro'), 'mitarbeiter')
    assert.equal(teamAusText('rolle:mitarbeiter'), null, 'Rolle mitarbeiter heißt im Formular Büro')
  })

  test('Personen sind keine Teams; „mich" ist der Anlegende', () => {
    for (const t of ['Tino', 'Tina Lager', 'Fred Fertig', 'Mitarbeiter']) assert.equal(teamAusText(t), null, t)
    assert.ok(istSelbst('mich') && istSelbst('Mir') && !istSelbst('Michael'))
  })
})

describe('Rechte: wer darf abhaken, wer verwerfen', () => {
  const anTino = { zustaendig_id: 'tino', rolle: null, erstellt_von_id: 'chef' }
  const anLager = { zustaendig_id: null, rolle: 'lager', erstellt_von_id: 'chef' }

  test('Zuständiger, Team, Anleger und Büro haken ab — sonst niemand', () => {
    assert.ok(darfAbhaken(anTino, { id: 'tino', rollen: ['lager'] }))
    assert.ok(darfAbhaken(anTino, { id: 'chef', rollen: ['lager'] }), 'Anleger')
    assert.ok(darfAbhaken(anTino, { id: 'x', rollen: ['mitarbeiter'] }), 'Büro')
    assert.ok(!darfAbhaken(anTino, { id: 'tina', rollen: ['lager'] }))
    assert.ok(darfAbhaken(anLager, { id: 'tina', rollen: ['lager'] }))
    assert.ok(darfAbhaken(anLager, { id: 'fred', rollen: ['fertigung', 'lager'] }), 'Zusatzrolle')
    assert.ok(!darfAbhaken(anLager, { id: 'fred', rollen: ['fertigung'] }))
  })

  test('verwerfen: Anleger und Büro', () => {
    assert.ok(darfVerwerfen(anTino, { id: 'chef', rollen: ['lager'] }))
    assert.ok(darfVerwerfen(anTino, { id: 'x', rollen: ['admin'] }))
    assert.ok(!darfVerwerfen(anTino, { id: 'tino', rollen: ['lager'] }))
  })
})

describe('Formular-Adapter', () => {
  test('leere Felder fallen weg, Dauer wird Zahl, Termin-Default heute', () => {
    const fd = new FormData()
    fd.set('titel', 'Lager fegen')
    fd.set('zustaendig', 'rolle:lager')
    fd.set('faellig_am', '')
    fd.set('uhrzeit', '')
    fd.set('dauer_min', '30')
    const roh = AUFGABEN['aufgaben.anlegen'].formdata(fd)
    const p = AUFGABEN['aufgaben.anlegen'].schema.parse(roh)
    // JSON-Rundreise: zod behält leere optionale Felder als undefined.
    assert.deepEqual(JSON.parse(JSON.stringify(p)), { titel: 'Lager fegen', zustaendig: 'rolle:lager', faellig_am: 'heute', dauer_min: 30 })
  })
})
