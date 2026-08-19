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
]

/**
 * Altlasten von VOR dem Wächter — abgeschlossene Liste, die nie wächst.
 * Neue destruktive Migrationen brauchen den DESTRUKTIV-Marker.
 */
const ALTLASTEN = new Set([
  // drop column kleinpaket_max_qty — vom packagings-Modell ersetzt; lief
  // lange vor dem Wächter und vor jedem Kundenbetrieb.
  '0033_kartonagen.sql',
])

/** Destruktive Statements außerhalb von Funktionskörpern und Kommentaren. */
function destruktiveStatements(sqlText: string): string[] {
  const ohneFunktionen = sqlText.replace(/\$([a-zA-Z_]*)\$[\s\S]*?\$\1\$/g, '')
  const ohneKommentare = ohneFunktionen.replace(/--[^\n]*/g, '')
  return MUSTER.filter(([re]) => re.test(ohneKommentare)).map(([, name]) => name)
}

function hatBegruendung(sqlText: string): boolean {
  // Marker mit echter Begründung, nicht nur das Schlagwort.
  return /--\s*DESTRUKTIV:\s*\S.{9,}/.test(sqlText)
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
        hatBegruendung(body),
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
    assert.ok(!hatBegruendung('-- DESTRUKTIV:'))
    assert.ok(hatBegruendung('-- DESTRUKTIV: Spalte war nie befüllt, Feature kam nie in Prod.'))
  })
})
