/**
 * Fulfillment-Halt aus Shopify (0134) — die reine Logik: wann gilt eine
 * Bestellung als angehalten, was steht am Auftrag, was ändert sich.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { haltAenderung, haltAusShop, haltText } from '../src/modules/integrationen/shop-halt-logik.ts'

const hold = (reason: string, reasonNotes: string | null = null) => ({ reason, reasonNotes })

describe('haltAusShop', () => {
  test('kein Fulfillment-Auftrag auf ON_HOLD: nicht angehalten — auch wenn der Anzeige-Status anderes sagt', () => {
    assert.equal(haltAusShop('UNFULFILLED', [{ status: 'OPEN', fulfillmentHolds: [] }]), null)
    assert.equal(haltAusShop('ON_HOLD', [{ status: 'OPEN', fulfillmentHolds: [] }]), null)
    assert.equal(haltAusShop('UNFULFILLED', []), null)
  })

  test('Grund in Betriebsdeutsch, Notiz aus dem Shop', () => {
    assert.deepEqual(
      haltAusShop('ON_HOLD', [{ status: 'ON_HOLD', fulfillmentHolds: [hold('OTHER', ' Kabel beilegen ')] }]),
      { grund: 'Sonstiges', notiz: 'Kabel beilegen' },
    )
    assert.deepEqual(
      haltAusShop('ON_HOLD', [{ status: 'ON_HOLD', fulfillmentHolds: [hold('INCORRECT_ADDRESS')] }]),
      { grund: 'Adresse falsch', notiz: null },
    )
  })

  test('Teil-Halt sperrt die ganze Bestellung; mehrere Gründe und Notizen stehen nebeneinander, ohne Dopplung', () => {
    assert.deepEqual(
      haltAusShop('PARTIALLY_FULFILLED', [
        { status: 'CLOSED', fulfillmentHolds: [] },
        { status: 'ON_HOLD', fulfillmentHolds: [hold('OTHER', 'Kunde wartet bis 5.12.'), hold('HIGH_RISK_OF_FRAUD')] },
        { status: 'ON_HOLD', fulfillmentHolds: [hold('OTHER', 'Kunde wartet bis 5.12.')] },
      ]),
      { grund: 'Sonstiges · Betrugsverdacht', notiz: 'Kunde wartet bis 5.12.' },
    )
  })

  test('unbekannter Grund bleibt lesbar, Halt ohne Grundangabe bekommt einen Namen', () => {
    assert.equal(haltAusShop('ON_HOLD', [{ status: 'ON_HOLD', fulfillmentHolds: [hold('NEUER_GRUND')] }])?.grund, 'NEUER_GRUND')
    assert.deepEqual(haltAusShop('ON_HOLD', [{ status: 'ON_HOLD', fulfillmentHolds: [] }]),
      { grund: 'In Shopify angehalten', notiz: null })
  })

  test('Einzelheiten nicht lesbar (Recht fehlt): der Anzeige-Status entscheidet', () => {
    assert.deepEqual(haltAusShop('ON_HOLD', null), { grund: 'In Shopify angehalten', notiz: null })
    assert.equal(haltAusShop('UNFULFILLED', null), null)
    assert.equal(haltAusShop(null, null), null)
  })
})

describe('haltAenderung und haltText', () => {
  const frei = { halt: false, grund: null, notiz: null }
  const gehalten = { halt: true, grund: 'Sonstiges', notiz: 'Kabel beilegen' }

  test('gesetzt, geändert, aufgehoben, unverändert', () => {
    assert.equal(haltAenderung(frei, null), null)
    assert.equal(haltAenderung(frei, { grund: 'Sonstiges', notiz: null }), 'gesetzt')
    assert.equal(haltAenderung(gehalten, { grund: 'Sonstiges', notiz: 'Kabel beilegen' }), null)
    assert.equal(haltAenderung(gehalten, { grund: 'Sonstiges', notiz: 'Kabel und Keycaps' }), 'geaendert')
    assert.equal(haltAenderung(gehalten, null), 'aufgehoben')
  })

  test('nach dem Aufheben bleibt die Notiz stehen — ein neuer Halt gilt trotzdem als gesetzt', () => {
    assert.equal(haltAenderung({ halt: false, grund: 'Sonstiges', notiz: 'Kabel beilegen' },
      { grund: 'Sonstiges', notiz: 'Kabel beilegen' }), 'gesetzt')
  })

  test('eine Zeile für Meldungen', () => {
    assert.equal(haltText({ grund: 'Sonstiges', notiz: 'Kabel beilegen' }), 'Sonstiges: Kabel beilegen')
    assert.equal(haltText({ grund: 'Adresse falsch', notiz: null }), 'Adresse falsch')
    assert.equal(haltText({ grund: null, notiz: null }), 'ohne Angabe')
  })
})
