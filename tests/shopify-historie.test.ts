/**
 * Shopify-Historie und Netto-Preise (0089): CSV-Parser nach RFC 4180, die
 * Zerlegung eines Bestellexports in Bestellungen und die Netto-Rechnung
 * (Steuer im Preis oder nicht, Rabatte anteilig, Versand getrennt).
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  bestellungenAusExport,
  csvLesen,
  exportDatum,
  vorschau,
  wirdUebernommen,
} from '../src/modules/integrationen/shopify-csv.ts'
import {
  exportPositionenNetto,
  positionNetto,
  satzAusName,
  steuernInklusiveAus,
} from '../src/modules/integrationen/shopify-preise.ts'

const KOPF = [
  'Name', 'Email', 'Financial Status', 'Fulfillment Status', 'Currency', 'Subtotal', 'Shipping',
  'Taxes', 'Total', 'Discount Amount', 'Created at', 'Lineitem quantity', 'Lineitem name',
  'Lineitem price', 'Lineitem sku', 'Lineitem discount', 'Billing Name', 'Shipping Name',
  'Shipping Country', 'Cancelled at', 'Id', 'Tax 1 Name',
].join(',')

/** Eine Exportzeile aus Feldern (Reihenfolge wie KOPF), mit CSV-Quoting. */
function zeile(f: Record<string, string | number>): string {
  const spalten = KOPF.split(',')
  return spalten
    .map((k) => {
      const v = String(f[k] ?? '')
      return /[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v
    })
    .join(',')
}

const EXPORT = [
  KOPF,
  // #1001: Preise inkl. 19 %, 10 € Auftragsrabatt, 5,95 € Versand.
  zeile({
    Name: '#1001', Email: 'anna@example.com', 'Financial Status': 'paid',
    'Fulfillment Status': 'fulfilled', Currency: 'EUR', Subtotal: '132.80', Shipping: '5.95',
    Taxes: '22.15', Total: '138.75', 'Discount Amount': '10.00',
    'Created at': '2023-11-24 14:05:22 +0100', 'Lineitem quantity': 1,
    'Lineitem name': 'NATIVE 75 "Nexus White"', 'Lineitem price': '119.00', 'Lineitem sku': 'KB-1',
    'Lineitem discount': '0.00', 'Billing Name': 'Anna Alt', 'Shipping Country': 'DE',
    Id: '5550001', 'Tax 1 Name': 'DE MwSt 19%',
  }),
  zeile({
    Name: '#1001', 'Created at': '2023-11-24 14:05:22 +0100', 'Lineitem quantity': 2,
    'Lineitem name': 'Keycaps\nObsidian', 'Lineitem price': '11.90', 'Lineitem sku': 'KC-1',
    'Lineitem discount': '0.00',
  }),
  // #1002: Netto-Shop (Steuer obendrauf).
  zeile({
    Name: '#1002', Email: 'firma@example.com', 'Financial Status': 'paid',
    'Fulfillment Status': 'fulfilled', Currency: 'EUR', Subtotal: '100.00', Shipping: '0.00',
    Taxes: '19.00', Total: '119.00', 'Created at': '2024-02-01 09:00:00 +0100',
    'Lineitem quantity': 2, 'Lineitem name': 'NATIVE 75', 'Lineitem price': '50.00',
    'Lineitem sku': 'KB-1', 'Billing Name': 'Firma GmbH', 'Shipping Country': 'AT',
    Id: '5550002', 'Tax 1 Name': 'MwSt 19%',
  }),
  // #1003: storniert.
  zeile({
    Name: '#1003', Email: 'weg@example.com', 'Financial Status': 'refunded',
    'Fulfillment Status': 'unfulfilled', Currency: 'EUR', Subtotal: '20.00', Shipping: '0',
    Taxes: '3.19', Total: '20.00', 'Created at': '2024-03-01 10:00:00 +0100',
    'Lineitem quantity': 1, 'Lineitem name': 'Deskmat', 'Lineitem price': '20.00',
    'Lineitem sku': 'DM-1', 'Cancelled at': '2024-03-02 10:00:00 +0100', Id: '5550003',
    'Tax 1 Name': 'DE MwSt 19%',
  }),
].join('\r\n')

describe('CSV nach RFC 4180', () => {
  test('Anführungszeichen, doppelte Anführungszeichen, Zeilenumbruch im Feld, BOM, CRLF', () => {
    const z = csvLesen('﻿a,b,c\r\n"x, y","sagt ""hallo""","zwei\nZeilen"\r\n\r\n')
    assert.deepEqual(z, [
      ['a', 'b', 'c'],
      ['x, y', 'sagt "hallo"', 'zwei\nZeilen'],
    ])
  })
})

describe('Netto-Rechnung', () => {
  test('Steuersatz aus dem Namen, Brutto/Netto aus den Summen', () => {
    assert.equal(satzAusName('DE MwSt 19%'), 0.19)
    assert.equal(satzAusName('VAT 7,0 %'), 0.07)
    assert.equal(satzAusName('ohne'), null)
    assert.equal(steuernInklusiveAus({ zwischensumme: 132.8, versand: 5.95, steuern: 22.15, gesamt: 138.75 }), true)
    assert.equal(steuernInklusiveAus({ zwischensumme: 100, versand: 0, steuern: 19, gesamt: 119 }), false)
  })

  test('Auftragsrabatt anteilig, Steuer herausgerechnet', () => {
    const preise = exportPositionenNetto(
      [
        { menge: 1, preis: 119, rabatt: 0 },
        { menge: 2, preis: 11.9, rabatt: 0 },
      ],
      132.8,
      0.19,
      true,
    )
    assert.deepEqual(preise, [93, 9.3])
  })

  test('API-Position: nach Rabatt und netto; ohne neue Felder altes Verhalten', () => {
    assert.deepEqual(
      positionNetto({ menge: 1, listenpreis: 119, nachRabatt: 107.1, satz: 0.19 }, true),
      { stueckNetto: 90, steuersatz: 19 },
    )
    assert.deepEqual(
      positionNetto({ menge: 1, listenpreis: 100, nachRabatt: 90, satz: 0.19 }, false),
      { stueckNetto: 90, steuersatz: 19 },
    )
    assert.deepEqual(positionNetto({ menge: 1, listenpreis: 29.9 }, undefined), {
      stueckNetto: 29.9,
      steuersatz: 19,
    })
  })
})

describe('Shopify-Bestellexport', () => {
  const { bestellungen, fehlendeSpalten } = bestellungenAusExport(EXPORT)

  test('Zeilen werden je Bestellung gruppiert, Bestellfelder aus der ersten Zeile', () => {
    assert.deepEqual(fehlendeSpalten, [])
    assert.deepEqual(bestellungen.map((b) => b.name), ['#1001', '#1002', '#1003'])
    const [a] = bestellungen
    assert.equal(a.id, '5550001')
    assert.equal(a.email, 'anna@example.com')
    assert.equal(a.kunde, 'Anna Alt')
    assert.equal(a.land, 'DE')
    assert.equal(a.status, 'erfuellt')
    assert.equal(a.datum, '2023-11-24T14:05:22+01:00')
    assert.equal(a.positionen[1].name, 'Keycaps\nObsidian')
    assert.equal(a.positionen[0].name, 'NATIVE 75 "Nexus White"')
  })

  test('Netto-Preise, Steuersatz und Versand netto', () => {
    const [a, b, c] = bestellungen
    assert.deepEqual(a.positionen.map((p) => p.stueckNetto), [93, 9.3])
    assert.equal(a.steuersatz, 19)
    assert.equal(a.versandNetto, 5)
    assert.deepEqual(b.positionen.map((p) => p.stueckNetto), [50])
    assert.equal(b.land, 'AT')
    assert.equal(c.status, 'storniert')
  })

  test('offene Bestellungen der letzten 60 Tage gehören dem Live-Import', () => {
    const jetzt = new Date('2026-09-29T12:00:00Z')
    const offen = { ...bestellungen[0], status: 'offen' as const }
    assert.equal(wirdUebernommen({ ...offen, datum: '2026-09-20T10:00:00+02:00' }, jetzt), false)
    assert.equal(wirdUebernommen({ ...offen, datum: '2026-01-20T10:00:00+01:00' }, jetzt), true)
    assert.equal(wirdUebernommen(bestellungen[2], jetzt), true, 'storniert: immer')
  })

  test('Vorschau: Zeitraum, Umsatz ohne Stornos, SKUs', () => {
    const v = vorschau(bestellungen, new Date('2026-09-29T12:00:00Z'))
    assert.equal(v.uebernommen, 3)
    assert.equal(v.storniert, 1)
    assert.equal(v.umsatzNetto, 93 + 18.6 + 100)
    assert.deepEqual(v.skus.sort(), ['DM-1', 'KB-1', 'KC-1'])
    assert.equal(v.von, '2023-11-24T14:05:22+01:00')
  })

  test('kein Bestellexport: fehlende Spalten werden genannt', () => {
    assert.deepEqual(bestellungenAusExport('Handle,Title\nx,y').fehlendeSpalten, [
      'Name', 'Created at', 'Lineitem quantity', 'Lineitem name', 'Lineitem price',
    ])
    assert.equal(exportDatum('2024-05-03 12:34 +0200'), '2024-05-03T12:34:00+02:00')
  })
})
