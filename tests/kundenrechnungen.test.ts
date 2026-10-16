/**
 * Kundenrechnungen (0115) — die reinen Bausteine ohne Datenbank: Felder
 * aus der Shop-Bestellung (Belegzeile mit Variante, Listenpreis vor Rabatt,
 * Zahlungsart, Rechnungsanschrift) und der DATEV-Buchungsstapel.
 * Der Ablauf gegen die Datenbank steht in tests/prozesse/kundenrechnungen.test.ts.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  listenpreisNetto,
  positionsName,
  rechnungsanschrift,
  zahlungsartText,
} from '../src/modules/integrationen/bestellung-felder.ts'
import { ascii, datevBuchungsstapel, erloeskonto, steuergruppen } from '../src/modules/verkauf/datev-export.ts'

const KONTEN = {
  kontenrahmen: 'SKR03' as const,
  debitorenkonto: '10000',
  erloeskonto_19: '8400',
  erloeskonto_7: '8300',
  erloeskonto_0: '8120',
}

describe('Kundenrechnung: Felder aus der Shop-Bestellung', () => {
  test('Belegzeile trägt den Variantennamen, „Default Title" nicht', () => {
    assert.equal(positionsName({ title: 'NATIVE 75', variantTitle: 'Standard / FR4 / Silent Red' }), 'NATIVE 75 - Standard / FR4 / Silent Red')
    assert.equal(positionsName({ title: 'Deskmat', variantTitle: 'Default Title' }), 'Deskmat')
    assert.equal(positionsName({ title: 'Deskmat', variantTitle: null }), 'Deskmat')
  })

  test('Listenpreis netto nur bei echtem Rabatt (Steuer herausgerechnet)', () => {
    const mitRabatt = {
      originalUnitPriceSet: { shopMoney: { amount: '278.00' } },
      discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '272.01' } },
      taxLines: [{ rate: 0.19 }],
    }
    assert.equal(listenpreisNetto(mitRabatt, true), 233.61)
    const ohne = { ...mitRabatt, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '278.00' } } }
    assert.equal(listenpreisNetto(ohne, true), null)
    assert.equal(listenpreisNetto({ ...mitRabatt, discountedUnitPriceAfterAllDiscountsSet: null }, true), null)
  })

  test('Zahlungsart lesbar, Rechnungsanschrift nur wenn der Shop eine liefert', () => {
    assert.equal(zahlungsartText({ paymentGatewayNames: ['shopify_payments'] }), 'Shopify Payments')
    assert.equal(zahlungsartText({ paymentGatewayNames: ['paypal', 'gift_card'] }), 'PayPal, Geschenkgutschein')
    assert.equal(zahlungsartText({ paymentGatewayNames: ['some_gateway'] }), 'Some Gateway')
    assert.equal(zahlungsartText({}), null)
    assert.equal(rechnungsanschrift({ billingAddress: null }), null)
    assert.deepEqual(
      rechnungsanschrift({
        billingAddress: { name: 'Stefan Friedl', company: null, address1: 'Büdinger Straße 7', address2: null, zip: '63688', city: 'Gedern', countryCodeV2: 'DE' },
      }),
      { name: 'Stefan Friedl', company: null, street: 'Büdinger Straße', house: '7', street2: null, zip: '63688', city: 'Gedern', country: 'DE' },
    )
  })
})

describe('DATEV-Buchungsstapel der Kundenbelege', () => {
  test('Konten je Steuersatz, Umlaute ASCII-sicher', () => {
    assert.equal(erloeskonto(KONTEN, 19), '8400')
    assert.equal(erloeskonto(KONTEN, 7), '8300')
    assert.equal(erloeskonto(KONTEN, 0), '8120')
    assert.equal(ascii('Büro Nord GmbH — Straße 1 €'), 'Buero Nord GmbH  Strasse 1 EUR')
  })

  test('Steuergruppen summieren je Satz', () => {
    assert.deepEqual(
      steuergruppen([{ steuersatz: 19, brutto: 236.81 }, { steuersatz: 19, brutto: 4.9 }, { steuersatz: 7, brutto: 10.7 }]),
      [{ steuersatz: 19, brutto: 241.71 }, { steuersatz: 7, brutto: 10.7 }],
    )
  })

  test('Rechnung im Soll, Gutschrift im Haben, Belegdatum DDMM, Beträge mit Komma', () => {
    const csv = datevBuchungsstapel(
      [
        { nummer: 'RE-7812', art: 'rechnung', rechnungsdatum: '2026-10-15', kunde: 'Stefan Friedl', auftrag: '#38730', gruppen: [{ steuersatz: 19, brutto: 279 }] },
        { nummer: 'GU-1416', art: 'gutschrift', rechnungsdatum: '2026-10-16', kunde: 'Bastian T.', kundennummer: '10042', gruppen: [{ steuersatz: 19, brutto: 357.99 }, { steuersatz: 0, brutto: 0 }] },
      ],
      KONTEN,
      { von: '2026-10-01', bis: '2026-10-31' },
      new Date('2026-10-16T08:00:00Z'),
    )
    const zeilen = csv.trim().split('\r\n')
    assert.ok(zeilen[0].startsWith('"EXTF";700;21;"Buchungsstapel"'), zeilen[0])
    assert.ok(zeilen[0].includes('20261001;20261031'), 'Zeitraum im Kopf')
    assert.ok(zeilen[1].startsWith('"Umsatz (ohne Soll/Haben-Kz)";"Soll/Haben-Kennzeichen"'))
    assert.equal(zeilen.length, 4, 'Kopf, Spalten, zwei Buchungen (Gruppe mit 0 € entfällt)')
    assert.ok(zeilen[2].startsWith('279,00;"S";"EUR";;;;"10000";"8400";;"1510";"RE-7812";"#38730";;"Rechnung RE-7812 Stefan Friedl / #38730"'), zeilen[2])
    assert.ok(zeilen[3].startsWith('357,99;"H";"EUR";;;;"10042";"8400";;"1610";"GU-1416"'), zeilen[3])
  })
})
