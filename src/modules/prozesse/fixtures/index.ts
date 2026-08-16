import { ANFRAGE } from './anfrage.ts'
import { ARTIKEL_ANLEGEN } from './artikel-anlegen.ts'
import { BASIS } from './basis.ts'
import { BUG_TICKET } from './bug-ticket.ts'
import { EINKAUF_FIXTURE, LIEFERANTENRECHNUNG_FIXTURE } from './einkauf.ts'
import { FERTIGUNG_FIXTURE } from './fertigung.ts'
import { INVENTUR_FIXTURE } from './inventur.ts'
import { REPARATUR } from './reparatur.ts'
import { SHOPIFY_VERSAND } from './shopify-versand.ts'
import { VERKAUF_FIXTURE } from './verkauf.ts'
import { WARENEINGANG_FIXTURE } from './wareneingang.ts'
import type { ProzessFixture } from './typen.ts'

export type { Eingabe, FixtureKontext, ProzessFixture, ProzessLauf } from './typen.ts'

/**
 * Alle Fixtures. Der Vollständigkeitstest (tests/prozesse/) verlangt für
 * jeden AKTIVEN Prozess in der Datenbank einen Eintrag hier — ein neuer
 * Prozess ohne Fixture macht die Suite rot, der Testdatensatz wächst also
 * zwangsläufig mit den Prozessen mit.
 */
export const FIXTURES = {
  basis: BASIS,
  anfrage: ANFRAGE,
  artikel_anlegen: ARTIKEL_ANLEGEN,
  bug_ticket: BUG_TICKET,
  einkauf_wareneingang_rechnung: EINKAUF_FIXTURE,
  fertigung: FERTIGUNG_FIXTURE,
  inventur: INVENTUR_FIXTURE,
  lieferantenrechnung: LIEFERANTENRECHNUNG_FIXTURE,
  reparatur: REPARATUR,
  shopify_bestellung_versand: SHOPIFY_VERSAND,
  verkauf: VERKAUF_FIXTURE,
  wareneingang: WARENEINGANG_FIXTURE,
} satisfies Record<string, ProzessFixture>

export type FixtureName = keyof typeof FIXTURES

/** Weit getypter Zugriff für Iteration (satisfies hält die Literaltypen eng). */
export function alleFixtures(): [string, ProzessFixture][] {
  return Object.entries(FIXTURES)
}

/**
 * Löst `benoetigt`-Abhängigkeiten topologisch auf: jede Fixture erscheint
 * genau einmal, Abhängigkeiten zuerst. Zyklen fallen sofort auf.
 */
export function fixtureReihenfolge(namen: string[]): string[] {
  const fertig: string[] = []
  const offen = new Set<string>()

  const besuchen = (name: string) => {
    if (fertig.includes(name)) return
    if (offen.has(name)) throw new Error(`Fixture-Zyklus bei „${name}"`)
    const fixture = (FIXTURES as Record<string, ProzessFixture>)[name]
    if (!fixture) throw new Error(`Unbekannte Fixture „${name}"`)
    offen.add(name)
    for (const vorher of fixture.benoetigt ?? []) besuchen(vorher)
    offen.delete(name)
    fertig.push(name)
  }

  for (const name of namen) besuchen(name)
  return fertig
}
