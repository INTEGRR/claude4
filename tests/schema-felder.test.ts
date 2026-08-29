/**
 * Maskengenerierung: die formulartaugliche Feldableitung aus den
 * Registry-Schemas — datenbankfrei. Kein Registry-Schema darf in einem
 * Feldtyp landen, den das generierte Formular nicht darstellen kann.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { formularFelder } from '../src/modules/prozesse/schema-felder.ts'
import { kiKatalog } from '../src/modules/prozesse/introspektion.ts'
import { alleAktionen, registrierteAktion } from '../src/modules/prozesse/registry/index.ts'

const TYPEN = ['text', 'mehrzeilig', 'nummer', 'schalter', 'auswahl', 'verweis', 'json']

describe('Maskengenerierung: schema-felder', () => {
  test('jede Registry-Aktion liefert nur darstellbare Feldtypen', () => {
    for (const [name, aktion] of alleAktionen()) {
      for (const feld of formularFelder(aktion)) {
        assert.ok(TYPEN.includes(feld.typ), `${name}.${feld.name}: unbekannter Typ ${feld.typ}`)
        assert.ok(feld.label.length > 0, `${name}.${feld.name}: ohne Beschriftung`)
        if (feld.typ === 'auswahl') {
          assert.ok(feld.auswahl!.length > 0, `${name}.${feld.name}: Auswahl ohne Werte`)
        }
        if (feld.typ === 'verweis') {
          assert.ok(feld.quelle, `${name}.${feld.name}: Verweis ohne Quelle`)
        }
      }
    }
  })

  test('Typen, Pflicht und Vorgaben am Beispiel Reparatur-Anlage', () => {
    const felder = formularFelder(registrierteAktion('reparatur.auftrag_anlegen')!)
    const je = new Map(felder.map((f) => [f.name, f]))

    assert.equal(je.get('partner_id')!.typ, 'verweis')
    assert.equal(je.get('partner_id')!.quelle, 'partners')
    assert.equal(je.get('partner_id')!.pflicht, true)
    assert.equal(je.get('variant_id')!.typ, 'verweis')
    assert.equal(je.get('qty')!.typ, 'nummer')
    assert.equal(je.get('qty')!.pflicht, false, 'default(1) macht das Feld optional')
    assert.equal(je.get('qty')!.vorgabe, 1)
    assert.equal(je.get('under_warranty')!.typ, 'schalter')
    assert.equal(je.get('note')!.typ, 'mehrzeilig', 'max(2000) wird mehrzeilig')
  })

  test('Enums werden Auswahl, Records werden JSON', () => {
    const status = formularFelder(registrierteAktion('fehler.ticket_status')!)
    const statusFeld = status.find((f) => f.name === 'status')!
    assert.equal(statusFeld.typ, 'auswahl')
    assert.deepEqual(statusFeld.auswahl, ['offen', 'in_arbeit', 'behoben', 'verworfen'])

    const abschliessen = formularFelder(registrierteAktion('reparatur.abschliessen')!)
    assert.equal(abschliessen.find((f) => f.name === 'mengen')!.typ, 'json')
  })

  test('der rohe zusatz-Sack erscheint NIE in einer generierten Maske', () => {
    // Er ist ein Record und wurde deshalb als JSON-Textarea gerendert: direkt
    // neben den eigenen Feldern, die genau seinen Inhalt sauber erfassen
    // (zusatz.<name> aus feld_definitionen). Der Benutzer sah ein Kästchen
    // „Eigene Felder (JSON)" mit `{}` darin und sollte offenbar von Hand JSON
    // tippen — im Pilotbetrieb aufgefallen, an einem selbst gebauten Prozess.
    for (const [name, aktion] of alleAktionen()) {
      if (!aktion.modell) continue
      assert.equal(
        formularFelder(aktion).some((f) => f.name === 'zusatz'),
        false,
        `${name}: das rohe zusatz-Feld gehört nicht in die Maske`,
      )
    }
    // Gegenprobe: Die eigentliche Nutzlast ist trotzdem erreichbar — die
    // Aktion nimmt zusatz weiterhin entgegen, nur eben feldweise.
    const anlegen = registrierteAktion('vorgang.anlegen')!
    assert.ok('zusatz' in (anlegen.schema as unknown as { shape: Record<string, unknown> }).shape)
  })

  test('der KI-Katalog aus der Registry ist konsistent', () => {
    const katalog = kiKatalog()
    assert.ok(katalog.length >= 10, 'es müssen KI-freigegebene Aktionen existieren')
    for (const eintrag of katalog) {
      const aktion = registrierteAktion(eintrag.name)
      assert.ok(aktion?.ki, `${eintrag.name}: nicht (mehr) ki-geflaggt`)
      assert.equal(eintrag.beleg, aktion!.bindung === 'beleg')
    }
    // Stichprobe: Statusübergänge des Verkaufs sind für den Agenten sichtbar.
    assert.ok(katalog.some((e) => e.name === 'verkauf.bestaetigen'))
  })
})

/**
 * zusammenfassung-Wächter: Der Bestätigungsdialog des KI-Chats zeigt für
 * jede vorgeschlagene Anlage-Aktion die zusammenfassung — fehlt sie,
 * degradiert der Text zum bloßen Label und niemand bestätigt bewusst
 * (aktion-bestaetigt/agent fallen dann auf `?? label` zurück). Freie
 * ki-Aktionen legen Datensätze an, deshalb ist die Zusammenfassung dort
 * Pflicht; beleggebundene Übergänge (bestätigen, stornieren) sagt schon
 * das Label vollständig.
 */
describe('KI-Aktionen: Bestätigungstext', () => {
  test('jede freie ki-Aktion hat eine zusammenfassung', () => {
    for (const [name, a] of alleAktionen()) {
      if (!a.ki || a.bindung !== 'frei') continue
      assert.equal(
        typeof a.zusammenfassung,
        'function',
        `${name}: ki-Anlage-Aktion ohne zusammenfassung — der Bestätigungsdialog zeigt sonst nur das Label`,
      )
    }
  })
})
