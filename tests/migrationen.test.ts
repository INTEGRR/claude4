import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Migrations-Wächter: Migrationen sind der einzige Schreibweg, der am
 * Torwächter vorbei in die Daten führt — und im Kundenbetrieb laufen sie
 * unbeaufsichtigt beim Deploy. Destruktive Statements (drop, truncate,
 * delete) sind deshalb nur mit ausdrücklicher Begründung erlaubt:
 *
 *   -- DESTRUKTIV: <warum das hier gefahrlos ist>
 *
 * Regel dazu (Expand-Contract): neue Struktur zuerst anlegen und befüllen,
 * Altes erst Releases später wegräumen — nie beides im selben Deploy.
 * Funktionskörper ($$-Quotes) sind ausgenommen: was dort steht, läuft nicht
 * beim Einspielen, sondern erst beim Aufruf (Storno-Helfer, Housekeeping).
 */

const MIGRATIONS_DIR = new URL('../src/db/migrations', import.meta.url).pathname

const MUSTER: [RegExp, string][] = [
  [/\btruncate\s/i, 'truncate'],
  [/\bdrop\s+table\b/i, 'drop table'],
  [/\bdrop\s+schema\b/i, 'drop schema'],
  [/\bdrop\s+column\b/i, 'drop column'],
  [/\bdelete\s+from\b/i, 'delete from'],
  // Nachgetragen: diese fünf waren dem Wächter entgangen, obwohl sie im
  // Bestand vorkommen. Folge: der DESTRUKTIV-Marker stand in KEINER der 65
  // Migrationen — der Wächter lief seit seiner Einführung leer durch und
  // wirkte dabei grün. Ein Constraint oder Trigger, der beim Deploy fällt,
  // kann genauso Daten unbrauchbar machen wie eine gelöschte Spalte.
  [/\bdrop\s+constraint\b/i, 'drop constraint'],
  [/\bdrop\s+trigger\b/i, 'drop trigger'],
  [/\bdrop\s+function\b/i, 'drop function'],
  [/\bdrop\s+(?:materialized\s+)?view\b/i, 'drop view'],
  [/\balter\s+column\s+\S+\s+type\b/i, 'alter column type'],
]

/**
 * Altlasten von VOR dem Wächter — abgeschlossene Liste, die nie wächst.
 * Neue destruktive Migrationen brauchen den DESTRUKTIV-Marker.
 */
const ALTLASTEN = new Set([
  // drop column kleinpaket_max_qty — vom packagings-Modell ersetzt; lief
  // lange vor dem Wächter und vor jedem Kundenbetrieb.
  '0033_kartonagen.sql',

  // --- Nachtrag beim Schärfen des Wächters -------------------------------
  // Diese sechs enthalten destruktive Statements, die die Musterliste bis
  // jetzt NICHT kannte (drop trigger/function/constraint). Sie sind bereits
  // eingespielt und Migrationen sind über Prüfsummen unveränderlich — der
  // Marker lässt sich also nicht mehr nachtragen, ohne jede bestehende
  // Instanz zu brechen. Sie stehen deshalb hier, und der Ehrlichkeits-Test
  // unten hält die Liste sauber. Alle sechs ersetzen jeweils ihr eigenes
  // Vorgänger-Objekt im selben Deploy (Trigger/Funktion neu definiert,
  // Check-Constraint erweitert) — kein Datenverlust.
  '0017_lots.sql',                      // drop function (Signaturwechsel)
  '0026_nummernkreise.sql',             // drop trigger (durch Sequenzen ersetzt)
  '0030_inventar_sofort.sql',           // drop trigger (Neudefinition)
  '0054_beschaffung_moq.sql',           // drop function (Signaturwechsel)
  '0059_finanzen_vertraege.sql',        // drop constraint (Check erweitert)
  '0060_finanzen_darlehen_steuern.sql', // drop constraint (Check erweitert)
])

