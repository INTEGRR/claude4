import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalisiereEntwurf } from '../src/modules/ki/entwurf-normalisieren.ts'

/**
 * Der VorschlagEditor zeigt Arrays als Kommastrings und Objekte als
 * JSON-Strings — normalisiereEntwurf verwandelt sie vor dem Absenden
 * zurück. Diese Tests sind der Vertrag zwischen Editor und Torwächter:
 * was der Editor liefert, kommt hier als gültiger Entwurf wieder heraus.
 */
describe('normalisiereEntwurf', () => {
  it('verwandelt Kommastrings in Arrays (rollen, auswahl, schritte)', () => {
    const ergebnis = normalisiereEntwurf({
      code: 'test',
      schritte: [{ code: 'a', rollen: 'lager, admin' }],
      felder: [{ name: 'farbe', auswahl: 'rot,gruen , blau', schritte: 'a' }],
    })
    assert.deepEqual((ergebnis.schritte as Record<string, unknown>[])[0].rollen, [
      'lager',
      'admin',
    ])
    const feld = (ergebnis.felder as Record<string, unknown>[])[0]
    assert.deepEqual(feld.auswahl, ['rot', 'gruen', 'blau'])
    assert.deepEqual(feld.schritte, ['a'])
  })

  it('lässt leere Listen-Strings ganz weg statt sie als [] einzureichen', () => {
    const ergebnis = normalisiereEntwurf({
      felder: [{ name: 'betrag', auswahl: '', schritte: '  ' }],
    })
    const feld = (ergebnis.felder as Record<string, unknown>[])[0]
    assert.equal('auswahl' in feld, false)
    assert.equal('schritte' in feld, false)
    assert.equal(feld.name, 'betrag')
  })

  it('parst JSON-Strings zurück zu Objekten (params, bedingung, teilprozess_link)', () => {
    const ergebnis = normalisiereEntwurf({
      schritte: [{ code: 'a', params: '{"state": "neu"}' }],
      uebergaenge: [{ von: 'a', nach: 'b', bedingung: '{"pfad": "zusatz.budget", "op": ">", "wert": 1000}' }],
    })
    assert.deepEqual((ergebnis.schritte as Record<string, unknown>[])[0].params, {
      state: 'neu',
    })
    assert.deepEqual((ergebnis.uebergaenge as Record<string, unknown>[])[0].bedingung, {
      pfad: 'zusatz.budget',
      op: '>',
      wert: 1000,
    })
  })

  it('lässt kaputtes JSON als String stehen — die Fehlermeldung macht der Torwächter', () => {
    const ergebnis = normalisiereEntwurf({
      schritte: [{ code: 'a', params: '{kein json' }],
    })
    assert.equal((ergebnis.schritte as Record<string, unknown>[])[0].params, '{kein json')
  })

  it('macht aus Schalter-Strings echte Booleans (pflicht, in_liste, optional)', () => {
    const ergebnis = normalisiereEntwurf({
      schritte: [{ code: 'a', optional: 'true' }],
      felder: [
        { name: 'x', pflicht: 'on', in_liste: '' },
        { name: 'y', pflicht: false, in_liste: 'nein' },
      ],
    })
    assert.equal((ergebnis.schritte as Record<string, unknown>[])[0].optional, true)
    const [x, y] = ergebnis.felder as Record<string, unknown>[]
    assert.equal(x.pflicht, true)
    assert.equal(x.in_liste, false)
    assert.equal(y.pflicht, false)
    assert.equal(y.in_liste, false)
  })

  it('lässt intakte Werte und fremde Schlüssel unangetastet und mutiert nichts', () => {
    const original = {
      code: 'test',
      name: 'Test',
      schritte: [{ code: 'a', rollen: ['lager'], params: { state: 'neu' }, zustand: 'neu' }],
      felder: [{ name: 'betrag', typ: 'nummer', pflicht: true }],
    }
    const kopie = structuredClone(original)
    const ergebnis = normalisiereEntwurf(original)
    assert.deepEqual(original, kopie) // keine Mutation des Eingangsobjekts
    assert.deepEqual((ergebnis.schritte as Record<string, unknown>[])[0], {
      code: 'a',
      rollen: ['lager'],
      params: { state: 'neu' },
      zustand: 'neu',
    })
    assert.deepEqual((ergebnis.felder as Record<string, unknown>[])[0], {
      name: 'betrag',
      typ: 'nummer',
      pflicht: true,
    })
  })
})
