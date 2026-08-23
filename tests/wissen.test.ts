import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROZESS_WISSEN,
  STANDARD_BAUSTEINE,
  bausteineAlsText,
  werkstattSystemZusatz,
} from '../src/modules/ki/wissen.ts'

/**
 * Wissensbasis-Wächter: die Best Practices sind die EINE versionierte
 * Quelle für Werkstatt-Agent und Aufnahme-Strukturierung. Geprüft wird
 * Substanz (Pflichtthemen) und Disziplin (Tokenbudget) — Muster wie der
 * Instructions-Längentest des Sprachmodus.
 */
describe('Wissensbasis Prozess-Best-Practices', () => {
  test('deckt die Pflichtthemen ab und bleibt im Tokenbudget', () => {
    assert.ok(PROZESS_WISSEN.length > 500, 'kein leerer Platzhalter')
    assert.ok(PROZESS_WISSEN.length < 6000, `Budget: ${PROZESS_WISSEN.length} Zeichen`)
    for (const begriff of ['xor', 'Zustände', 'vergessene', 'IST', 'Rückfragen', 'Feld']) {
      assert.ok(PROZESS_WISSEN.includes(begriff), `Pflichtthema fehlt: ${begriff}`)
    }
  })

  test('Standard-Bausteine: Schritte UND Felder je erkennbarem Prozesstyp', () => {
    // Die Bausteine drehen die Erhebung um — vorschlagen statt abfragen.
    // Ohne den Wächter könnten sie bei der nächsten Kürzung verschwinden
    // und die Interviews würden wieder feldblind.
    assert.ok(STANDARD_BAUSTEINE.length >= 6, `nur ${STANDARD_BAUSTEINE.length} Bausteine`)
    for (const b of STANDARD_BAUSTEINE) {
      assert.ok(b.schritte.length >= 3, `${b.code}: zu wenige Schritte`)
      assert.ok(b.felder.length >= 3, `${b.code}: zu wenige Felder`)
      assert.ok(b.stichworte.length >= 2, `${b.code}: ohne Erkennungs-Stichworte`)
      for (const f of b.felder) {
        assert.match(f.name, /^[a-z][a-z0-9_]*$/, `${b.code}.${f.name}: kein technischer Name`)
        assert.ok(
          ['text', 'nummer', 'schalter', 'auswahl', 'datum'].includes(f.typ),
          `${b.code}.${f.name}: unbekannter Typ ${f.typ}`,
        )
        if (f.typ === 'auswahl') {
          assert.ok(f.auswahl?.length, `${b.code}.${f.name}: Auswahl ohne Werte`)
        }
      }
      assert.ok(
        b.felder.some((f) => f.in_liste),
        `${b.code}: kein Feld für die Liste — woran erkennt der Kunde eine Zeile?`,
      )
    }

    // Das wörtliche Nutzer-Kriterium: „dass bei einem Eingangsrechnungs-
    // prozess die Rechnungsnummer und Datum als Feld drin sein müssen,
    // muss klar sein."
    const rechnung = STANDARD_BAUSTEINE.find((b) => b.code === 'eingangsrechnung')
    assert.ok(rechnung, 'Baustein eingangsrechnung fehlt')
    const namen = rechnung.felder.map((f) => f.name)
    assert.ok(namen.includes('rechnungsnummer'), 'eingangsrechnung ohne rechnungsnummer')
    assert.ok(namen.includes('rechnungsdatum'), 'eingangsrechnung ohne rechnungsdatum')
    assert.ok(
      rechnung.felder.filter((f) => f.pflicht).length >= 2,
      'Pflichtangaben der Eingangsrechnung müssen Pflicht sein',
    )

    assert.ok(bausteineAlsText().length < 4500, `Promptbudget: ${bausteineAlsText().length}`)
  })

  test('der Werkstatt-Zusatz führt zum Entwurfsweg, nie zur Aktivierung', () => {
    const zusatz = werkstattSystemZusatz()
    assert.ok(zusatz.length < 14_000, `Budget: ${zusatz.length} Zeichen`)
    assert.ok(zusatz.includes(bausteineAlsText()), 'Zusatz trägt die Standard-Bausteine')
    assert.ok(zusatz.includes('aktion_vorschlagen'), 'Entwürfe nur über den Vorschlagsweg')
    assert.ok(zusatz.includes('einstellungen.prozess_entwerfen'))
    assert.ok(zusatz.includes('/prozesse/'), 'Sichtprüfung auf der Prozessseite')
    assert.ok(zusatz.includes('von Hand'), 'Aktivierung bleibt beim Menschen')
    assert.ok(zusatz.includes(PROZESS_WISSEN), 'Zusatz trägt die Wissensbasis')
  })
})
