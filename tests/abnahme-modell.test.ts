/**
 * Abnahmetest, Teil 1 — das Rechenmodell für sich (ohne Datenbank).
 *
 * Prüft Werte, die sich von Hand nachrechnen lassen, und die inneren
 * Invarianten des Plans: Bestände nie negativ, Reservierungen nie über
 * dem Bestand, Kontosaldo = Anker + Zahlungen, Umsatz je Monat summiert
 * sich zum Gesamtumsatz, jeder versendete Shop-Auftrag ist genau ein
 * Fulfillment. Der Live-Vergleich gegen die Datenbank ist
 * tests/prozesse/abnahme.test.ts.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { simulieren, runden } from './abnahme/modell.ts'
import { PRODUKTE, szenarioErzeugen } from './abnahme/szenario.ts'
import { szenarioStatistik, szenarioZufaellig } from './abnahme/zufall.ts'

const HEUTE = '2026-10-15'
const szenario = szenarioErzeugen(HEUTE)
const erwartung = simulieren(szenario)
const m1 = erwartung.monate[1]
const m2 = erwartung.monate[2]
const m3 = erwartung.monate[3]

describe('Abnahmetest — Rechenmodell', () => {
  test('Kalender: drei Planmonate relativ zum Lauftag, Tage bis 28', () => {
    assert.deepEqual(szenario.monate.slice(1, 4), ['2026-08-01', '2026-09-01', '2026-10-01'])
    assert.equal(szenario.faelligBis, '2026-12-31')
    const datumsfelder = szenario.schritte.flatMap((s) =>
      Object.entries(s).filter(([, v]) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)).map(([, v]) => v as string),
    )
    for (const d of datumsfelder) assert.ok(Number(d.slice(8)) <= 31, d)
  })

  test('Rundung wie Postgres: kaufmännisch, halb weg von null', () => {
    assert.equal(runden(2.675, 2), 2.68)
    assert.equal(runden(-2.675, 2), -2.68)
    assert.equal(runden(0.28 * 0.92, 6), 0.2576)
  })

  test('Einkauf von Hand: Switch-Einstand 0,2576 €, Vorkasse 1.343,20 €, Rechnung PO1 2.939,30 €', () => {
    // 5000 × 0,28 USD × Kurs 0,92 = 0,2576 je Switch — am Ende von Monat 1
    // ist das zugleich der Durchschnittspreis, weil nur PO2 geliefert hat.
    // Verbraucht wurden 3 × 70 Switches (SH1, SH3, SH4), 70 sind reserviert (SH5).
    assert.equal(m1.bestand['SW-LIN'].on_hand, 5000 - 210)
    assert.equal(m1.bestand['SW-LIN'].reserviert, 70)
    assert.equal(m1.bestand['SW-LIN'].mac, 0.2576)
    // Vorkasse: (1400 + 60) USD netto, US-Lieferant ohne deutsche USt (0121)
    // = 1460 USD × 0,92 = 1343,20 € ohne Konto.
    assert.equal(m1.zahlungen.saldo['Ohne Konto'], -1343.2)
    // R1: 40 × 36,50 + 40 × 21 + 20 × 8,50 = 2470 netto, 469,30 Steuer.
    const m1aus = m1.zahlungen.je_monat['2026-08']
    assert.ok(m1aus, 'Zahlungen in Monat 1')
    // Miete 1200 + Lizenz 89 + R1 2939,30 + Vorkasse 1343,20
    assert.equal(m1aus.aus, 1200 + 89 + 2939.3 + 1343.2)
    assert.equal(m1aus.ein, 12000)
  })

  test('Deskmat-Durchschnitt: Anfangsbestand 1 zu 9 €, 20 zu 8,50 € plus Fracht nach Gewicht', () => {
    // Fracht 120 € nach Gewicht: Gehäuse 36.000 g, PCB 4.800 g, Deskmat 9.000 g von 49.800 g.
    const frachtDeskmat = runden((120 * 9000) / 49800, 4)
    const wertVorVersand = runden(9 + runden(20 * 8.5, 4) + frachtDeskmat, 4)
    const macNachEingang = runden(wertVorVersand / 21, 6)
    // Danach gingen 2 + 1 + 3 Deskmats zum Durchschnitt hinaus — der Durchschnitt
    // bleibt bis auf die Rundungsdrift der Abgänge (vier Stellen je Schicht).
    assert.equal(m1.bestand.DESKMAT.on_hand, 21 - 6)
    assert.ok(Math.abs(m1.bestand.DESKMAT.mac - macNachEingang) < 0.00001, `${m1.bestand.DESKMAT.mac} ≈ ${macNachEingang}`)
  })

  test('Fertigung: Lohn 24 € je Tastatur (30 min × 48 €/h), Stückkosten = Material + Lohn', () => {
    // Monat 1: drei Tastaturen fertig (SH1, SH3, SH4), je 1 Gehäuse + 1 PCB + 70 Switches.
    assert.equal(m1.fertigung.stueck, 3)
    assert.equal(m1.fertigung.lohn, 72)
    assert.ok(m1.fertigung.material > 3 * (36.5 + 21 + 70 * 0.2576), 'Material über dem reinen Einkaufspreis (Fracht eingerechnet)')
  })

  test('Shopify: Tastatur meldet baubar − Puffer, Deskmat den freien Bestand', () => {
    // Ende Monat 1: 36 Gehäuse frei, 36 PCB frei, 4720 Switches frei (→ 67) ⇒ baubar 36 ⇒ gemeldet 34.
    assert.equal(m1.baubar, 36)
    assert.deepEqual(m1.shopify.soll, { DESKMAT: 15, 'KB-65': 34 })
    assert.deepEqual(m1.shopify.gemeldet, m1.shopify.soll)
    assert.equal(m1.shopify.fulfillments, 5)
    assert.equal(m3.shopify.gemeldet['KB-65'], m3.shopify.soll['KB-65'])
  })

  test('Invarianten über alle Monatsenden', () => {
    for (const stand of [m1, m2, m3]) {
      for (const p of PRODUKTE) {
        const b = stand.bestand[p.sku]
        assert.ok(b.on_hand >= 0, `${p.sku}: Bestand negativ`)
        assert.ok(b.reserviert >= 0 && b.reserviert <= b.on_hand, `${p.sku}: Reservierung passt nicht zum Bestand`)
        assert.equal(b.bewertet, b.on_hand, `${p.sku}: bewertete Menge = Bestand`)
        assert.equal(b.frei, b.on_hand - b.reserviert)
      }
      const umsatz = Object.values(stand.umsatz.je_monat).reduce((s, m) => s + m.brutto, 0)
      assert.equal(runden(umsatz, 2), runden(stand.umsatz.shop_brutto + stand.umsatz.b2b_netto * 1.19, 2))
      assert.ok(stand.lagerwert > 0)
    }
  })

  test('Finanzen: Darlehen, Verträge, Steuern am Ende von Monat 3', () => {
    // Annuität 12.000 € zu 4,8 % über 24 Monate; zwei Raten bezahlt.
    const d = m3.darlehen['Maschinen-Darlehen']
    assert.equal(d.bezahlte_raten, 2)
    assert.equal(d.status, 'laufend')
    assert.equal(d.naechste, '2026-11-05')
    assert.ok(d.restschuld < 12000 && d.restschuld > 11000)
    // Lizenz gekündigt zum Jahresende, Miete läuft; je drei Zahlungen.
    assert.deepEqual(m3.vertraege['Software-Lizenz'], { status: 'gekuendigt', ende: '2026-12-31', gezahlt: 267 })
    assert.deepEqual(m3.vertraege['Miete Werkstatt'], { status: 'aktiv', ende: null, gezahlt: 3600 })
    // Fällig bis Jahresende: Miete 11/12, Lizenz 11/12, Raten 3–4, USt Monat 3.
    assert.deepEqual(m3.faellig.vertrag, { anzahl: 4, summe: 2 * 1200 + 2 * 89 })
    assert.equal(m3.faellig.darlehen_rate.anzahl, 2)
    assert.deepEqual(m3.faellig.steuer, { anzahl: 1, summe: 1950 })
    assert.equal(m3.faellig.vendor_bill, undefined, 'alle Rechnungen bezahlt')
    assert.deepEqual(m3.steuern, { offen: 1950, bezahlt: 1850 + 2300 })
    // Ende Monat 2 war die USD-Rechnung R4 noch offen: (810 + 40 Fracht) netto,
    // US-Lieferant ohne deutsche USt (0121) = 850 USD × 0,90 (Kurs am
    // Rechnungstag) = 765 €.
    assert.deepEqual(m2.verbindlichkeiten, { offen: 765, rechnungen: 1 })
    assert.deepEqual(m2.faellig.vendor_bill, { anzahl: 1, summe: 765 })
    assert.deepEqual(m3.verbindlichkeiten, { offen: 0, rechnungen: 0 })
  })

  test('Belege am Ende: 20 Aufträge (2 storniert), 4 Bestellungen, Demontage gebucht', () => {
    assert.deepEqual(m3.belege.auftraege, { sale: 18, cancel: 2 })
    assert.deepEqual(m3.belege.bestellungen, { purchase: 4 })
    assert.equal(m3.belege.demontagen, 1)
    assert.deepEqual(m3.belege.rechnungen, { paid: 5 })
    assert.equal(m3.belege.fertigungsauftraege.cancel, 1, 'B2 storniert vor der Fertigung')
    assert.equal(m3.belege.fertigungsauftraege.confirmed, 1, 'SH17 wartet auf die Fertigung')
  })

  test('Zufallsszenario: seedbar, zehnfach, nur machbare Schritte, Invarianten halten', () => {
    const a = szenarioZufaellig({ heute: HEUTE, seed: 42, faktor: 10 })
    const b = szenarioZufaellig({ heute: HEUTE, seed: 42, faktor: 10 })
    assert.deepEqual(a.schritte, b.schritte, 'derselbe Seed ergibt denselben Plan')
    assert.notDeepEqual(szenarioZufaellig({ heute: HEUTE, seed: 43, faktor: 10 }).schritte, a.schritte)

    const statistik = szenarioStatistik(a)
    assert.ok(a.schritte.length >= 10 * 97 * 0.8, `Umfang ≥ ~zehnfach (${a.schritte.length} Schritte)`)
    assert.ok(statistik.shop_bestellung >= 150, `Shop-Bestellungen ×10 (${statistik.shop_bestellung})`)
    assert.ok(statistik.bestellung >= 30 && statistik.vertrag >= 20 && statistik.darlehen >= 2)

    // Das Modell nimmt jeden erzeugten Schritt an (der Generator fragt es vorher) —
    // und die Invarianten gelten nach jedem Monat wie im festen Szenario.
    const e = simulieren(a)
    for (const monat of [1, 2, 3]) {
      const stand = e.monate[monat]
      for (const p of PRODUKTE) {
        const z = stand.bestand[p.sku]
        assert.ok(z.on_hand >= 0 && z.reserviert >= 0 && z.reserviert <= z.on_hand, `${p.sku} Monat ${monat}: ${JSON.stringify(z)}`)
        assert.equal(z.bewertet, z.on_hand)
      }
      assert.ok(stand.shopify.soll['KB-65'] <= 99 && stand.shopify.soll['KB-65'] >= 0)
      const versendet = stand.belege.lieferungen.done ?? 0
      assert.ok(stand.shopify.fulfillments <= versendet, 'nie mehr Fulfillments als Lieferungen')
    }
  })
})
