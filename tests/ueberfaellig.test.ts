import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { heuteBerlin, plural, ueberfaellig } from '../src/modules/shared/format.ts'

/**
 * Überfällig-Signal (F4, Entscheidungslog 2026-10-17): eine Regel für
 * „überfällig" — Termin vor heute (Berliner Kalendertag), Beleg nicht
 * erledigt. Der Wächter verbietet selbstgebaute Vergleiche im Code
 * (`new Date(x) < new Date()` war um UTC-Mitternacht schon am Fälligkeitstag
 * „überfällig") und verlangt das Schild in den Listen mit Terminen.
 */

describe('Überfällig — Regel', () => {
  test('Tage seit Termin, null wenn erledigt, ohne Termin oder heute fällig', () => {
    const heute = '2026-10-17'
    assert.equal(ueberfaellig('2026-10-16', false, heute), 1)
    assert.equal(ueberfaellig('2025-10-17', false, heute), 365)
    assert.equal(ueberfaellig('2026-10-17', false, heute), null, 'heute fällig ist nicht überfällig')
    assert.equal(ueberfaellig('2026-10-20', false, heute), null)
    assert.equal(ueberfaellig('2026-10-01', true, heute), null, 'erledigt')
    assert.equal(ueberfaellig(null, false, heute), null)
  })

  test('Zeitstempel zählen nach Berliner Kalendertag', () => {
    // 23:30 Uhr Berlin am 16.10. ist 21:30 UTC — am 17.10. ist das 1 Tag überfällig.
    assert.equal(ueberfaellig('2026-10-16T21:30:00Z', false, '2026-10-17'), 1)
    // 00:30 Uhr Berlin am 17.10. ist noch der 16.10. in UTC — aber Berlin zählt: heute fällig.
    assert.equal(ueberfaellig('2026-10-16T22:30:00Z', false, '2026-10-17'), null)
    assert.equal(heuteBerlin(new Date('2026-10-17T22:30:00Z')), '2026-10-18')
  })

  test('plural', () => {
    assert.equal(plural(1, 'Tag', 'Tage'), '1 Tag')
    assert.equal(plural(12, 'Tag', 'Tage'), '12 Tage')
    assert.equal(plural(1500, 'Position', 'Positionen'), '1.500 Positionen')
  })
})

describe('Überfällig — Wächter', () => {
  const APP = new URL('../src/app', import.meta.url).pathname
  const dateien = (pfad: string): string[] =>
    readdirSync(pfad).flatMap((e) => {
      const voll = join(pfad, e)
      return statSync(voll).isDirectory() ? dateien(voll) : e.endsWith('.tsx') ? [voll] : []
    })

  test('kein selbstgebauter Überfällig-Vergleich im Code', () => {
    const treffer: string[] = []
    for (const datei of dateien(APP)) {
      readFileSync(datei, 'utf8').split('\n').forEach((zeile, i) => {
        if (/new Date\([^)]*\)\s*<\s*new Date\(\)|\b[\w.]+\s*<\s*heute\b/.test(zeile)) {
          treffer.push(`${relative(APP, datei)}:${i + 1}: ${zeile.trim()}`)
        }
      })
    }
    assert.deepEqual(treffer, [], `ueberfaellig() aus format.ts bzw. <Ueberfaellig> nutzen:\n${treffer.join('\n')}`)
  })

  test('die Listen mit Terminen zeigen das Schild', () => {
    const PFLICHT = [
      '(erp)/fertigung/bulk.tsx',
      '(erp)/lager/page.tsx',
      '(erp)/lager/zulauf/page.tsx',
      '(erp)/reparatur/page.tsx',
      '(erp)/finanzen/steuern/page.tsx',
      '(erp)/finanzen/vertraege/page.tsx',
    ]
    const ohne = PFLICHT.filter((rel) => !readFileSync(join(APP, rel), 'utf8').includes('<Ueberfaellig'))
    assert.deepEqual(ohne, [], `ohne <Ueberfaellig>: ${ohne.join(', ')}`)
  })
})
