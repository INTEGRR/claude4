/**
 * Die Fake-Weichen: mit SHOPIFY_FAKE=1 / DHL_FAKE=1 antworten die echten
 * Client-Module deterministisch — geprüft über deren ECHTE Exporte, damit
 * jede Signaturänderung den Fake sofort mitreißt. (Mail braucht keinen Fake:
 * ohne RESEND_API_KEY wird ohnehin nur protokolliert.)
 */
import './spur.ts'
import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'

// Die Weichen prüfen die Umgebung beim AUFRUF, nicht beim Import — die
// Reihenfolge hier ist also unkritisch.
process.env.SHOPIFY_FAKE = '1'
process.env.DHL_FAKE = '1'

/**
 * KEINE Datenbank für diesen Test — und zwar erzwungen, nicht gehofft.
 *
 * Die Client-Module protokollieren jeden Aufruf über logTransaction, auch im
 * Fake-Modus. Das Protokoll schluckt seine Fehler (fire-and-forget), also
 * fiel nie auf, dass dieser reine Weichen-Test bei gesetzter DATABASE_URL
 * eine echte Verbindung zur BASIS-Datenbank aufmacht und dort
 * api_transactions-Zeilen hinterlässt. Lokal war das unsichtbar, weil diese
 * Datei scripts/env.ts nicht lädt — in der CI steht DATABASE_URL dagegen in
 * der Umgebung.
 *
 * Zwei Folgen, beide schlecht: der Test verschmutzt eine fremde Datenbank,
 * und der Verbindungspool (ohne idle_timeout) hält den Testprozess offen.
 * node:test wartet bei --test-concurrency=1 auf dessen Ende — das war der
 * CI-Hänger: Datei 1 grün, danach fünf Minuten Stille bis zum Zeitlimit.
 */
delete process.env.DATABASE_URL

const shopify = await import('../../src/modules/integrationen/shopify.ts')
const dhl = await import('../../src/modules/versand/dhl.ts')

describe('Fake-Weichen', () => {
  test('Shopify gilt als konfiguriert und beantwortet die Fulfillment-Kette', async () => {
    assert.equal(shopify.shopifyConfigured(), true)

    const fos = await shopify.fetchFulfillmentOrders('gid://shopify/Order/1')
    assert.equal(fos.length, 1)
    assert.ok(fos[0].supportedActions.some((a) => a.action === 'CREATE_FULFILLMENT'))

    const id = await shopify.createFulfillment(fos[0].id, {
      company: 'DHL',
      number: '00340000000000000000',
      url: 'https://example.invalid/track',
    })
    assert.match(id, /^gid:\/\/shopify\/Fulfillment\//)

    await shopify.updateTrackingInfo(id, { company: 'DHL', number: '00340000000000000000' })
    await shopify.addOrderTags('gid://shopify/Order/1', ['erp:versendet'])
  })

  test('eine unbekannte Shopify-Operation wirft laut', async () => {
    await assert.rejects(
      () => shopify.shopifyGraphQL('query { productVariants(first: 1) { nodes { id } } }'),
      /kennt die Operation/,
    )
  })

  test('DHL liefert deterministische Labels, Tracking und Retouren', async () => {
    assert.equal(dhl.dhlConfigured(), true)

    const eingabe = {
      product: 'V62KP',
      reference: 'WH/OUT/0001',
      weightG: 800,
      shipper: {
        name: 'Absender', street: 'Weg', houseNumber: '1',
        zip: '10115', city: 'Berlin', country: 'DEU',
      },
      consignee: {
        name: 'Empfänger', street: 'Straße', houseNumber: '2',
        zip: '80331', city: 'München', country: 'DEU',
      },
    }
    const sendung = await dhl.createShipment(eingabe)
    assert.match(sendung.shipmentNumber, /^\d{20}$/)
    assert.ok(sendung.labelBase64, 'der Fake liefert ein Label-PDF')
    // Deterministisch: dieselbe Referenz ergibt dieselbe Nummer.
    assert.equal((await dhl.createShipment(eingabe)).shipmentNumber, sendung.shipmentNumber)

    await dhl.cancelShipment(sendung.shipmentNumber)

    const lage = await dhl.trackShipment(sendung.shipmentNumber)
    assert.equal(lage?.status, 'transit')

    const retoure = await dhl.createReturnLabel(
      { name: 'Kunde', street: 'Gasse', houseNumber: '3', zip: '50667', city: 'Köln', country: 'DEU' },
      'RET/0001',
    )
    assert.match(retoure.shipmentNumber, /^\d{20}$/)
    assert.notEqual(retoure.shipmentNumber, sendung.shipmentNumber)
  })
})

after(() => {
  // Wächter statt Merkzettel: Sobald hier wieder etwas eine Verbindung
  // aufmacht, endet der Prozess nicht mehr — und ein Hänger ohne Ausgabe ist
  // das Teuerste, was eine Testsuite anrichten kann.
  const offen = process.getActiveResourcesInfo().filter((r) => r.includes('TCP'))
  assert.deepEqual(
    offen,
    [],
    `Der Weichen-Test darf keine Verbindung offen lassen (${offen.join(', ')})`,
  )
})
