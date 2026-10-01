/**
 * Einkauf, Stufe 4 (0107) — die reine Logik ohne Datenbank: Preisliste aus
 * Text, Lage eines Vertrags, Revisionsfolge der Muster-Runden, Tracking-
 * Links, Lebensdauer und Buchbarkeit von Werkzeugschüssen, dazu die
 * Formular-Adapter der neuen Aktionen.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { naechsteRevision, rundeText, trackingLink } from '../src/modules/einkauf/bemusterung.ts'
import { preislisteLesen, vertragsLage } from '../src/modules/einkauf/lieferantenvertraege.ts'
import { lebensdauer, schussBuchbar } from '../src/modules/einkauf/werkzeuge.ts'
import { aktionPruefen } from '../src/modules/prozesse/torwaechter.ts'

const ID = '11111111-2222-4333-8444-555555555555'

describe('Preisliste aus Text', () => {
  test('Artikel / Menge: Preis, ohne Menge ab 1, Excel-Spalten, Kommentare', () => {
    const { zeilen, fehler } = preislisteLesen(
      [
        '# Preisliste Q4',
        'KC-PBT-01 / 500: 7,20',
        'KC-PBT-01 / ab 1.000 Stk = 6.85 USD',
        'KC-PULL: 0,35',
        'FOAM-60\t2000\t0,0034',
        'FOAM-65;1000;0.12',
        '',
      ].join('\n'),
    )
    assert.deepEqual(fehler, [])
    assert.deepEqual(zeilen, [
      { produkt: 'KC-PBT-01', ab_menge: 500, preis: 7.2 },
      { produkt: 'KC-PBT-01', ab_menge: 1000, preis: 6.85 },
      { produkt: 'KC-PULL', ab_menge: 1, preis: 0.35 },
      { produkt: 'FOAM-60', ab_menge: 2000, preis: 0.0034 },
      { produkt: 'FOAM-65', ab_menge: 1000, preis: 0.12 },
    ])
  })

  test('Schrägstriche in der SKU und doppelte Paare: die letzte Zeile gilt', () => {
    const { zeilen } = preislisteLesen('AB/CD/01 / 100: 1,50\nab/cd/01 / 100: 1,40')
    assert.deepEqual(zeilen, [{ produkt: 'ab/cd/01', ab_menge: 100, preis: 1.4 }])
  })

  test('unlesbare Zeilen werden gemeldet, nicht verschluckt', () => {
    const { zeilen, fehler } = preislisteLesen('KC-PULL: 0,35\nnur Text\nX / 0: 1\nY;1;2;3')
    assert.equal(zeilen.length, 1)
    assert.equal(fehler.length, 3)
    assert.match(fehler[0], /„nur Text" ist keine Preiszeile/)
  })
})

describe('Lage eines Lieferantenvertrags', () => {
  const heute = '2026-10-01'
  const lage = (v: Partial<Parameters<typeof vertragsLage>[0]>) =>
    vertragsLage({ status: 'aktiv', ende: null, stichtag: null, erinnerung_tage: 30, ...v }, heute)

  test('unbefristet, läuft, Frist läuft (ab Stichtag − Vorlauf), abgelaufen', () => {
    assert.equal(lage({}), 'aktiv')
    assert.equal(lage({ ende: '2027-06-30', stichtag: '2027-03-30' }), 'aktiv')
    assert.equal(lage({ ende: '2027-01-31', stichtag: '2026-10-31' }), 'faellig', '30 Tage vor dem Stichtag')
    assert.equal(lage({ ende: '2027-01-31', stichtag: '2026-11-01' }), 'aktiv', '31 Tage davor noch nicht')
    assert.equal(lage({ ende: '2027-01-31', stichtag: '2026-11-01', erinnerung_tage: 60 }), 'faellig')
    assert.equal(lage({ ende: '2026-09-30', stichtag: '2026-09-30' }), 'abgelaufen')
  })

  test('gekündigt bis zum Ende, danach beendet; beendet bleibt beendet', () => {
    assert.equal(lage({ status: 'gekuendigt', ende: '2026-12-31' }), 'gekuendigt')
    assert.equal(lage({ status: 'gekuendigt', ende: '2026-09-30' }), 'beendet')
    assert.equal(lage({ status: 'beendet', ende: '2027-12-31' }), 'beendet')
  })
})

describe('Muster-Runden', () => {
  test('Revisionsfolge A → B, 1 → 2, sonst offen', () => {
    assert.equal(naechsteRevision('A'), 'B')
    assert.equal(naechsteRevision('c'), 'd')
    assert.equal(naechsteRevision('2'), '3')
    assert.equal(naechsteRevision('Z'), null)
    assert.equal(naechsteRevision('V1.2'), null)
    assert.equal(naechsteRevision(null), null)
  })

  test('Rundentext und Tracking-Link', () => {
    assert.equal(rundeText({ runde: 2, revision: 'B', bezeichnung: 'Farbmuster' }), 'Runde 2 · Rev. B · Farbmuster')
    assert.equal(rundeText({ runde: 1 }), 'Runde 1')
    assert.equal(trackingLink(' https://t.17track.net/de#nums=SF1 '), 'https://t.17track.net/de#nums=SF1')
    assert.equal(trackingLink('SF1234567890'), null)
  })
})

describe('Werkzeuge', () => {
  test('Lebensdauer: Anteil abgerundet, ab 90 % bald, ab 100 % über', () => {
    assert.deepEqual(lebensdauer(8999, 10000), { pct: 89, stufe: 'ok' })
    assert.deepEqual(lebensdauer(9000, 10000), { pct: 90, stufe: 'bald' })
    assert.deepEqual(lebensdauer(10500, 10000), { pct: 105, stufe: 'ueber' })
    assert.deepEqual(lebensdauer(500, null), { pct: null, stufe: 'unbekannt' })
  })

  test('Schüsse: positiv nur in Betrieb oder Auftrag, Korrektur nie unter 0', () => {
    assert.equal(schussBuchbar('aktiv', 100, 50), null)
    assert.equal(schussBuchbar('in_auftrag', 0, 30), null, 'T0-Bemusterung vor der Freigabe')
    assert.match(schussBuchbar('gesperrt', 100, 10)!, /gesperrt/)
    assert.equal(schussBuchbar('gesperrt', 100, -10), null)
    assert.match(schussBuchbar('aktiv', 100, -101)!, /unter 0/)
    assert.match(schussBuchbar('aktiv', 100, 0)!, /ungleich 0/)
  })
})

describe('Formular-Adapter der Stufe 4', () => {
  test('Projekt: Musterpflicht als Checkbox, beim Bearbeiten nur mit Markerfeld', () => {
    const neu = new FormData()
    neu.set('titel', 'Gehäuse')
    neu.set('muster_pflicht', 'on')
    assert.equal(aktionPruefen('einkauf.projekt_anlegen', { formData: neu }).werte.muster_pflicht, true)

    const ohneMarker = new FormData()
    ohneMarker.set('titel', 'Gehäuse')
    assert.equal(aktionPruefen('einkauf.projekt_aendern', { formData: ohneMarker, recordId: ID }).werte.muster_pflicht, undefined)
    const abgewaehlt = new FormData()
    abgewaehlt.set('muster_pflicht_feld', '1')
    assert.equal(aktionPruefen('einkauf.projekt_aendern', { formData: abgewaehlt, recordId: ID }).werte.muster_pflicht, false)
  })

  test('Bewerten: Befund ist Pflicht beim Nachbessern, Golden Sample ist Standard', () => {
    assert.throws(() => aktionPruefen('einkauf.muster_bewerten', { recordId: ID, parameter: { ergebnis: 'ablehnen' } }), /Befund/)
    const { werte } = aktionPruefen('einkauf.muster_bewerten', { recordId: ID, parameter: { ergebnis: 'freigeben' } })
    assert.equal(werte.golden, true)
    const fd = new FormData()
    fd.set('ergebnis', 'freigeben')
    fd.set('golden_feld', '1')
    assert.equal(aktionPruefen('einkauf.muster_bewerten', { recordId: ID, formData: fd }).werte.golden, false, 'abgehakt = kein Golden Sample')
  })

  test('Werkzeug: Lieferant oder Bestellzeile, Grund beim Sperren, Schüsse ganzzahlig', () => {
    assert.throws(() => aktionPruefen('einkauf.werkzeug_anlegen', { parameter: { bezeichnung: 'Form' } }), /Lieferanten/)
    assert.throws(() => aktionPruefen('einkauf.werkzeug_status_setzen', { recordId: ID, parameter: { status: 'gesperrt' } }), /Grund/)
    const fd = new FormData()
    fd.set('anzahl', '1.500')
    assert.equal(aktionPruefen('einkauf.werkzeug_schuss_buchen', { recordId: ID, formData: fd }).werte.anzahl, 1500)
    fd.set('anzahl', '12,5')
    assert.throws(() => aktionPruefen('einkauf.werkzeug_schuss_buchen', { recordId: ID, formData: fd }), /ganze Zahl/)
  })

  test('Vertrag: Ende nicht vor Beginn; leeres Feld löscht beim Bearbeiten die Verlängerung', () => {
    assert.throws(
      () =>
        aktionPruefen('einkauf.lieferantenvertrag_anlegen', {
          parameter: { partner_id: ID, art: 'nda', titel: 'NDA', gueltig_von: '2026-10-01', gueltig_bis: '2026-09-01' },
        }),
      /Ende liegt vor dem Beginn/,
    )
    const fd = new FormData()
    fd.set('verlaengerung_monate', '')
    fd.set('gueltig_bis', '')
    const { werte } = aktionPruefen('einkauf.lieferantenvertrag_aendern', { recordId: ID, formData: fd })
    assert.equal(werte.verlaengerung_monate, '')
    assert.equal(werte.gueltig_bis, '')
    assert.throws(() => aktionPruefen('einkauf.preisliste_uebernehmen', { recordId: ID, parameter: { text: '  ' } }), /Preiszeile/)
  })
})
