import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { externVersandAusShop, externVersandText, fertigungsNachfrage } from '../src/modules/verkauf/extern-versand-logik.ts'
import { EREIGNISSE } from '../src/modules/prozesse/ereignisse.ts'

/**
 * Versand außerhalb von KRNL (Sendcloud → Shopify, 2026-10-15): der pure
 * Teil — was aus der Shop-Bestellung zu lesen ist und wie die Nachfrage an
 * die Fertigung lautet. Der Lauf mit Datenbank steht in der Fixture
 * shopify-versand.ts (tests/prozesse/prozesse.test.ts).
 */

const FULFILLMENT = {
  id: 'gid://shopify/Fulfillment/77',
  status: 'SUCCESS',
  createdAt: '2026-10-15T09:00:00Z',
  trackingInfo: [{ company: 'DHL', number: 'JJD0146000030001', url: 'https://tracking.sendcloud.sc/forward?code=JJD0146000030001' }],
}

describe('Versand außerhalb von KRNL: Lesen der Shop-Bestellung', () => {
  test('nur FULFILLED zählt — unerfüllt und teilweise erfüllt nicht', () => {
    assert.equal(externVersandAusShop({ displayFulfillmentStatus: 'UNFULFILLED', fulfillments: [FULFILLMENT] }), null)
    assert.equal(externVersandAusShop({ displayFulfillmentStatus: 'PARTIALLY_FULFILLED', fulfillments: [FULFILLMENT] }), null)
    assert.equal(externVersandAusShop({ displayFulfillmentStatus: null }), null)
  })

  test('Trackingdaten aus dem letzten erfolgreichen Fulfillment', () => {
    const e = externVersandAusShop({
      displayFulfillmentStatus: 'FULFILLED',
      fulfillments: [
        { ...FULFILLMENT, id: 'gid://shopify/Fulfillment/1', status: 'CANCELLED' },
        FULFILLMENT,
      ],
    })
    assert.deepEqual(e, {
      quelle: 'shopify',
      carrier: 'DHL',
      nummer: 'JJD0146000030001',
      url: 'https://tracking.sendcloud.sc/forward?code=JJD0146000030001',
      am: '2026-10-15T09:00:00Z',
      fulfillment_id: 'gid://shopify/Fulfillment/77',
    })
    assert.equal(externVersandText(e!), 'DHL JJD0146000030001')
  })

  test('erfüllt ohne Fulfillment-Details: Zeitpunkt jetzt, ohne Trackingdaten', () => {
    const e = externVersandAusShop({ displayFulfillmentStatus: 'FULFILLED' }, '2026-10-15T10:00:00Z')
    assert.equal(e?.am, '2026-10-15T10:00:00Z')
    assert.equal(e?.nummer, null)
    assert.equal(externVersandText(e!), 'ohne Trackingdaten')
  })

  test('das Ereignis steht im Katalog', () => {
    assert.ok('shop:bestellung_versendet' in EREIGNISSE)
  })
})

describe('Versand außerhalb von KRNL: Nachfrage an die Fertigung', () => {
  test('Titel nennt Auftrag und Fertigungsaufträge, Text beide Wege und die Links', () => {
    const n = fertigungsNachfrage(
      { id: 'a1', number: 'S00042', shopify_order_name: '#5012' },
      [
        { id: 'm1', number: 'FA/0418' },
        { id: 'm2', number: 'FA/0419' },
      ],
    )
    assert.equal(n.titel, 'Extern versendet: Fertigung FA/0418, FA/0419 zu S00042 (#5012) noch durchführen?')
    assert.match(n.beschreibung, /Fertig melden/)
    assert.match(n.beschreibung, /stornieren/)
    assert.match(n.beschreibung, /\/fertigung\/m1, \/fertigung\/m2/)
    assert.match(n.beschreibung, /\/verkauf\/a1/)
    assert.ok(n.titel.length <= 200, 'Aufgaben-Titel sind auf 200 Zeichen begrenzt')
  })
})
