import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Plural statt Klammer-Plural (F5, Entscheidungslog 2026-10-17): „3
 * Positionen", „1 Fertigungsauftrag" — nie „Position(en)",
 * „Fertigungsauftrag/-aufträge". Im Code plural(n, eins, viele) aus
 * format.ts, in SQL plural_text(n, eins, viele) (0128). Kommentare zählen
 * nicht; Funktionsaufrufe wie `istBuero(n)` sind keine Plurale.
 */

const SRC = new URL('../src', import.meta.url).pathname
const KLAMMER = /(?<![\wÄÖÜäöüß])[A-ZÄÖÜ][\wäöüßÄÖÜ-]*[a-zäöüß]\((en|n|e|s|er)\)/
const SCHRAEG = /[a-zäöüß]\/-[a-zäöüß]/
/** Bezeichner, die wie ein Wort mit Klammer aussehen, aber Aufrufe sind. */
const AUFRUFE = /\b(Number|String|Boolean|Date|Error|Promise|Set|Map|Array|Object|JSON|Math)\(/

function istKommentar(zeile: string): boolean {
  return /^\s*(\/\/|\*|\/\*|--)/.test(zeile)
}

describe('Plural statt Klammer-Plural', () => {
  test('keine Klammer- oder Schrägstrich-Plurale im Code', () => {
    const dateien = (pfad: string): string[] =>
      readdirSync(pfad).flatMap((e) => {
        const voll = join(pfad, e)
        if (statSync(voll).isDirectory()) return e === 'migrations' ? [] : dateien(voll)
        return /\.tsx?$/.test(e) ? [voll] : []
      })
    const treffer: string[] = []
    for (const datei of dateien(SRC)) {
      readFileSync(datei, 'utf8').split('\n').forEach((zeile, i) => {
        if (istKommentar(zeile)) return
        const ohneAufrufe = zeile.replace(new RegExp(AUFRUFE.source, 'g'), '')
        if (KLAMMER.test(ohneAufrufe) || SCHRAEG.test(zeile)) treffer.push(`${relative(SRC, datei)}:${i + 1}: ${zeile.trim()}`)
      })
    }
    assert.deepEqual(treffer, [], `plural(n, eins, viele) aus format.ts nutzen:\n${treffer.join('\n')}`)
  })

  test('keine Klammer-Plurale in der jeweils neuesten SQL-Funktion', () => {
    const verzeichnis = join(SRC, 'db/migrations')
    const neueste = new Map<string, { datei: string; text: string }>()
    for (const datei of readdirSync(verzeichnis).filter((d) => d.endsWith('.sql')).sort()) {
      const s = readFileSync(join(verzeichnis, datei), 'utf8')
      for (const m of s.matchAll(/create (?:or replace )?function (\w+)\s*\(/g)) {
        const auf = s.indexOf('$$', m.index)
        const zu = s.indexOf('$$', auf + 2)
        neueste.set(m[1], { datei, text: s.slice(m.index, s.indexOf(';', zu) + 1) })
      }
    }
    const treffer: string[] = []
    for (const [name, { datei, text }] of neueste) {
      for (const zeile of text.split('\n')) {
        if (!istKommentar(zeile) && (KLAMMER.test(zeile) || SCHRAEG.test(zeile))) treffer.push(`${name} (${datei}): ${zeile.trim()}`)
      }
    }
    assert.deepEqual(treffer, [], `plural_text(n, eins, viele) nutzen:\n${treffer.join('\n')}`)
  })
})
