import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { kurs, money } from '../src/modules/shared/format.ts'
import { closeDb, db } from './helpers.ts'

/**
 * Deutsche Zahlen in Texten (F2, Entscheidungslog 2026-10-17): Beträge und
 * Mengen in Meldungen, Verlauf und Grundlagen erscheinen deutsch — „35,70 €",
 * „1 ×", nicht „35.70 €", „1.0000 ×". Im Code über money/qty/kurs
 * (format.ts), in SQL über money_text/zahl_text (0021/0127).
 */

after(closeDb)

const SRC = new URL('../src', import.meta.url).pathname
const MIGRATIONEN = join(SRC, 'db/migrations')

function dateien(pfad: string): string[] {
  return readdirSync(pfad).flatMap((e) => {
    const voll = join(pfad, e)
    return statSync(voll).isDirectory() ? dateien(voll) : /\.tsx?$/.test(e) ? [voll] : []
  })
}

/** Neueste Definition jeder SQL-Funktion (spätere Migrationen ersetzen frühere). */
function neuesteFunktionen(): Map<string, { datei: string; text: string }> {
  const neueste = new Map<string, { datei: string; text: string }>()
  for (const datei of readdirSync(MIGRATIONEN).filter((d) => d.endsWith('.sql')).sort()) {
    const s = readFileSync(join(MIGRATIONEN, datei), 'utf8')
    for (const m of s.matchAll(/create or replace function (\w+)\s*\(/g)) {
      const auf = s.indexOf('$$', m.index)
      const zu = s.indexOf('$$', auf + 2)
      neueste.set(m[1], { datei, text: s.slice(m.index, s.indexOf(';', zu) + 1) })
    }
  }
  return neueste
}

describe('Deutsche Zahlen in Texten', () => {
  test('zahl_text und money_text formatieren deutsch', async () => {
    const [r] = await db()<Record<string, string>[]>`
      select zahl_text(1.0000) as eins, zahl_text(1234567.5) as gross, zahl_text(-0.25) as neg,
             zahl_text(300, 2) as fest, money_text(35.7) as geld`
    assert.deepEqual(r, { eins: '1', gross: '1.234.567,5', neg: '-0,25', fest: '300,00', geld: '35,70 €' })
    assert.equal(kurs(0.128), '0,1280')
    assert.match(money(35.7), /^35,70\s€$/)
  })

  test('kein toFixed vor einem Euro-Zeichen im Code', () => {
    const treffer: string[] = []
    for (const datei of dateien(SRC)) {
      const text = readFileSync(datei, 'utf8')
      text.split('\n').forEach((zeile, i) => {
        if (/\.toFixed\(\d\)\)?\s*\}\s*€/.test(zeile)) treffer.push(`${relative(SRC, datei)}:${i + 1}`)
      })
    }
    assert.deepEqual(treffer, [], `Geld mit money() formatieren:\n${treffer.join('\n')}`)
  })

  test('SQL-Texte: keine rohen Beträge, kein ortsabhängiges to_char', () => {
    /** Funktionen, deren „%s €" geprüft deutsch befüllt wird (zahl_text mit fester Stellenzahl). */
    const GEPRUEFT = new Set(['eingangs_sendung_schaetzung'])
    const treffer: string[] = []
    for (const [name, { datei, text }] of neuesteFunktionen()) {
      if (/to_char\([^)]*'FM[^']*[GD][^']*'\)/.test(text)) treffer.push(`${name} (${datei}): to_char mit G/D hängt an lc_numeric — zahl_text`)
      if (/%s €/.test(text) && !GEPRUEFT.has(name)) treffer.push(`${name} (${datei}): „%s €" — money_text`)
    }
    assert.deepEqual(treffer, [], treffer.join('\n'))
  })
})
