/**
 * Die Prozessläufe: jede Fixture spielt ihre Durchläufe über den Torwächter
 * gegen die aktive Prozessversion — ein Befehl beweist, dass die Kernprozesse
 * des Hauses durchgängig funktionieren (siehe laufen.ts).
 */
import test, { after, before, describe } from 'node:test'
import { alleFixtures, fixtureReihenfolge } from '../../src/modules/prozesse/fixtures/index.ts'
import type { FixtureKontext } from '../../src/modules/prozesse/fixtures/typen.ts'
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
