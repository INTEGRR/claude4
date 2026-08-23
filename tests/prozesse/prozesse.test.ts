/**
 * Die Prozessläufe: jede Fixture spielt ihre Durchläufe über den Torwächter
 * gegen die aktive Prozessversion — ein Befehl beweist, dass die Kernprozesse
 * des Hauses durchgängig funktionieren (siehe laufen.ts).
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { alleFixtures, fixtureReihenfolge } from '../../src/modules/prozesse/fixtures/index.ts'
import type { FixtureKontext } from '../../src/modules/prozesse/fixtures/typen.ts'
import { AktionsFehler, aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { prozessDurchspielen } from './laufen.ts'

const DATENBANK = 'erp_prozess_test'

let h: Harness
const ctx: FixtureKontext = {}

before(async () => {
  h = await harnessStart(DATENBANK)
  for (const name of fixtureReihenfolge(alleFixtures().map(([n]) => n))) {
    const [, fixture] = alleFixtures().find(([n]) => n === name)!
    await fixture.aufbauen?.(h.sql, ctx)
  }
})

after(async () => {
  if (h) await harnessEnde(h, DATENBANK)
})

describe('Prozessläufe', () => {
  for (const [, fixture] of alleFixtures()) {
    if (!fixture.prozess || !fixture.laeufe?.length) continue
    describe(fixture.prozess, () => {
      for (const lauf of fixture.laeufe!) {
        test(lauf.name, async () => {
          await prozessDurchspielen(h.sql, fixture, lauf, ctx)
        })
      }
    })
  }
})

// Bewusst NACH allen Läufen: der Paketwechsel schaltet Prozesse ab — die
// Fixtures oben brauchen den Auslieferungszustand (alles aktiv).
describe('Chamäleon: Paketwechsel', () => {
  const admin = { name: 'prozesstest', role: 'admin' as const }

  after(async () => {
    // Auslieferungszustand wiederherstellen — im Staging-Modus teilen sich
    // alle Läufe die Datenbank, da darf kein Paket „hängen bleiben".
    await h.sql`update prozesse set aktiv = true`
  })

  test('Paket „werkstatt": genau die Paket-Prozesse aktiv, Bug-Loop bleibt an', async () => {
    const ergebnis = await aktionAusfuehrenGeprueft(
      'einstellungen.paket_aktivieren',
      { parameter: { paket_code: 'werkstatt' } },
      admin,
    )
    assert.match(ergebnis.text ?? '', /werkstatt|Werkstatt/i)

    const aktiv = new Map(
      (await h.sql<{ code: string; aktiv: boolean }[]>`select code, aktiv from prozesse`).map(
        (p) => [p.code, p.aktiv],
      ),
    )
    // Das Paket: Reparatur + Anfrage + Artikelanlage; Infrastruktur bleibt.
    assert.equal(aktiv.get('reparatur'), true)
    assert.equal(aktiv.get('anfrage'), true)
    assert.equal(aktiv.get('artikel_anlegen'), true)
    assert.equal(aktiv.get('bug_ticket'), true, 'der Bug-Loop ist Infrastruktur')
    // Der Rest ist abgeschaltet — der Pivot weg vom Herstellen/Handeln.
    assert.equal(aktiv.get('fertigung'), false)
    assert.equal(aktiv.get('shopify_bestellung_versand'), false)
    assert.equal(aktiv.get('einkauf_wareneingang_rechnung'), false)
  })

  test('einzelner Prozess lässt sich wieder zuschalten', async () => {
    await aktionAusfuehrenGeprueft(
      'einstellungen.prozess_schalten',
      { parameter: { prozess_code: 'fertigung', aktiv: true } },
      admin,
    )
    const [{ aktiv }] = await h.sql<{ aktiv: boolean }[]>`
      select aktiv from prozesse where code = 'fertigung'`
    assert.equal(aktiv, true)
  })

  test('der Bug-Loop ist nicht abschaltbar, unbekannte Codes scheitern verständlich', async () => {
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einstellungen.prozess_schalten',
        { parameter: { prozess_code: 'bug_ticket', aktiv: false } },
        admin,
      ),
      (err: unknown) => err instanceof AktionsFehler && /Infrastruktur/.test(String(err)),
    )
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einstellungen.paket_aktivieren',
        { parameter: { paket_code: 'gibtsnicht' } },
        admin,
      ),
      /existiert nicht/,
    )
  })
})

// Konsistenz-Wächter: Teilprozess-Kanten sind harte Abhängigkeiten — wer
// schaltet, darf keinen aktiven Elternprozess zerreißen, und wer ein Paket
// aktiviert, bekommt die Abhängigkeiten automatisch dazu.
describe('Chamäleon: Konsistenz-Wächter für Teilprozesse', () => {
  const admin = { name: 'prozesstest', role: 'admin' as const }

  after(async () => {
    await h.sql`update prozesse set aktiv = true`
    await h.sql`delete from prozess_pakete where code = 'test_nur_einkauf'`
  })

  test('Teilprozess eines aktiven Elternprozesses lässt sich nicht abschalten', async () => {
    // wareneingang ist Teilprozess von einkauf_wareneingang_rechnung (aktiv).
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einstellungen.prozess_schalten',
        { parameter: { prozess_code: 'wareneingang', aktiv: false } },
        admin,
      ),
      (err: unknown) =>
        err instanceof AktionsFehler && /Teilprozess von.*einkauf_wareneingang_rechnung/.test(String(err)),
    )
    const [{ aktiv }] = await h.sql<{ aktiv: boolean }[]>`
      select aktiv from prozesse where code = 'wareneingang'`
    assert.equal(aktiv, true, 'der Wächter darf nichts verändert haben')
  })

  test('ohne aktiven Eltern geht es — und Wieder-Einschalten zieht die Kinder mit', async () => {
    await aktionAusfuehrenGeprueft(
      'einstellungen.prozess_schalten',
      { parameter: { prozess_code: 'einkauf_wareneingang_rechnung', aktiv: false } },
      admin,
    )
    await aktionAusfuehrenGeprueft(
      'einstellungen.prozess_schalten',
      { parameter: { prozess_code: 'wareneingang', aktiv: false } },
      admin,
    )
    await aktionAusfuehrenGeprueft(
      'einstellungen.prozess_schalten',
      { parameter: { prozess_code: 'lieferantenrechnung', aktiv: false } },
      admin,
    )

    const ergebnis = await aktionAusfuehrenGeprueft(
      'einstellungen.prozess_schalten',
      { parameter: { prozess_code: 'einkauf_wareneingang_rechnung', aktiv: true } },
      admin,
    )
    assert.match(ergebnis.text ?? '', /Teilprozesse mit aktiviert/)

    const aktiv = new Map(
      (await h.sql<{ code: string; aktiv: boolean }[]>`select code, aktiv from prozesse`).map(
        (p) => [p.code, p.aktiv],
      ),
    )
    assert.equal(aktiv.get('wareneingang'), true)
    assert.equal(aktiv.get('lieferantenrechnung'), true)
  })

  test('Paketwechsel zieht Teilprozess-Abhängigkeiten transitiv mit', async () => {
    // Ein Paket, das nur den Einkauf nennt — Wareneingang und
    // Lieferantenrechnung fehlen absichtlich.
    await h.sql`
      insert into prozess_pakete (code, name, beschreibung, prozess_codes)
      values ('test_nur_einkauf', 'Test: nur Einkauf', 'Wächter-Test',
              array['einkauf_wareneingang_rechnung'])`

    const ergebnis = await aktionAusfuehrenGeprueft(
      'einstellungen.paket_aktivieren',
      { parameter: { paket_code: 'test_nur_einkauf' } },
      admin,
    )
    assert.match(ergebnis.text ?? '', /automatisch mit aktiviert/)

    const aktiv = new Map(
      (await h.sql<{ code: string; aktiv: boolean }[]>`select code, aktiv from prozesse`).map(
        (p) => [p.code, p.aktiv],
      ),
    )
    assert.equal(aktiv.get('einkauf_wareneingang_rechnung'), true)
    assert.equal(aktiv.get('wareneingang'), true, 'Teilprozess muss mitkommen')
    assert.equal(aktiv.get('lieferantenrechnung'), true, 'Teilprozess muss mitkommen')
    assert.equal(aktiv.get('bug_ticket'), true, 'Infrastruktur bleibt an')
    assert.equal(aktiv.get('verkauf'), false, 'nicht genannte Prozesse gehen aus')
  })
})

// Schritt-Befugnisse: der Freigabe-Schritt im Einkaufsprozess verlangt
// 'einkauf:freigabe' — der Torwächter erzwingt das auf JEDEM Transportweg,
// nicht nur im Prozess-Panel. Admin besteht immer.
describe('Schritt-Befugnisse am Torwächter', () => {
  let poId: string

  before(async () => {
    const [vendor] = await h.sql<{ id: string }[]>`
      insert into partners (name, is_vendor) values ('Befugnis-Test GmbH', true) returning id`
    const [po] = await h.sql<{ id: string }[]>`
      insert into purchase_orders (number, vendor_id)
      values (next_sequence('purchase'), ${vendor.id}) returning id`
    poId = po.id
  })

  test('ohne Befugnis wird die Freigabe verweigert — mit Befugnis läuft sie', async () => {
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einkauf.bestellung_freigeben',
        { recordId: poId },
        { name: 'buero', role: 'mitarbeiter' },
      ),
      (err: unknown) => err instanceof AktionsFehler && /Befugnis/.test(String(err)),
      'Bereichsrecht allein reicht nicht — der Schritt verlangt die Befugnis',
    )

    const ergebnis = await aktionAusfuehrenGeprueft(
      'einkauf.bestellung_freigeben',
      { recordId: poId },
      { name: 'supervisor', role: 'mitarbeiter', befugnisse: ['einkauf:freigabe'] },
    )
    assert.match(ergebnis.text ?? '', /freigegeben/i)

    const [po] = await h.sql<{ freigegeben_von: string }[]>`
      select freigegeben_von from purchase_orders where id = ${poId}`
    assert.equal(po.freigegeben_von, 'supervisor')
  })

  test('Admin besteht die Befugnisprüfung immer', async () => {
    const [vendor] = await h.sql<{ id: string }[]>`
      select id from partners where name = 'Befugnis-Test GmbH'`
    const [po2] = await h.sql<{ id: string }[]>`
      insert into purchase_orders (number, vendor_id)
      values (next_sequence('purchase'), ${vendor.id}) returning id`
    await aktionAusfuehrenGeprueft(
      'einkauf.bestellung_freigeben',
      { recordId: po2.id },
      { name: 'chefin', role: 'admin' },
    )
    const [po] = await h.sql<{ freigegeben_von: string }[]>`
      select freigegeben_von from purchase_orders where id = ${po2.id}`
    assert.equal(po.freigegeben_von, 'chefin')
  })
})

// Der ganze Chamäleon-Bogen: die KI entwirft einen Prozess (nur als Entwurf),
// der Mensch aktiviert nach Prüfung — und der designte Prozess läuft sofort
// auf generischen Vorgängen, ohne eine Zeile neuen Codes.
describe('Chamäleon: KI-Prozessentwurf', () => {
  const admin = { name: 'prozesstest', role: 'admin' as const }

  const ENTWURF = {
    code: 'ruecknahme',
    name: 'Rücknahme (designter Prozess)',
    beschreibung: 'Testentwurf: Rückgabe annehmen und erstatten.',
    bereich: 'verkauf',
    modell: 'vorgang',
    schritte: [
      { code: 'start', name: 'Rückgabe gemeldet', art: 'start' },
      {
        code: 'annehmen',
        name: 'Annehmen',
        art: 'aktion',
        aktion: 'vorgang.anlegen',
        zustand: 'angenommen',
        params: { prozess_code: 'ruecknahme' },
      },
      {
        code: 'erstatten',
        name: 'Erstatten',
        art: 'aktion',
        aktion: 'vorgang.status_setzen',
        zustand: 'erstattet',
        params: { state: 'erstattet' },
      },
      { code: 'ende', name: 'Erledigt', art: 'ende' },
    ],
    uebergaenge: [
      { von: 'start', nach: 'annehmen' },
      { von: 'annehmen', nach: 'erstatten' },
      { von: 'erstatten', nach: 'ende' },
    ],
    // Die Daten gehören in denselben Entwurf wie die Schritte (0071):
    // ein Ablauf ist Schritte UND das, was in ihnen erfasst wird.
    felder: [
      {
        name: 'ruecksendenummer',
        label: 'Rücksendenummer',
        typ: 'text',
        pflicht: true,
        schritte: ['annehmen'],
        in_liste: true,
      },
      {
        name: 'erstattungsbetrag',
        label: 'Erstattungsbetrag',
        typ: 'nummer',
        schritte: ['erstatten'],
      },
      { name: 'kanal', label: 'Eingang über', typ: 'auswahl', auswahl: ['Shop', 'Telefon'] },
    ],
  }

  after(async () => {
    // Vorgänge zuerst (FK ohne Cascade), dann reißt der Prozess seine
    // Versionen, Schritte und Übergänge per Cascade mit.
    await h.sql`delete from vorgaenge where prozess_code in ('ruecknahme', 'kaputt')`
    await h.sql`delete from prozesse where code in ('ruecknahme', 'kaputt')`
  })

  test('Entwurf entsteht inaktiv — nichts läuft, bis ein Mensch aktiviert', async () => {
    const ergebnis = await aktionAusfuehrenGeprueft(
      'einstellungen.prozess_entwerfen',
      { parameter: ENTWURF },
      admin,
    )
    assert.match(ergebnis.text ?? '', /Entwurf/)

    const [prozess] = await h.sql<{ aktiv: boolean }[]>`
      select aktiv from prozesse where code = 'ruecknahme'`
    assert.equal(prozess.aktiv, false, 'neue Prozesse entstehen inaktiv')
    const [version] = await h.sql<{ status: string; version: number }[]>`
      select v.status, v.version from prozess_versionen v
      join prozesse p on p.id = v.prozess_id where p.code = 'ruecknahme'`
    assert.equal(version.status, 'entwurf')

    // Der Vorgangs-Start verweigert den inaktiven Prozess.
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'vorgang.anlegen',
        { parameter: { prozess_code: 'ruecknahme' } },
        admin,
      ),
      /kein aktiver Vorgangs-Prozess/,
    )
  })

  test('der Entwurf bringt die Felder mit — je Schritt und für die Liste', async () => {
    // Kern des Chamäleon-Versprechens: Der Kunde beschreibt seinen Ablauf,
    // und daraus entsteht die ganze Oberfläche — Navigation, Maske UND die
    // Daten darin. Vorher kamen Felder nur über einen eigenen Handgriff, den
    // niemand findet, und hingen am MODELL: alle Laufzeit-Prozesse teilten
    // sich dieselben Felder.
    const felder = await h.sql<
      {
        name: string
        label: string
        typ: string
        pflicht: boolean
        prozess_code: string | null
        schritte: string[] | null
        sichtbar_in: string[]
      }[]
    >`
      select name, label, typ, pflicht, prozess_code, schritte, sichtbar_in
      from feld_definitionen where prozess_code = 'ruecknahme' order by sequence`
    assert.equal(felder.length, 3, 'alle drei Felder des Entwurfs müssen stehen')
    assert.deepEqual(
      felder.map((f) => f.name),
      ['ruecksendenummer', 'erstattungsbetrag', 'kanal'],
    )
    assert.equal(felder[0].pflicht, true)
    assert.deepEqual(felder[0].schritte, ['annehmen'])
    assert.ok(felder[0].sichtbar_in.includes('liste'), 'in_liste macht eine Spalte daraus')
    assert.equal(felder[1].sichtbar_in.includes('liste'), false)
    assert.equal(felder[2].schritte, null, 'ohne schritte[] gilt das Feld überall')

    // Ein Feld, das auf einen Schritt zeigt, den es nicht gibt, wäre in
    // keiner Maske sichtbar — der Entwurf muss das melden, nicht schlucken.
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einstellungen.prozess_entwerfen',
        {
          parameter: {
            ...ENTWURF,
            felder: [
              { name: 'irgendwas', label: 'Irgendwas', typ: 'text', schritte: ['gibtsnicht'] },
            ],
          },
        },
        admin,
      ),
      /Schritt „gibtsnicht" gibt es nicht/,
    )
  })

  test('vorgang.anlegen ohne zustand wird abgewiesen', async () => {
    // Der erste selbst aufgenommene Kundenprozess ließ den zustand am
    // Anlage-Schritt weg. Der Vorgang startete dann auf dem Notnagel 'neu' —
    // einem Zustand, den sein eigener Prozess nicht kennt: das Panel fand
    // keinen nächsten Schritt, die Liste keinen Filter. Der Entwurf muss den
    // Einstiegszustand nennen, sonst entsteht er gar nicht erst.
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einstellungen.prozess_entwerfen',
        {
          parameter: {
            ...ENTWURF,
            code: 'kaputt',
            name: 'Rücknahme ohne Einstiegszustand',
            schritte: ENTWURF.schritte.map((s) =>
              s.code === 'annehmen' ? { ...s, zustand: undefined } : s,
            ),
          },
        },
        admin,
      ),
      /braucht einen zustand/,
    )
  })

  test('jsonb-Felder liegen als OBJEKT in der Datenbank, nicht als String', async () => {
    // Der Treiber verpackt einen bereits serialisierten String noch einmal:
    // aus JSON.stringify(x)::jsonb wird ein JSON-STRING statt eines Objekts.
    // Das ist unsichtbar, bis jemand das Feld benutzt — die Vorgangsmaske
    // prüfte `'partner_id' in params` und lief auf einen TypeError, und
    // bedingung_pruefen sah einen String statt einer Bedingung. Beides erst
    // im Pilotbetrieb aufgefallen, an einem von der KI entworfenen Prozess.
    const typen = await h.sql<{ code: string; typ: string }[]>`
      select s.code, jsonb_typeof(s.params) as typ
      from prozess_schritte s
      join prozess_versionen v on v.id = s.version_id
      join prozesse p on p.id = v.prozess_id
      where p.code = 'ruecknahme'`
    assert.ok(typen.length > 0, 'der Entwurf muss Schritte haben')
    assert.deepEqual(
      typen.filter((t) => t.typ !== 'object'),
      [],
      'params muss ein jsonb-Objekt sein',
    )

    // Und der Inhalt ist auch wirklich lesbar (nicht nur „irgendein Objekt").
    const [anlegen] = await h.sql<{ prozess_code: string | null }[]>`
      select s.params ->> 'prozess_code' as prozess_code
      from prozess_schritte s
      join prozess_versionen v on v.id = s.version_id
      join prozesse p on p.id = v.prozess_id
      where p.code = 'ruecknahme' and s.code = 'annehmen'`
    assert.equal(anlegen.prozess_code, 'ruecknahme')
  })

  test('nach der Aktivierung läuft der designte Prozess sofort', async () => {
    await aktionAusfuehrenGeprueft(
      'einstellungen.prozessversion_aktivieren',
      { parameter: { prozess_code: 'ruecknahme', version: 1 } },
      admin,
    )
    const [prozess] = await h.sql<{ aktiv: boolean }[]>`
      select aktiv from prozesse where code = 'ruecknahme'`
    assert.equal(prozess.aktiv, true)

    // Ohne neuen Code: anlegen (Startzustand aus der Definition) und
    // weiterschalten über den Torwächter.
    const angelegt = await aktionAusfuehrenGeprueft(
      'vorgang.anlegen',
      { parameter: { prozess_code: 'ruecknahme', titel: 'Testrückgabe' } },
      admin,
    )
    const vorgangId = angelegt.recordId!
    const [vorgang] = await h.sql<{ state: string }[]>`
      select state from vorgaenge where id = ${vorgangId}`
    assert.equal(vorgang.state, 'angenommen', 'Startzustand kommt aus dem Entwurf')

    await aktionAusfuehrenGeprueft(
      'vorgang.status_setzen',
      { parameter: { state: 'erstattet' }, recordId: vorgangId },
      admin,
    )
    const [fertig] = await h.sql<{ state: string }[]>`
      select state from vorgaenge where id = ${vorgangId}`
    assert.equal(fertig.state, 'erstattet')
  })

  test('die Maske entsteht aus dem Prozess — je Schritt genau seine Felder', async () => {
    const { startAngebot, naechsteAngebote } = await import('@/modules/prozesse/angebote')

    // Startformular = Maske des Anlage-Schritts. Vorher fehlten die eigenen
    // Felder hier komplett: Was der Kunde als „beim Anlegen erfasse ich X"
    // beschrieben hatte, fiel genau an der Stelle unter den Tisch.
    const start = await startAngebot('ruecknahme')
    assert.ok(start, 'ein Laufzeit-Prozess muss ein Startformular haben')
    const startFelder = start.felder.map((f) => f.name)
    assert.ok(startFelder.includes('zusatz.ruecksendenummer'), 'Feld des Anlage-Schritts fehlt')
    assert.ok(startFelder.includes('zusatz.kanal'), 'Feld ohne Schrittbindung gilt überall')
    assert.equal(
      startFelder.includes('zusatz.erstattungsbetrag'),
      false,
      'ein Feld des Erstatten-Schritts hat im Startformular nichts zu suchen',
    )
    assert.equal(start.vorbelegung.prozess_code, 'ruecknahme')

    // Und im Folgeschritt genau umgekehrt.
    const angelegt = await aktionAusfuehrenGeprueft(
      'vorgang.anlegen',
      {
        parameter: {
          prozess_code: 'ruecknahme',
          titel: 'Maskenprobe',
          zusatz: { ruecksendenummer: 'RS-42' },
        },
      },
      admin,
    )
    const [gespeichert] = await h.sql<{ nummer: string | null }[]>`
      select zusatz ->> 'ruecksendenummer' as nummer from vorgaenge where id = ${angelegt.recordId!}`
    assert.equal(gespeichert.nummer, 'RS-42', 'die eigenen Felder landen im zusatz')

    const { angebote } = await naechsteAngebote('ruecknahme', angelegt.recordId!, 'admin')
    const erstatten = angebote.find((a) => a.code === 'erstatten')
    assert.ok(erstatten, 'der Folgeschritt muss angeboten werden')
    const folgeFelder = erstatten.felder.map((f) => f.name)
    assert.ok(folgeFelder.includes('zusatz.erstattungsbetrag'))
    assert.equal(folgeFelder.includes('zusatz.ruecksendenummer'), false)
  })

  test('kopf_aendern pflegt Daten ohne Zustandswechsel — und koerziert die Typen', async () => {
    // Die Detailseite ist jetzt eine Maske: Titel, Kunde und eigene Felder
    // bleiben nach dem Anlegen änderbar, auch im Endzustand. Formulare
    // liefern Strings — im jsonb müssen echte Typen liegen, sonst vergleicht
    // bedingung_pruefen auf zusatz.betrag > 1000 später Text.
    const angelegt = await aktionAusfuehrenGeprueft(
      'vorgang.anlegen',
      { parameter: { prozess_code: 'ruecknahme', titel: 'Tippfehler drin' } },
      admin,
    )
    const id = angelegt.recordId!

    await aktionAusfuehrenGeprueft(
      'vorgang.kopf_aendern',
      {
        parameter: {
          titel: 'Korrigiert',
          zusatz: { erstattungsbetrag: '49,90', ruecksendenummer: 'RS-99', kanal: '' },
        },
        recordId: id,
      },
      admin,
    )

    const [nachher] = await h.sql<
      { titel: string; state: string; typ: string; betrag: number; kanal: unknown }[]
    >`
      select titel, state,
             jsonb_typeof(zusatz -> 'erstattungsbetrag') as typ,
             (zusatz ->> 'erstattungsbetrag')::numeric as betrag,
             zusatz -> 'kanal' as kanal
      from vorgaenge where id = ${id}`
    assert.equal(nachher.titel, 'Korrigiert')
    assert.equal(nachher.state, 'angenommen', 'der Zustand bleibt unangetastet')
    assert.equal(nachher.typ, 'number', 'Nummernfelder liegen als Zahl im jsonb')
    assert.equal(Number(nachher.betrag), 49.9, 'deutsches Komma wird verstanden')
    assert.equal(nachher.kanal, null, 'leeren löscht den Wert')

    // Unlesbare Zahl scheitert verständlich statt Text zu speichern.
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'vorgang.kopf_aendern',
        { parameter: { zusatz: { erstattungsbetrag: 'viel' } }, recordId: id },
        admin,
      ),
      /keine Zahl/,
    )
  })

  test('Unfug scheitert schon beim Entwurf — die Datenbank bleibt die letzte Instanz', async () => {
    // Unbekannte Aktionsnamen fängt der Entwurf ab.
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einstellungen.prozess_entwerfen',
        {
          parameter: {
            ...ENTWURF,
            code: 'kaputt',
            schritte: ENTWURF.schritte.map((s) =>
              s.code === 'annehmen' ? { ...s, aktion: 'gibts.nicht' } : s,
            ),
          },
        },
        admin,
      ),
      /unbekannte Aktion/,
    )

    // BUG/00015: Strukturfehler galten früher erst beim Aktivieren — der
    // Entwurf entstand klaglos und war danach eine Sackgasse. Jetzt lehnt
    // schon der Entwurf ab, und zwar mit derselben Begründung.
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einstellungen.prozess_entwerfen',
        {
          parameter: {
            ...ENTWURF,
            code: 'kaputt',
            name: 'Kaputter Entwurf',
            uebergaenge: ENTWURF.uebergaenge.filter((u) => u.nach !== 'erstatten'),
          },
        },
        admin,
      ),
      /erreichbar/,
    )

    // Der Fall aus BUG/00015 selbst: eine Verzweigung mit zwei
    // bedingungslosen Kanten. Der Kunde hatte den Verkaufsprozess so von der
    // KI umbauen lassen und konnte ihn danach nie schalten.
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einstellungen.prozess_entwerfen',
        {
          parameter: {
            ...ENTWURF,
            code: 'kaputt',
            name: 'Zwei Standardwege',
            schritte: [
              ...ENTWURF.schritte,
              { code: 'weiche', name: 'Erstatten?', art: 'xor' },
            ],
            uebergaenge: [
              { von: 'start', nach: 'annehmen' },
              { von: 'annehmen', nach: 'weiche' },
              { von: 'weiche', nach: 'erstatten' },
              { von: 'weiche', nach: 'ende' },
              { von: 'erstatten', nach: 'ende' },
            ],
          },
        },
        admin,
      ),
      /höchstens eine bedingungslos/,
    )

    // Nichts davon hat einen Prozess hinterlassen.
    const [kaputt] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from prozesse where code = 'kaputt'`
    assert.equal(kaputt.n, 0, 'abgelehnte Entwürfe legen keinen Prozess an')
  })

  test('die Aktivierung bleibt die letzte Instanz — auch an prozess_entwerfen vorbei', async () => {
    // Ein Entwurf, der NICHT über die Aktion entstand (Migration, Import,
    // Handarbeit): dann greift nur noch der Wächter in der Datenbank. Genau
    // dafür steht er dort — die Prüfung im Entwurf ist die frühe Warnung,
    // nicht die Sicherung.
    const [prozess] = await h.sql<{ id: string }[]>`
      insert into prozesse (code, name, bereich, modell, aktiv)
      values ('kaputt', 'Von Hand verbogen', 'verkauf', 'vorgang', false)
      returning id`
    const [version] = await h.sql<{ id: string }[]>`
      insert into prozess_versionen (prozess_id, version, status, created_by)
      values (${prozess.id}, 1, 'entwurf', 'test') returning id`
    await h.sql`
      insert into prozess_schritte (version_id, code, name, art, sequence)
      values (${version.id}, 'start', 'Start', 'start', 0),
             (${version.id}, 'insel', 'Unerreichbar', 'ende', 10),
             (${version.id}, 'ende', 'Ende', 'ende', 20)`
    await h.sql`
      insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence)
      values (${version.id}, 'start', 'ende', 10)`

    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einstellungen.prozessversion_aktivieren',
        { parameter: { prozess_code: 'kaputt', version: 1 } },
        admin,
      ),
      /erreichbar/,
    )
    const [kaputt] = await h.sql<{ aktiv: boolean }[]>`
      select aktiv from prozesse where code = 'kaputt'`
    assert.equal(kaputt.aktiv, false, 'ein abgelehnter Entwurf schaltet nichts aktiv')
  })

  test('bestehende Prozesse lassen sich umbauen — mit Dienst-Schritt aus dem Katalog', async () => {
    // Nächste Version des BESTEHENDEN Prozesses (Beleg bleibt, modell
    // weggelassen): der Umbau hängt einen dienst-Schritt hinter das Erstatten.
    const ergebnis = await aktionAusfuehrenGeprueft(
      'einstellungen.prozess_entwerfen',
      {
        parameter: {
          ...ENTWURF,
          modell: undefined,
          schritte: [
            ...ENTWURF.schritte,
            {
              code: 'melden',
              name: 'Shop benachrichtigen',
              art: 'dienst',
              job_kind: 'shopify_tag_add',
              optional: true,
            },
          ],
          uebergaenge: [
            ...ENTWURF.uebergaenge,
            { von: 'erstatten', nach: 'melden' },
            { von: 'melden', nach: 'ende' },
          ],
        },
      },
      admin,
    )
    assert.match(ergebnis.text ?? '', /Version 2/)
    const [entwurf] = await h.sql<{ status: string; job_kind: string | null }[]>`
      select v.status, s.job_kind
      from prozess_versionen v
      join prozesse p on p.id = v.prozess_id
      left join prozess_schritte s on s.version_id = v.id and s.code = 'melden'
      where p.code = 'ruecknahme' and v.version = 2`
    assert.equal(entwurf.status, 'entwurf', 'der Umbau bleibt ein Entwurf')
    assert.equal(entwurf.job_kind, 'shopify_tag_add')

    // Referenzen außerhalb der Kataloge scheitern sofort und verständlich.
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einstellungen.prozess_entwerfen',
        {
          parameter: {
            ...ENTWURF,
            modell: undefined,
            schritte: [
              ...ENTWURF.schritte,
              { code: 'melden', name: 'Kaputt', art: 'dienst', job_kind: 'gibtsnicht' },
            ],
            uebergaenge: [...ENTWURF.uebergaenge, { von: 'erstatten', nach: 'melden' }],
          },
        },
        admin,
      ),
      /unbekannter Job/,
    )
  })

  test('KI-Chat-Befunde: Modell-Echo, DB-Spaltennamen und Teilprozess-Schritte gehen durch', async () => {
    // Exakt die Eingabeform, an der der Agent im Betrieb gescheitert war:
    // modell des BESTEHENDEN Prozesses mitgeschickt, Übergänge mit den
    // DB-Spaltennamen aus sql_abfrage, Teilprozess-Schritt als art=prozess.
    const ergebnis = await aktionAusfuehrenGeprueft(
      'einstellungen.prozess_entwerfen',
      {
        parameter: {
          code: 'einkauf_wareneingang_rechnung',
          name: 'Einkauf (Umbau-Entwurf)',
          bereich: 'einkauf',
          modell: 'purchase_order',
          schritte: [
            { code: 'start', name: 'Bedarf erkannt', art: 'start' },
            {
              code: 'anlegen', name: 'Bestellung anlegen', art: 'aktion',
              aktion: 'einkauf.bestellung_anlegen', zustand: 'draft',
            },
            {
              code: 'bestaetigen', name: 'Bestellen', art: 'aktion',
              aktion: 'einkauf.bestaetigen', zustand: 'purchase',
            },
            { code: 'wareneingang', name: 'Wareneingang', art: 'prozess', teilprozess: 'wareneingang' },
            { code: 'ende', name: 'Fertig', art: 'ende' },
          ],
          uebergaenge: [
            { von_code: 'start', nach_code: 'anlegen' },
            { von_code: 'anlegen', nach_code: 'bestaetigen' },
            { von_code: 'bestaetigen', nach_code: 'wareneingang' },
            { von_code: 'wareneingang', nach_code: 'ende' },
          ],
        },
      },
      admin,
    )
    assert.match(ergebnis.text ?? '', /Entwurf/)

    const [entwurf] = await h.sql<{ id: string; teilprozess: string | null }[]>`
      select v.id, s.teilprozess
      from prozess_versionen v
      join prozesse p on p.id = v.prozess_id
      left join prozess_schritte s on s.version_id = v.id and s.code = 'wareneingang'
      where p.code = 'einkauf_wareneingang_rechnung' and v.status = 'entwurf'
      order by v.version desc limit 1`
    assert.equal(entwurf.teilprozess, 'wareneingang', 'der Teilprozess-Schritt muss im Entwurf stehen')
    // Aufräumen — im Staging-Modus teilt sich alles die Datenbank.
    await h.sql`delete from prozess_versionen where id = ${entwurf.id}`

    // Selbstverweis bleibt verboten.
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einstellungen.prozess_entwerfen',
        {
          parameter: {
            code: 'einkauf_wareneingang_rechnung',
            name: 'Einkauf rekursiv',
            bereich: 'einkauf',
            schritte: [
              { code: 'start', name: 'Start', art: 'start' },
              {
                code: 'selbst', name: 'Selbst', art: 'prozess',
                teilprozess: 'einkauf_wareneingang_rechnung',
              },
              { code: 'ende', name: 'Ende', art: 'ende' },
            ],
            uebergaenge: [
              { von: 'start', nach: 'selbst' },
              { von: 'selbst', nach: 'ende' },
            ],
          },
        },
        admin,
      ),
      /eigener Teilprozess/,
    )
  })
})
