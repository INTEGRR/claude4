import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gesamtAus, groesseHref, seitenHref, seitenParameter, seitenText, seitenZahlen } from '../src/modules/shared/seiten.ts'

/**
 * Seitenaufteilung (F3, Entscheidungslog 2026-10-17). Die Logik-Tests sichern
 * Parameter, Links und Zähler; der Wächter verbietet Listen-Seiten mit einem
 * harten „limit ≥ 100" ohne Seitenhelfer — der Audit fand Listen, die bei 200
 * Zeilen stumm abschnitten (Fertigung: 316 Aufträge, „Alle" zeigte 200).
 */

describe('Seitenaufteilung — Logik', () => {
  test('seitenParameter: 1-basiert, Unsinn wird Seite 1', () => {
    assert.deepEqual(seitenParameter({}), { seite: 1, groesse: 25, limit: 25, offset: 0 })
    assert.deepEqual(seitenParameter({ seite: '3' }), { seite: 3, groesse: 25, limit: 25, offset: 50 })
    assert.equal(seitenParameter({ seite: '-2' }).seite, 1)
    assert.equal(seitenParameter({ seite: 'abc' }).seite, 1)
    assert.equal(seitenParameter({ seite: ['2', '5'] }).seite, 2)
  })

  test('seitenHref behält die Filter, Seite 1 ohne Parameter', () => {
    assert.equal(seitenHref('/verkauf', { status: 'sale', q: 'Nord', seite: '4' }, 2), '/verkauf?status=sale&q=Nord&seite=2')
    assert.equal(seitenHref('/verkauf', { status: 'sale', seite: '2' }, 1), '/verkauf?status=sale')
    assert.equal(seitenHref('/verkauf', { q: '' }, 1), '/verkauf')
  })

  test('Seitengröße wählbar: 10, 25, 100 — sonst der Standard', () => {
    assert.deepEqual(seitenParameter({ pro: '100', seite: '2' }), { seite: 2, groesse: 100, limit: 100, offset: 100 })
    assert.equal(seitenParameter({ pro: '10' }).groesse, 10)
    assert.equal(seitenParameter({ pro: '37' }).groesse, 25, 'nur die angebotenen Größen')
    assert.equal(seitenParameter({ pro: ['100', '10'] }).groesse, 100)
    assert.equal(groesseHref('/verkauf', { status: 'sale', seite: '4', pro: '10' }, 100), '/verkauf?status=sale&pro=100')
    assert.equal(groesseHref('/verkauf', { status: 'sale', pro: '10' }, 25), '/verkauf?status=sale', 'Standard ohne Parameter, zurück auf Seite 1')
    assert.equal(seitenHref('/verkauf', { pro: '100', seite: '1' }, 2), '/verkauf?pro=100&seite=2', 'Größe bleibt beim Blättern')
  })

  test('Seitenzahlen mit Auslassung', () => {
    assert.deepEqual(seitenZahlen(1, 1), [1])
    assert.deepEqual(seitenZahlen(5, 13), [1, '…', 4, 5, 6, '…', 13])
    assert.deepEqual(seitenZahlen(1, 13), [1, 2, '…', 13])
    assert.deepEqual(seitenZahlen(3, 13), [1, 2, 3, 4, '…', 13], 'eine einzelne Lücke wird zur Zahl')
    assert.deepEqual(seitenZahlen(13, 13), [1, '…', 12, 13])
  })

  test('seitenText: „1–25 von 318", nichts bei einer Seite', () => {
    assert.equal(seitenText(seitenParameter({}), 318), '1–25 von 318')
    assert.equal(seitenText(seitenParameter({ seite: '13' }), 318), '301–318 von 318')
    assert.equal(seitenText(seitenParameter({}), 12), null)
    assert.equal(seitenText(seitenParameter({ seite: '9' }), 0), 'Seite 9 ist leer')
    assert.equal(gesamtAus([{ gesamt: '318' }]), 318)
    assert.equal(gesamtAus([]), 0)
  })
})

describe('Seitenaufteilung — Wächter', () => {
  test('keine Listen-Seite mit hartem limit ≥ 100 ohne Seitenhelfer', () => {
    const APP = new URL('../src/app', import.meta.url).pathname
    /**
     * Geschlossene Liste: Seiten, deren große Abfrage bewusst begrenzt bleibt.
     * Nur mit Begründung erweitern; wer eine davon umbaut, streicht sie.
     */
    const AUSNAHMEN = new Map<string, string>([
      ['(erp)/einstellungen/kartonagen/page.tsx', 'Stammdaten-Auswahl (Kartonagen-Artikel), keine Belegliste'],
      ['(erp)/einstellungen/registrierungen/page.tsx', 'Warteschlange offener Registrierungen, kurz'],
      ['(erp)/sprechen/page.tsx', 'Sprachprotokoll der letzten Läufe (Diagnose), bewusst die jüngsten'],
      ['(erp)/lager/inventur/page.tsx', 'Zählliste der offenen Inventur, wird abgearbeitet'],
      ['(erp)/einkauf/datev/page.tsx', 'DATEV-Vorbereitung eines Zeitraums (auf Hold), Export braucht alle'],
      ['(erp)/einkauf/werkzeuge/[id]/page.tsx', 'Detailseite: Auswahllisten und letzte Schüsse'],
      ['(erp)/einkauf/posteingang/[id]/page.tsx', 'Detailseite: Nachrichten eines Threads'],
      ['(erp)/einkauf/sendungen/[id]/page.tsx', 'Detailseite: Auswahl offener Bestellungen'],
      ['(erp)/einkauf/lieferanten/[id]/page.tsx', 'Detailseite: Preisliste eines Lieferanten'],
      ['(erp)/p/[prozess]/page.tsx', 'Assistenten-Läufe eines Prozesses, jüngste zuerst'],
    ])
    const dateien = (pfad: string): string[] =>
      readdirSync(pfad).flatMap((e) => {
        const voll = join(pfad, e)
        return statSync(voll).isDirectory() ? dateien(voll) : e === 'page.tsx' ? [voll] : []
      })
    const treffer: string[] = []
    for (const datei of dateien(APP)) {
      const rel = relative(APP, datei)
      const text = readFileSync(datei, 'utf8')
      if (text.includes('seitenParameter(') || AUSNAHMEN.has(rel)) continue
      text.split('\n').forEach((zeile, i) => {
        // Auswahllisten (Kunden, Lieferanten, Artikel für Dropdowns) sind keine Listen-Seiten.
        if (/limit [1-9]\d{2,}/.test(zeile) && !/order by (label|name|lower\(name\))/.test(zeile)) {
          treffer.push(`${rel}:${i + 1}: ${zeile.trim()}`)
        }
      })
    }
    assert.deepEqual(treffer, [], `harte Limits ohne Seitenaufteilung (seitenParameter + <Seiten>):\n${treffer.join('\n')}`)
    for (const rel of AUSNAHMEN.keys()) {
      assert.ok(statSync(join(APP, rel), { throwIfNoEntry: false }), `Ausnahme ${rel} gibt es nicht mehr — streichen`)
    }
  })
})