/** Destruktive Statements außerhalb von Funktionskörpern und Kommentaren. */
function destruktiveStatements(sqlText: string): string[] {
  const ohneFunktionen = sqlText.replace(/\$([a-zA-Z_]*)\$[\s\S]*?\$\1\$/g, '')
  const ohneKommentare = ohneFunktionen.replace(/--[^\n]*/g, '')
  return MUSTER.filter(([re]) => re.test(ohneKommentare)).map(([, name]) => name)
}

/**
 * Ein Marker gilt nur für das, was in seiner Nähe steht — sonst würde eine
 * einzige Begründung am Dateikopf beliebig viele destruktive Statements
 * weiter unten decken. Verlangt wird deshalb: mindestens so viele Marker wie
 * verschiedene destruktive Statement-Arten in der Datei.
 */
function hatBegruendung(sqlText: string, anzahlArten: number): boolean {
  const marker = sqlText.match(/--\s*DESTRUKTIV:\s*\S.{9,}/g) ?? []
  return marker.length >= anzahlArten
}

describe('Migrations-Wächter: destruktive DDL nur mit Begründung', () => {
  const dateien = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  test('es gibt Migrationen zu prüfen', () => {
    assert.ok(dateien.length > 60)
  })

  test('jede destruktive Migration trägt eine DESTRUKTIV-Begründung', () => {
    for (const datei of dateien) {
      const body = readFileSync(join(MIGRATIONS_DIR, datei), 'utf8')
      const treffer = destruktiveStatements(body)
      if (treffer.length === 0 || ALTLASTEN.has(datei)) continue
      assert.ok(
        hatBegruendung(body, treffer.length),
        `${datei} enthält „${treffer.join(', ')}" ohne DESTRUKTIV-Begründung. ` +
          `Entweder Expand-Contract fahren (Altes erst Releases später wegräumen) ` +
          `oder mit "-- DESTRUKTIV: <warum gefahrlos>" begründen.`,
      )
    }
  })

  test('die Altlasten-Liste bleibt ehrlich (jeder Eintrag trifft noch)', () => {
    for (const datei of ALTLASTEN) {
      const body = readFileSync(join(MIGRATIONS_DIR, datei), 'utf8')
      assert.ok(
        destruktiveStatements(body).length > 0,
        `${datei} steht in ALTLASTEN, enthält aber nichts Destruktives mehr — Eintrag entfernen.`,
      )
    }
  })

  test('der Scanner erkennt Statements, ignoriert Funktionskörper und Kommentare', () => {
    assert.deepEqual(destruktiveStatements('alter table x drop column y;'), ['drop column'])
    assert.deepEqual(destruktiveStatements('truncate table x;'), ['truncate'])
    assert.deepEqual(destruktiveStatements('delete from x where y;'), ['delete from'])
    // In Funktionskörpern erlaubt — läuft nicht beim Einspielen.
    assert.deepEqual(
      destruktiveStatements(
        `create function f() returns void language plpgsql as $$
         begin delete from x; truncate y; end $$;`,
      ),
      [],
    )
    // Auch mit benanntem Dollar-Tag.
    assert.deepEqual(
      destruktiveStatements(`create function f() as $fn$ delete from x; $fn$;`),
      [],
    )
    // Prosa in Kommentaren zählt nicht.
    assert.deepEqual(destruktiveStatements('-- hier wird nichts per delete from entfernt\nselect 1;'), [])
    // Der Marker braucht eine echte Begründung.
    assert.ok(!hatBegruendung('-- DESTRUKTIV:', 1))
    assert.ok(hatBegruendung('-- DESTRUKTIV: Spalte war nie befüllt, Feature kam nie in Prod.', 1))
    // Ein Marker deckt nicht zwei verschiedene destruktive Arten.
    assert.ok(!hatBegruendung('-- DESTRUKTIV: nur einer, aber zwei Arten drin.', 2))
  })
})
