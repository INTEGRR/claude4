/**
 * Parcel DE Tracking: Anfrage-XML, Antwort-Parser und Statusableitung —
 * rein, ohne Netz. Die Antwortstruktur folgt der DHL-Doku (piece-shipment-
 * list → pieceshipment → pieceevent, Attribute statt Elemente).
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_SENDUNGEN_JE_AUFRUF,
  parseZtAntwort,
  trackingStatusAus,
  ztAnfrageXml,
  ztZeitstempel,
} from '../src/modules/versand/dhl-tracking-xml.ts'

const ANTWORT = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<data name="piece-shipment-list" code="0" request-id="abc">
  <data name="pieceshipment" error-status="0" piece-code="00340434161094042557"
        status="Die Sendung wurde erfolgreich zugestellt." status-timestamp="04.02.2019 15:43"
        delivery-event-flag="1" ice="DLVRD" ric="OTHER" standard-event-code="ZU" product-name="DHL PAKET">
    <data name="pieceevent" event-timestamp="03.02.2019 18:10" event-status="Die Sendung wurde im Paketzentrum bearbeitet."
          event-location="Bonn" ice="SRTD" ric="OTHER" standard-event-code="PO"/>
    <data name="pieceevent" event-timestamp="04.02.2019 15:43" event-status="Die Sendung wurde erfolgreich zugestellt."
          event-location="K&#246;ln" ice="DLVRD" ric="OTHER" standard-event-code="ZU"/>
  </data>
  <data name="pieceshipment" error-status="0" piece-code="00340434161094038253"
        status="Die Sendung wurde in das Zustellfahrzeug geladen." status-timestamp="05.02.2019 07:02"
        delivery-event-flag="0" ice="LDTMV" ric="OTHER" standard-event-code="PL">
    <data name="pieceevent" event-timestamp="05.02.2019 07:02" event-status="Die Sendung wurde in das Zustellfahrzeug geladen."
          event-location="M&amp;M Depot" ice="LDTMV" ric="OTHER" standard-event-code="PL"/>
  </data>
  <data name="pieceshipment" error-status="0" piece-code="00340434161094032954"
        status="Auftragsdaten elektronisch &#252;bermittelt" delivery-event-flag="0" ice="ULFMV" ric="OTHER" standard-event-code="ES"/>
  <data name="pieceshipment" error-status="100" piece-code="00340434161094027318" status=""/>
</data>`

describe('Parcel DE Tracking: Anfrage', () => {
  test('Anmeldung und Sendungsnummern stehen als Attribute im XML, Sonderzeichen sind maskiert', () => {
    const xml = ztAnfrageXml({
      benutzer: 'gkp-user',
      passwort: 'p&ss"w<ort',
      sendungsnummern: ['00340434161094042557', ' 00340434161094038253 '],
    })
    assert.match(xml, /appname="gkp-user"/)
    assert.match(xml, /password="p&amp;ss&quot;w&lt;ort"/)
    assert.match(xml, /request="d-get-piece-detail"/)
    assert.match(xml, /piece-code="00340434161094042557;00340434161094038253"/)
  })

  test('mehr als 20 Nummern werden abgewiesen — das ist die DHL-Grenze je Aufruf', () => {
    const zuViele = Array.from({ length: MAX_SENDUNGEN_JE_AUFRUF + 1 }, (_, i) => `0034${i}`)
    assert.throws(() => ztAnfrageXml({ benutzer: 'u', passwort: 'p', sendungsnummern: zuViele }), /20/)
    assert.throws(() => ztAnfrageXml({ benutzer: 'u', passwort: 'p', sendungsnummern: [] }))
  })
})

describe('Parcel DE Tracking: Antwort', () => {
  test('liest Rückgabecode, Sendungen und Ereignisse mit Entitäten', () => {
    const a = parseZtAntwort(ANTWORT)
    assert.equal(a.code, 0)
    assert.equal(a.sendungen.length, 4)
    const [zugestellt, unterwegs] = a.sendungen
    assert.equal(zugestellt.pieceCode, '00340434161094042557')
    assert.equal(zugestellt.deliveryEventFlag, true)
    assert.equal(zugestellt.ereignisse.length, 2)
    assert.equal(zugestellt.ereignisse[1].ort, 'Köln', 'numerische Entität aufgelöst')
    assert.equal(unterwegs.ereignisse[0].ort, 'M&M Depot', '&amp; aufgelöst')
    assert.equal(a.sendungen[2].ereignisse.length, 0, 'selbstschließende Sendung ohne Ereignisse')
  })

  test('deutscher Zeitstempel wird ISO-artig, Unsinn wird null', () => {
    assert.equal(ztZeitstempel('04.02.2019 15:43'), '2019-02-04T15:43:00')
    assert.equal(ztZeitstempel(''), null)
    assert.equal(ztZeitstempel(undefined), null)
  })

  test('Anmeldefehler kommt als Code 5 durch', () => {
    const a = parseZtAntwort('<data name="piece-shipment-list" code="5" error="login failed"/>')
    assert.equal(a.code, 5)
    assert.equal(a.sendungen.length, 0)
  })
})

describe('Parcel DE Tracking: Status', () => {
  const s = parseZtAntwort(ANTWORT).sendungen

  test('Zustellflag → delivered mit letztem Ereignis', () => {
    const r = trackingStatusAus(s[0])
    assert.equal(r?.status, 'delivered')
    assert.equal(r?.timestamp, '2019-02-04T15:43:00')
    assert.match(r?.description ?? '', /zugestellt/)
  })

  test('im Zustellfahrzeug → transit', () => {
    assert.equal(trackingStatusAus(s[1])?.status, 'transit')
  })

  test('nur Auftragsdaten übermittelt → pre-transit', () => {
    assert.equal(trackingStatusAus(s[2])?.status, 'pre-transit')
  })

  test('Sendung ohne Daten → null, nicht failure', () => {
    assert.equal(trackingStatusAus(s[3]), null)
  })

  test('Rücksendungs-/Nichtzustell-Codes → failure, Unbekanntes bleibt transit', () => {
    const basis = { ...s[1], ice: 'NTDLV' }
    assert.equal(trackingStatusAus(basis)?.status, 'failure')
    assert.equal(trackingStatusAus({ ...s[1], ice: 'XYZ99' })?.status, 'transit')
  })
})
