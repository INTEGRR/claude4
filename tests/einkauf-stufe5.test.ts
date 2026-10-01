/**
 * Einkauf, Stufe 5 (0108) — die reine Logik ohne Datenbank: Verteilung auf
 * die Wareneingänge (Summe exakt, Rundungsrest auf den letzten), Zollzeilen
 * aus dem Bescheid, Text der täglichen Zusammenfassung (gegliedert nach
 * Einkäufer), Namen der Pflichtdokumente je Sprache, die vorbereitete
 * DATEV-Beleg-Mail und die Formular-Adapter der neuen Aktionen.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { type CockpitEintrag, cockpitGruppieren, digestText } from '../src/modules/einkauf/cockpit.ts'
import { DATEV_MAX_BYTES, datevBelegMail, datevDateiname } from '../src/modules/einkauf/datev.ts'
import { dokumentName, dokumenteListe } from '../src/modules/einkauf/pflichtdokumente.ts'
import {
  bestellnummernLesen,
  kostenartVerteilbar,
  verteilSchluessel,
  verteilen,
  zollsatz,
  zollzeilenLesen,
} from '../src/modules/einkauf/sendungen.ts'
import { aktionPruefen } from '../src/modules/prozesse/torwaechter.ts'

const ID = '11111111-2222-4333-8444-555555555555'
const summe = (a: number[]) => Math.round(a.reduce((s, x) => s + x, 0) * 100) / 100

describe('Verteilung auf die Wareneingänge', () => {
  test('anteilig auf den Cent, Rundungsrest auf den letzten Eingang', () => {
    assert.deepEqual(verteilen(100, [1, 1, 1]), [33.33, 33.33, 33.34])
    assert.deepEqual(verteilen(333.33, [5, 20, 5]), [55.56, 222.22, 55.55])
    for (const [betrag, basen] of [
      [1000, [400, 600]],
      [0.01, [1, 1, 1]],
      [12345.67, [3, 7, 11, 13, 17]],
      [99.99, [0.1, 0.2, 0.3]],
    ] as [number, number[]][]) {
      const anteile = verteilen(betrag, basen)
      assert.equal(summe(anteile), betrag, `Summe für ${betrag}`)
      assert.ok(anteile.every((a) => a >= 0), 'kein Anteil negativ')
    }
  })

  test('ohne Basis gleichmäßig, ein Eingang bekommt alles, keiner nichts', () => {
    assert.deepEqual(verteilen(10, [0, 0]), [5, 5])
    assert.deepEqual(verteilen(42.5, [7]), [42.5])
    assert.deepEqual(verteilen(10, []), [])
  })

  test('Grenzfall winziger Anteile: der Rest bliebe negativ → kumulativ, Summe exakt', () => {
    // Neun Anteile runden auf, der letzte (fast 0) würde negativ.
    const basen = [...Array(9).fill(1.0006), 0.0001]
    const anteile = verteilen(0.09, basen)
    assert.equal(summe(anteile), 0.09)
    assert.ok(anteile.every((a) => a >= 0))
  })

  test('Schlüssel: Fracht nach Gewicht nur mit vollständigen Gewichten, sonst Wert; EUSt nie', () => {
    assert.equal(verteilSchluessel('fracht', true), 'gewicht')
    assert.equal(verteilSchluessel('fracht', false), 'wert')
    assert.equal(verteilSchluessel('zoll', true), 'wert')
    assert.equal(kostenartVerteilbar('eust'), false)
    assert.equal(kostenartVerteilbar('versicherung'), true)
  })
})

describe('Zollbescheid und Bestellnummern aus Text', () => {
  test('HS-Code mit Leerzeichen/Punkten, deutsche und englische Zahlen, Excel-Tabs', () => {
    const { zeilen, fehler } = zollzeilenLesen(
      ['# Bescheid 2026-10-01', '8534 00 90; 800,00; 0; 152,00', '8473.30.20\t1.200,50\t30,01\t233,80', '3926|99.90|6.5'].join('\n'),
    )
    assert.deepEqual(fehler, [])
    assert.deepEqual(zeilen, [
      { hs_code: '85340090', zollwert_eur: 800, zoll_eur: 0, eust_eur: 152 },
      { hs_code: '84733020', zollwert_eur: 1200.5, zoll_eur: 30.01, eust_eur: 233.8 },
      { hs_code: '3926', zollwert_eur: 99.9, zoll_eur: 6.5, eust_eur: 0 },
    ])
    assert.equal(zollsatz(400, 10), 2.5)
    assert.equal(zollsatz(0, 10), null)
  })

  test('unlesbare Zeilen werden genannt, nicht verschluckt', () => {
    const { zeilen, fehler } = zollzeilenLesen('Kunststoffwaren; 100; 6\n8473; 100\n8473; viel; 1')
    assert.equal(zeilen.length, 0)
    assert.equal(fehler.length, 3)
    assert.match(fehler[0], /Zeile 1: „Kunststoffwaren; 100; 6" — HS-Code/)
    assert.match(fehler[1], /erwartet „HS-Code; Zollwert; Zoll; EUSt"/)
    assert.match(fehler[2], /Beträge nicht lesbar/)
  })

  test('Bestellnummern aus Freitext, ohne Doppel', () => {
    assert.deepEqual(bestellnummernLesen('P00042, P00043;\nP00042  P00044'), ['P00042', 'P00043', 'P00044'])
  })
})

describe('Pflichtdokumente: Namen je Sprache', () => {
  test('Bestellung und Sendung, Deutsch/Englisch/Chinesisch', () => {
    assert.equal(dokumentName('ci', 'purchase_order', 'zh'), '商业发票 (CI)')
    assert.equal(dokumentName('rechnung', 'purchase_order', 'en'), 'Final invoice')
    assert.equal(dokumentName('rechnung', 'eingangs_sendung', 'de'), 'Frachtrechnung (Spediteur)')
    assert.equal(dokumenteListe(['ci', 'packing_list', 'ci'], 'purchase_order', 'de'), '- Commercial Invoice (CI)\n- Packliste (Packing List)')
  })
})

const eintrag = (e: Partial<CockpitEintrag> & Pick<CockpitEintrag, 'kategorie' | 'titel'>): CockpitEintrag => ({
  modell: 'purchase_order',
  record_id: ID,
  detail: null,
  link: `/einkauf/${ID}`,
  faellig_am: null,
  zustaendig_id: null,
  partner_id: null,
  ...e,
})

describe('Tägliche Zusammenfassung (Telegram)', () => {
  const TINO = 'aaaaaaaa-0000-4000-8000-000000000001'
  const PATRICK = 'aaaaaaaa-0000-4000-8000-000000000002'
  const namen = { [TINO]: 'Tino', [PATRICK]: 'Patrick' }

  test('gegliedert nach Einkäufer (alphabetisch), „Ohne Zuständigen" zuletzt, Lage nicht in der Nachricht', () => {
    const text = digestText(
      [
        eintrag({ kategorie: 'dokumente', titel: 'P00042: Commercial Invoice fehlt', zustaendig_id: TINO, faellig_am: '2026-09-29' }),
        eintrag({ kategorie: 'ueberfaellig', titel: 'Preis nachverhandeln', zustaendig_id: PATRICK }),
        eintrag({ kategorie: 'eta_ueberfaellig', titel: 'P00043: Liefertermin überschritten', zustaendig_id: TINO }),
        eintrag({ kategorie: 'unzugeordnet', titel: 'Re: quotation', modell: 'mail_thread' }),
        eintrag({ kategorie: 'unzugeordnet', titel: 'Fwd: PI', modell: 'mail_thread', zustaendig_id: TINO }),
        eintrag({ kategorie: 'sendungen', titel: 'ES/00001', zustaendig_id: TINO }),
        eintrag({ kategorie: 'rechnungen', titel: 'P00050: Lieferantenrechnung fehlt' }),
      ],
      namen,
      { datum: '2026-10-01' },
    )!
    assert.ok(text.startsWith('📋 <b>Einkauf — 01.10.2026</b>'))
    const patrick = text.indexOf('<b>Patrick</b> (1)')
    const tino = text.indexOf('<b>Tino</b> (2)')
    const ohne = text.indexOf('<b>Ohne Zuständigen</b> (3)')
    assert.ok(patrick > 0 && tino > patrick && ohne > tino, text)
    // Reihenfolge der Kategorien: überfällige ETA vor Dokumenten.
    assert.ok(text.indexOf('Überfällige ETA (1)') < text.indexOf('Fehlende Dokumente (1)'))
    assert.match(text, /– P00042: Commercial Invoice fehlt · 29\.09\.2026/)
    // Nicht zugeordnete Mails gehören niemandem und stehen nur als Zahl da.
    assert.match(text, /Nicht zugeordnete Mails: 2/)
    assert.doesNotMatch(text, /ES\/00001/, 'laufende Sendungen sind Lage, kein Auftrag')
  })

  test('nichts zu tun → keine Nachricht; HTML wird maskiert, Links mit Basis-URL', () => {
    assert.equal(digestText([eintrag({ kategorie: 'muster', titel: 'EP/00001 · Runde 1' })], namen, { datum: '2026-10-01' }), null)
    const text = digestText(
      [eintrag({ kategorie: 'heute', titel: 'Preis <USD> & Staffel', zustaendig_id: TINO })],
      namen,
      { datum: '2026-10-01', basisUrl: 'https://erp.example.com/' },
    )!
    assert.match(text, /<a href="https:\/\/erp\.example\.com\/einkauf\/[0-9a-f-]+">Preis &lt;USD&gt; &amp; Staffel<\/a>/)
    assert.match(text, /<a href="https:\/\/erp\.example\.com\/einkauf\/cockpit">Cockpit öffnen<\/a>/)
  })

  test('je Kategorie fünf Einträge, dann „… und N weitere"; lange Texte an Zeilengrenzen gekürzt', () => {
    const viele = Array.from({ length: 8 }, (_, i) => eintrag({ kategorie: 'dokumente', titel: `P0010${i}: PI fehlt`, zustaendig_id: TINO }))
    const text = digestText(viele, namen, { datum: '2026-10-01' })!
    assert.equal((text.match(/– P0010/g) ?? []).length, 5)
    assert.match(text, /… und 3 weitere/)
    const lang = digestText(viele, namen, { datum: '2026-10-01', maxZeichen: 120 })!
    assert.ok(lang.length <= 120)
    assert.match(lang, /gekürzt — der Rest steht im Cockpit/)
    assert.equal((lang.match(/<b>/g) ?? []).length, (lang.match(/<\/b>/g) ?? []).length, 'kein halbes Tag')
  })

  test('Gruppierung folgt der festen Reihenfolge und lässt Leeres weg', () => {
    const g = cockpitGruppieren([
      eintrag({ kategorie: 'muster', titel: 'm' }),
      eintrag({ kategorie: 'ueberfaellig', titel: 'u' }),
      eintrag({ kategorie: 'muster', titel: 'm2' }),
    ])
    assert.deepEqual(g.map((x) => [x.kategorie, x.eintraege.length]), [['ueberfaellig', 1], ['muster', 2]])
  })
})

describe('DATEV-Beleg-Mail (vorbereitet, nicht verdrahtet)', () => {
  const beleg = {
    rechnungsnummer: 'BILL/2026/0042',
    lieferant: 'Kühne + Nagel <Hamburg>',
    referenz: 'KN-998877',
    rechnungsdatum: '2026-09-30',
    dateiname: 'Rechnung: KN/998877.pdf',
    inhaltBase64: Buffer.from('%PDF-1.4 test').toString('base64'),
  }

  test('ein Beleg je Mail, Betreff mit Lieferant und Nummer, Anhang mit sicherem Dateinamen', () => {
    const m = datevBelegMail(' belege@datev.example ', beleg)
    assert.equal(m.to, 'belege@datev.example')
    assert.equal(m.subject, 'Eingangsrechnung Kühne + Nagel <Hamburg> BILL/2026/0042 (KN-998877)')
    assert.equal(m.attachments.length, 1)
    assert.equal(m.attachments[0].filename, 'Rechnung- KN-998877.pdf')
    assert.equal(m.attachments[0].content, beleg.inhaltBase64)
    assert.match(m.html, /Kühne \+ Nagel &lt;Hamburg&gt;/)
    assert.match(m.html, /vom 30\.09\.2026/)
  })

  test('ohne Adresse, leer oder zu groß: Fehler vor dem (späteren) Versand', () => {
    assert.throws(() => datevBelegMail('', beleg), /Adresse fehlt/)
    assert.throws(() => datevBelegMail('a@b.de', { ...beleg, inhaltBase64: '' }), /leer/)
    assert.throws(() => datevBelegMail('a@b.de', { ...beleg, groesse: DATEV_MAX_BYTES + 1 }), /größer als 20 MB/)
    assert.equal(datevDateiname('\u0007/'), '-')
    assert.equal(datevDateiname('   '), 'Beleg.pdf')
  })
})

describe('Formular-Adapter der neuen Aktionen', () => {
  test('Sendung anlegen: Häkchen und eingetippte Nummern zusammen, Zahlen deutsch', () => {
    const fd = new FormData()
    fd.append('bestellung', ID)
    fd.set('bestellnummern', 'P00042, P00043')
    fd.set('modus', 'luft')
    fd.set('gewicht_kg', '1.234,5')
    fd.set('packstuecke', '12')
    const { werte } = aktionPruefen('einkauf.sendung_anlegen', { formData: fd })
    assert.deepEqual(werte.bestellungen, [ID, 'P00042', 'P00043'])
    assert.equal(werte.modus, 'luft')
    assert.equal(werte.gewicht_kg, 1234.5)
    assert.equal(werte.packstuecke, 12)
  })

  test('Kosten erfassen: Betrag mit Komma, Schätzung als Häkchen, Währung groß', () => {
    const fd = new FormData()
    fd.set('art', 'fracht')
    fd.set('betrag', '1.250,40')
    fd.set('waehrung', 'usd')
    fd.set('schaetzung', 'on')
    const { werte } = aktionPruefen('einkauf.sendung_kosten_erfassen', { recordId: ID, formData: fd })
    assert.deepEqual({ art: werte.art, betrag: werte.betrag, waehrung: werte.waehrung, schaetzung: werte.schaetzung }, {
      art: 'fracht',
      betrag: 1250.4,
      waehrung: 'USD',
      schaetzung: true,
    })
    fd.set('betrag', 'viel')
    assert.throws(() => aktionPruefen('einkauf.sendung_kosten_erfassen', { recordId: ID, formData: fd }), /betrag/)
  })

  test('Zollbescheid: Zeilen aus dem Textfeld; eine kaputte Zeile macht die Eingabe rot und wird genannt', () => {
    const fd = new FormData()
    fd.set('zeilen', '8534 00 90; 800; 0; 152\n8473 30 20; 400; 10; 77,90')
    const { werte } = aktionPruefen('einkauf.sendung_zoll_erfassen', { recordId: ID, formData: fd })
    assert.equal((werte.zeilen as unknown[]).length, 2)
    fd.set('zeilen', '8534; 800; 0; 152\nPlatinen; 100; 1')
    assert.throws(() => aktionPruefen('einkauf.sendung_zoll_erfassen', { recordId: ID, formData: fd }), /Zeile 2: „Platinen; 100; 1"/)
    fd.set('zeilen', '')
    assert.throws(() => aktionPruefen('einkauf.sendung_zoll_erfassen', { recordId: ID, formData: fd }), /mindestens eine Zollzeile/)
  })

  test('Stornieren braucht einen Grund; Nachfragen nur für Bestellung oder Sendung', () => {
    assert.throws(() => aktionPruefen('einkauf.sendung_stornieren', { recordId: ID, parameter: { grund: '' } }), /Grund/)
    assert.throws(
      () => aktionPruefen('einkauf.pflichtdokumente_nachfragen', { parameter: { modell: 'vendor_bill', record_id: ID } }),
      /modell/,
    )
    assert.throws(() => aktionPruefen('einkauf.einstand_vorschlag_uebernehmen', { parameter: { art: 'eust', schluessel: 'see' } }), /art/)
  })
})
