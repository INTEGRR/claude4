import type { Sql } from 'postgres'
import type { Role } from '../../auth/permissions.ts'

/**
 * Prozess-Fixtures: der mit den Prozessen versionierte Testdatensatz.
 *
 * Je Prozess ein Modul, das (a) die nötigen Stammdaten aufbaut und (b) die
 * Durchläufe beschreibt — welche Schritte in welcher Reihenfolge, mit welchen
 * Eingaben. Zwei Abnehmer teilen sich diese Daten:
 *
 *  - der Prozesstest-Harness (tests/prozesse/) spielt die Läufe automatisiert
 *    über den Torwächter durch,
 *  - scripts/prozessdaten.ts baut denselben Grundbestand in einer
 *    Staging-Datenbank auf, damit dort jeder Bugfix durchgespielt werden kann.
 *
 * Deshalb leben die Fixtures unter src/ (nicht tests/) und bleiben frei von
 * Server-Imports: nur `sql` rein, Daten raus. Aufbau-Funktionen müssen
 * WIEDERHOLBAR sein (finden statt doppelt anlegen) — Staging wird nicht vor
 * jedem Lauf plattgemacht.
 */

/** Vom Aufbau gefüllte IDs (kundeId, geraetId, …), von den Läufen verwendet. */
export type FixtureKontext = Record<string, string>

/** Eingabe eines Schritts: fertige Parameter oder eine Funktion über den Kontext. */
export type Eingabe =
  | Record<string, unknown>
  | ((ctx: FixtureKontext) => Record<string, unknown>)

export interface ProzessLauf {
  /** Was dieser Durchlauf zeigt (wird Testname). */
  name: string
  /** Wer klickt — Standard: ein Administrator. */
  nutzer?: { name: string; role: Role }
  /** Die Schritt-Codes in Ausführungsreihenfolge (nur art='aktion'). */
  pfad: string[]
  /** Eingaben je Schritt-Code; Schritt-params aus der Prozessdefinition werden vorgelegt. */
  eingaben?: Record<string, Eingabe>
  /** Nach dem letzten Schritt darf der Prozess nichts mehr anbieten (Endzustand). */
  danachKeineSchritte?: boolean
  /** Zusätzliche fachliche Prüfungen nach dem Durchlauf. */
  pruefen?: (sql: Sql, ctx: FixtureKontext, recordId: string) => Promise<void>
}

export interface ProzessFixture {
  /** Prozess-Code aus der Datenbank — null für reine Daten-Fixtures ('basis'). */
  prozess: string | null
  /** Fixtures, die vorher aufgebaut sein müssen (topologisch aufgelöst). */
  benoetigt?: string[]
  /** Baut Stammdaten/Bestand auf und füllt den Kontext. Muss wiederholbar sein. */
  aufbauen?: (sql: Sql, ctx: FixtureKontext) => Promise<void>
  laeufe?: ProzessLauf[]
}
