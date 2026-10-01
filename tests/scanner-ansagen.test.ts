/**
 * Sprachansagen des Scanfelds (Entscheidungslog 2026-10-01): fester Katalog,
 * nur Katalogsätze abrufbar, Serverfehler → passender Satz.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ANSAGEN, ANSAGE_SCHLUESSEL, ansageFuerFehler, istAnsage } from '../src/modules/scanner-ansagen.ts'

test('Katalog: kurze deutsche Sätze, Schlüssel sind URL-tauglich', () => {
  assert.ok(ANSAGE_SCHLUESSEL.length >= 15)
  for (const k of ANSAGE_SCHLUESSEL) {
    assert.match(k, /^[a-z_]+$/, k)
    assert.ok(ANSAGEN[k].length > 0 && ANSAGEN[k].length <= 80, k)
  }
})

test('nur Katalogsätze sind abrufbar', () => {
  assert.equal(istAnsage('gebucht'), true)
  assert.equal(istAnsage('toString'), false, 'kein Prototyp-Schlüssel')
  assert.equal(istAnsage('beliebiger text'), false)
  assert.equal(istAnsage('../../etc'), false)
})

test('Fehlermeldungen der Lookups werden einem Satz zugeordnet', () => {
  assert.equal(ansageFuerFehler('Kein Beleg gefunden zu "XYZ"'), 'nicht_gefunden')
  assert.equal(ansageFuerFehler('Keine Lieferung gefunden zu "WH/OUT/9"'), 'nicht_gefunden')
  assert.equal(ansageFuerFehler('WH/OUT/00142 wartet auf die Fertigung: WH/MO/00003'), 'wartet_fertigung')
  assert.equal(ansageFuerFehler('WH/OUT/00142 ist bereits versendet (Warenausgang gebucht)'), 'schon_erledigt')
  assert.equal(ansageFuerFehler('WH/MO/00001 ist bereits abgeschlossen'), 'schon_erledigt')
  assert.equal(ansageFuerFehler('WH/OUT/1 ist eine Lieferung — Packen braucht Schreibrechte im Versand'), 'keine_rechte')
  assert.equal(ansageFuerFehler('DHL-Label fehlgeschlagen: Adresse ungültig'), 'fehler')
  assert.equal(ansageFuerFehler(undefined), 'fehler')
})
