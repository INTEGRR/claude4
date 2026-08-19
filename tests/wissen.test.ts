import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { PROZESS_WISSEN, werkstattSystemZusatz } from '../src/modules/ki/wissen.ts'

/**
 * Wissensbasis-Wächter: die Best Practices sind die EINE versionierte
 * Quelle für Werkstatt-Agent und Aufnahme-Strukturierung. Geprüft wird
 * Substanz (Pflichtthemen) und Disziplin (Tokenbudget) — Muster wie der
 * Instructions-Längentest des Sprachmodus.
 */
describe('Wissensbasis Prozess-Best-Practices', () => {
  test('deckt die Pflichtthemen ab und bleibt im Tokenbudget', () => {
    assert.ok(PROZESS_WISSEN.length > 500, 'kein leerer Platzhalter')
    assert.ok(PROZESS_WISSEN.length < 6000, `Budget: ${PROZESS_WISSEN.length} Zeichen`)
    for (const begriff of ['xor', 'Zustände', 'vergessene', 'IST', 'Rückfragen']) {
      assert.ok(PROZESS_WISSEN.includes(begriff), `Pflichtthema fehlt: ${begriff}`)
    }
  })

  test('der Werkstatt-Zusatz führt zum Entwurfsweg, nie zur Aktivierung', () => {
    const zusatz = werkstattSystemZusatz()
    assert.ok(zusatz.length < 10_000, `Budget: ${zusatz.length} Zeichen`)
    assert.ok(zusatz.includes('aktion_vorschlagen'), 'Entwürfe nur über den Vorschlagsweg')
    assert.ok(zusatz.includes('einstellungen.prozess_entwerfen'))
    assert.ok(zusatz.includes('/prozesse/'), 'Sichtprüfung auf der Prozessseite')
    assert.ok(zusatz.includes('von Hand'), 'Aktivierung bleibt beim Menschen')
    assert.ok(zusatz.includes(PROZESS_WISSEN), 'Zusatz trägt die Wissensbasis')
  })
})
