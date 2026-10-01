/**
 * DHL-Adressprüfung (Shipping API v2, POST /orders?validate=true): Klartext
 * aus validationMessages, Auswertung der Prüfantwort, Ablehnungstext beim
 * Labeldruck und die Regeln des DHL-Fakes — rein, ohne Netz.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ablehnungsText,
  adresseEinzeilig,
  fakeAntwort,
  fakePruefMeldungen,
  feldAus,
  fehlendeAdressfelder,
  meldungLesbar,
  pruefAntwortAuswerten,
  pruefText,
  warnungenLesbar,
} from '../src/modules/versand/dhl-validierung.ts'

describe('DHL-Meldungen in Klartext', () => {
  test('Feldpfade: Empfänger ungenannt, Absender ausgewiesen, Indizes egal', () => {
    assert.deepEqual(feldAus('shipments[0].consignee.postalCode'), { name: 'PLZ', absender: false })
    assert.deepEqual(feldAus('consignee.addressHouse'), { name: 'Hausnummer', absender: false })
    assert.deepEqual(feldAus('$.shipments[0].shipper.city'), { name: 'Ort', absender: true })
    assert.deepEqual(feldAus('shipments[0].details.weight.value'), { name: 'Gewicht', absender: false })
    assert.deepEqual(feldAus(undefined), { name: null, absender: false })
  })

  test('englische DHL-Texte werden zu kurzem Deutsch', () => {
    const fall = (property: string, validationMessage: string) => meldungLesbar({ property, validationMessage })
    assert.equal(fall('consignee.addressHouse', 'The house number is missing.'), 'Hausnummer fehlt')
    assert.equal(fall('consignee', 'Please enter a house number, it must not be empty.'), 'Hausnummer fehlt')
    assert.equal(
      fall('consignee.city', 'The postal code does not match the city.'),
      'PLZ passt nicht zum Ort',
    )
    assert.equal(fall('consignee.postalCode', 'Invalid postal code format.'), 'PLZ ungültig')
    assert.equal(fall('consignee.addressStreet', 'The street could not be found.'), 'Straße nicht gefunden')
    assert.equal(
      fall('consignee', 'The address cannot be routed (no routing code).'),
      'Adresse nicht leitcodierbar — DHL berechnet Nachcodierungs-Entgelt',
    )
    assert.equal(fall('consignee.name1', 'must not be blank'), 'Name fehlt')
    assert.equal(fall('consignee.email', 'size must be between 3 and 80'), 'E-Mail: 3–80 Zeichen erlaubt')
    assert.equal(fall('shipper.postalCode', 'Invalid postal code.'), 'Absender: PLZ ungültig')
  })

  test('deutscher Text bleibt, bekommt den Feldnamen nur, wenn er ihn nicht nennt', () => {
    assert.equal(
      meldungLesbar({ property: 'consignee.postalCode', validationMessage: 'Die Postleitzahl ist ungültig.' }),
      'Die Postleitzahl ist ungültig',
    )
    assert.equal(
      meldungLesbar({ property: 'consignee.postalCode', validationMessage: 'Bitte geben Sie einen gültigen Wert ein.' }),
      'PLZ: Bitte geben Sie einen gültigen Wert ein',
    )
    assert.equal(meldungLesbar({ property: 'consignee.city' }), 'Ort beanstandet')
    assert.equal(meldungLesbar({ validationMessage: 'Something odd happened.' }), 'Something odd happened')
  })
})

describe('Prüfantwort auswerten', () => {
  test('gültig ohne Meldungen = Adresse ok', () => {
    const p = pruefAntwortAuswerten(200, {
      status: { title: 'OK', statusCode: 200 },
      items: [{ sstatus: { title: 'OK', statusCode: 200 }, validationMessages: [] }],
    })
    assert.deepEqual(p, { ok: true, fehler: [], hinweise: [] })
  })

  test('Error = Fehler, Warning = Hinweis, doppelte Meldungen einmal', () => {
    const p = pruefAntwortAuswerten(400, {
      status: { title: 'Bad Request', statusCode: 400, detail: '0 of 1 shipment successfully validated' },
      items: [
        {
          sstatus: { title: 'Bad Request', statusCode: 400 },
          validationMessages: [
            { property: 'consignee.postalCode', validationMessage: 'Invalid postal code.', validationState: 'Error' },
            { property: 'consignee.postalCode', validationMessage: 'Invalid postal code.', validationState: 'Error' },
            { property: 'consignee.addressHouse', validationMessage: 'The house number is missing.', validationState: 'Warning' },
          ],
        },
      ],
    })
    assert.deepEqual(p, { ok: false, fehler: ['PLZ ungültig'], hinweise: ['Hausnummer fehlt'] })
  })

  test('nur Hinweise: nicht ok, aber ohne Fehler (Label ginge)', () => {
    const p = pruefAntwortAuswerten(200, {
      items: [{
        sstatus: { statusCode: 200 },
        validationMessages: [{ property: 'consignee', validationMessage: 'Address could not be encoded.', validationState: 'Warning' }],
      }],
    })
    assert.deepEqual(p, {
      ok: false,
      fehler: [],
      hinweise: ['Adresse nicht leitcodierbar — DHL berechnet Nachcodierungs-Entgelt'],
    })
  })

  test('abgelehnt ohne Einzelmeldung: die Kopfzeile ist der Grund', () => {
    const p = pruefAntwortAuswerten(400, { status: { title: 'Bad Request', detail: 'JSON schema violation' } })
    assert.deepEqual(p, { ok: false, fehler: ['JSON schema violation'], hinweise: [] })
    assert.deepEqual(pruefAntwortAuswerten(400, null)?.fehler, ['DHL lehnt die Sendung ohne Begründung ab'])
  })

  test('Anmeldung, Limit, Störung: keine Aussage über die Adresse', () => {
    for (const status of [401, 403, 429, 500, 503]) assert.equal(pruefAntwortAuswerten(status, null), null)
  })
})

describe('Labeldruck: Ablehnung und Hinweise lesbar', () => {
  test('Ablehnung nennt die Gründe statt „consignee.postalCode: …"', () => {
    const text = ablehnungsText(400, {
      status: { title: 'Bad Request', detail: '0 of 1 shipment successfully printed' },
      items: [{
        sstatus: { statusCode: 400 },
        validationMessages: [
          { property: 'shipments[0].consignee.city', validationMessage: 'The city does not match the postal code.', validationState: 'Error' },
        ],
      }],
    })
    assert.equal(text, 'DHL lehnt die Sendung ab: PLZ passt nicht zum Ort')
  })

  test('technische Ablehnung behält den HTTP-Status und die Kopfzeile', () => {
    assert.equal(
      ablehnungsText(401, { title: 'Unauthorized', detail: 'Invalid token' }),
      'DHL lehnt die Sendung ab (HTTP 401): Invalid token',
    )
  })

  test('weiche Hinweise eines erstellten Labels', () => {
    assert.deepEqual(
      warnungenLesbar({
        shipmentNo: '0034',
        validationMessages: [{ property: 'consignee.addressHouse', validationMessage: 'house number missing', validationState: 'Warning' }],
      }),
      ['Hausnummer fehlt'],
    )
    assert.deepEqual(warnungenLesbar(undefined), [])
  })
})

describe('Ergebnistext und Vorprüfung', () => {
  const adresse = { name: 'Erika Muster', street: 'Hauptstraße', houseNumber: '1', zip: '10115', city: 'Berlin', countryAlpha2: 'DE' }

  test('fehlende Pflichtfelder werden benannt', () => {
    assert.deepEqual(fehlendeAdressfelder(adresse), [])
    assert.deepEqual(fehlendeAdressfelder({ ...adresse, zip: ' ', city: '' }), ['PLZ', 'Ort'])
  })

  test('der Satz sagt ok, Fehler oder Hinweise — und welche Adresse', () => {
    const zeile = adresseEinzeilig(adresse)
    assert.equal(zeile, 'Erika Muster, Hauptstraße 1, 10115 Berlin, DE')
    assert.equal(
      pruefText({ ok: true, fehler: [], hinweise: [] }, zeile),
      'Adresse ok — DHL hat nichts zu beanstanden (Erika Muster, Hauptstraße 1, 10115 Berlin, DE).',
    )
    assert.match(
      pruefText({ ok: false, fehler: ['PLZ ungültig'], hinweise: ['Hausnummer fehlt'] }, zeile),
      /^DHL beanstandet die Adresse: PLZ ungültig — so lehnt DHL das Label ab \(.*\)\. Außerdem: Hausnummer fehlt\.$/,
    )
    assert.match(
      pruefText({ ok: false, fehler: [], hinweise: ['Hausnummer fehlt'] }, zeile),
      /^DHL hat Hinweise zur Adresse: Hausnummer fehlt — das Label ginge durch/,
    )
  })
})

describe('DHL-Fake (DHL_FAKE=1)', () => {
  test('deutsche PLZ mit fünf Ziffern und Hausnummer: keine Beanstandung', () => {
    const { status, json } = fakeAntwort(fakePruefMeldungen({ houseNumber: '1', zip: '10115', country: 'DEU' }))
    assert.equal(status, 200)
    assert.deepEqual(pruefAntwortAuswerten(status, json), { ok: true, fehler: [], hinweise: [] })
  })

  test('PLZ falsch = Fehler (Label abgelehnt), Hausnummer fehlt = Hinweis', () => {
    const { status, json } = fakeAntwort(fakePruefMeldungen({ houseNumber: ' ', zip: '1011', country: 'DEU' }))
    assert.equal(status, 400)
    const p = pruefAntwortAuswerten(status, json)
    assert.deepEqual(p?.fehler, ['PLZ „1011" ist ungültig — in Deutschland hat die PLZ fünf Ziffern'])
    assert.deepEqual(p?.hinweise, ['Hausnummer fehlt — so ist die Adresse nicht leitcodierbar'])
    assert.equal(
      ablehnungsText(status, json),
      'DHL lehnt die Sendung ab: PLZ „1011" ist ungültig — in Deutschland hat die PLZ fünf Ziffern · ' +
        'Hausnummer fehlt — so ist die Adresse nicht leitcodierbar',
    )
  })

  test('Ausland: der Fake prüft nur deutsche Adressen', () => {
    assert.deepEqual(fakePruefMeldungen({ houseNumber: '', zip: '1010', country: 'AUT' }), [])
  })
})
