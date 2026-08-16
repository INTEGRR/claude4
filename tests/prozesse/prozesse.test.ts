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
