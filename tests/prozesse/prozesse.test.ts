/**
 * Die Prozessläufe: jede Fixture spielt ihre Durchläufe über den Torwächter
 * gegen die aktive Prozessversion — ein Befehl beweist, dass die Kernprozesse
 * des Hauses durchgängig funktionieren (siehe laufen.ts).
 */
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

  test('Unfug scheitert: unbekannte Aktion sofort, Strukturfehler bei der Aktivierung', async () => {
    // Unbekannte Aktionsnamen fängt schon der Entwurf ab.
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

    // Ein nicht erreichbarer Schritt darf als Entwurf existieren — die harte
    // Validierung sitzt im Aktivieren und lehnt ab.
    await aktionAusfuehrenGeprueft(
      'einstellungen.prozess_entwerfen',
      {
        parameter: {
          ...ENTWURF,
          code: 'kaputt',
          name: 'Kaputter Entwurf',
          schritte: ENTWURF.schritte.map((s) =>
            s.code === 'annehmen' ? { ...s, params: { prozess_code: 'kaputt' } } : s,
          ),
          uebergaenge: ENTWURF.uebergaenge.filter((u) => u.nach !== 'erstatten'),
        },
      },
      admin,
    )
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
})
