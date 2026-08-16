/**
 * Maskengenerierung: die formulartaugliche Feldableitung aus den
 * Registry-Schemas — datenbankfrei. Kein Registry-Schema darf in einem
 * Feldtyp landen, den das generierte Formular nicht darstellen kann.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { formularFelder } from '../src/modules/prozesse/schema-felder.ts'
import { kiKatalog } from '../src/modules/prozesse/introspektion.ts'
import { alleAktionen, registrierteAktion } from '../src/modules/prozesse/registry/index.ts'

const TYPEN = ['text', 'mehrzeilig', 'nummer', 'schalter', 'auswahl', 'verweis', 'json']

describe('Maskengenerierung: schema-felder', () => {
  test('jede Registry-Aktion liefert nur darstellbare Feldtypen', () => {
    for (const [name, aktion] of alleAktionen()) {
      for (const feld of formularFelder(aktion)) {
        assert.ok(TYPEN.includes(feld.typ), `${name}.${feld.name}: unbekannter Typ ${feld.typ}`)
        assert.ok(feld.label.length > 0, `${name}.${feld.name}: ohne Beschriftung`)
        if (feld.typ === 'auswahl') {
          assert.ok(feld.auswahl!.length > 0, `${name}.${feld.name}: Auswahl ohne Werte`)
        }
        if (feld.typ === 'verweis') {
          assert.ok(feld.quelle, `${name}.${feld.name}: Verweis ohne Quelle`)
        }
      }
    }
  })

  test('Typen, Pflicht und Vorgaben am Beispiel Reparatur-Anlage', () => {
    const felder = formularFelder(registrierteAktion('reparatur.auftrag_anlegen')!)
    const je = new Map(felder.map((f) => [f.name, f]))

    assert.equal(je.get('partner_id')!.typ, 'verweis')
    assert.equal(je.get('partner_id')!.quelle, 'partners')
    assert.equal(je.get('partner_id')!.pflicht, true)
    assert.equal(je.get('variant_id')!.typ, 'verweis')
    assert.equal(je.get('qty')!.typ, 'nummer')
    assert.equal(je.get('qty')!.pflicht, false, 'default(1) macht das Feld optional')
    assert.equal(je.get('qty')!.vorgabe, 1)
    assert.equal(je.get('under_warranty')!.typ, 'schalter')
    assert.equal(je.get('note')!.typ, 'mehrzeilig', 'max(2000) wird mehrzeilig')
  })

  test('Enums werden Auswahl, Records werden JSON', () => {
    const status = formularFelder(registrierteAktion('fehler.ticket_status')!)
    const statusFeld = status.find((f) => f.name === 'status')!
    assert.equal(statusFeld.typ, 'auswahl')
    assert.deepEqual(statusFeld.auswahl, ['offen', 'in_arbeit', 'behoben', 'verworfen'])

    const abschliessen = formularFelder(registrierteAktion('reparatur.abschliessen')!)
    assert.equal(abschliessen.find((f) => f.name === 'mengen')!.typ, 'json')
  })

  test('der KI-Katalog aus der Registry ist konsistent', () => {
    const katalog = kiKatalog()
    assert.ok(katalog.length >= 10, 'es müssen KI-freigegebene Aktionen existieren')
    for (const eintrag of katalog) {
      const aktion = registrierteAktion(eintrag.name)
      assert.ok(aktion?.ki, `${eintrag.name}: nicht (mehr) ki-geflaggt`)
      assert.equal(eintrag.beleg, aktion!.bindung === 'beleg')
    }
    // Stichprobe: Statusübergänge des Verkaufs sind für den Agenten sichtbar.
    assert.ok(katalog.some((e) => e.name === 'verkauf.bestaetigen'))
  })
})
