import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Querverweis-Wächter (Entscheidungslog 2026-10-01, „Querverweise überall"):
 * Wo in einer Tabelle ein Kunde, Lieferant oder eine Belegnummer steht, führt
 * ein Klick dorthin. Eine Zelle, die nur den Namen oder die Nummer als Text
 * zeigt (`<td>{x.partner_name}</td>`), ist eine Sackgasse — neue Seiten
 * dürfen keine mehr bauen.
 *
 * Erkannt wird das einfache Muster „Zelle = genau ein Feld, ohne Link". Wer
 * bewusst keinen Link setzt, trägt die Stelle mit Begründung in AUSNAHMEN
 * ein — die Liste ist geschlossen: ein Eintrag, der nicht mehr trifft, macht
 * die Suite ebenfalls rot.
 */

const WURZEL = new URL('..', import.meta.url).pathname
/** Seiten der App und die Bausteine, die sie einbetten. */
const ORTE = ['src/app/(erp)', 'src/components'].map((o) => join(WURZEL, o))

const NAMEN = [
  'partner_name', 'customer_name', 'vendor_name', 'kunde_name', 'lieferant_name',
  'partner', 'kunde', 'customer', 'vendor', 'lieferant',
]
const NUMMERN = [
  'number', 'nummer', 'po_number', 'so_number', 'picking_number', 'mo_number',
  'order_number', 'rma_number', 'beleg_nummer', 'origin',
]

/** `<td …>{zeile.feld}</td>` bzw. mit `?? '—'`, auch über Zeilenumbrüche. */
const ZELLE = new RegExp(
  String.raw`<td[^>]*>\s*\{[a-zA-Z_]+\.(` + [...NAMEN, ...NUMMERN].join('|') +
    String.raw`)(?:\s*\?\?\s*'[^']*')?\}\s*</td>`,
  'g',
)

/**
 * Bewusst ohne Link — Datei (relativ zum Repo) und Feld, mit Grund.
 * Nur aufnehmen, was wirklich kein Ziel hat.
 */
const AUSNAHMEN: { datei: string; feld: string; grund: string }[] = [
  // Derzeit keine — jede Zelle hat ein Ziel. Eintragsform:
  // { datei: 'src/app/(erp)/…/page.tsx', feld: 'number', grund: 'warum hier kein Link' },
]

function tsxDateien(pfad: string): string[] {
  const treffer: string[] = []
  for (const eintrag of readdirSync(pfad)) {
    const voll = join(pfad, eintrag)
    if (statSync(voll).isDirectory()) treffer.push(...tsxDateien(voll))
    else if (eintrag.endsWith('.tsx')) treffer.push(voll)
  }
  return treffer
}

function sackgassen(): { datei: string; feld: string; zeile: number }[] {
  const funde: { datei: string; feld: string; zeile: number }[] = []
  for (const datei of ORTE.flatMap(tsxDateien)) {
    const text = readFileSync(datei, 'utf8')
    for (const m of text.matchAll(ZELLE)) {
      funde.push({
        datei: relative(WURZEL, datei),
        feld: m[1],
        zeile: text.slice(0, m.index).split('\n').length,
      })
    }
  }
  return funde
}

describe('Querverweis-Wächter: Namen und Belegnummern sind klickbar', () => {
  const funde = sackgassen()
  const ausnahme = (f: { datei: string; feld: string }) =>
    AUSNAHMEN.some((a) => a.datei === f.datei && a.feld === f.feld)

  test('keine Tabellenzelle zeigt Kunde, Lieferant oder Belegnummer ohne Link', () => {
    const offen = funde.filter((f) => !ausnahme(f))
    assert.deepEqual(
      offen.map((f) => `${f.datei}:${f.zeile} {….${f.feld}}`),
      [],
      'Sackgasse: Namen verlinken auf /kontakte/<id> (Lieferanten im Einkauf auf ' +
        '/einkauf/lieferanten/<id>), Belegnummern auf ihre Detailseite — oder die ' +
        'Stelle mit Grund in AUSNAHMEN aufnehmen.',
    )
  })

  test('jede Ausnahme trifft noch (die Liste bleibt geschlossen)', () => {
    for (const a of AUSNAHMEN) {
      assert.ok(
        funde.some((f) => f.datei === a.datei && f.feld === a.feld),
        `Ausnahme ${a.datei} {….${a.feld}} trifft nicht mehr — aus AUSNAHMEN streichen.`,
      )
    }
  })

  test('der Wächter sieht die Seiten überhaupt', () => {
    for (const ort of ORTE) assert.ok(tsxDateien(ort).length > 20, relative(WURZEL, ort))
  })
})
