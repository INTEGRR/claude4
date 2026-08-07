import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Wächter über eine Regel, die man beim Schreiben leicht vergisst:
 *
 * Next.js schwärzt in Produktionsbauten jeden Fehler, der aus einer Server
 * Action geworfen wird — beim Benutzer kommt nur noch eine React-Fehlernummer
 * an. Fachliche Meldungen ("Erledigte Transfers können nicht storniert
 * werden") müssen deshalb **zurückgegeben** werden: actionError(...) bzw.
 * actionFail(err). Diese Prüfung fällt sofort auf, wenn wieder jemand wirft.
 */

const WURZEL = new URL('../src/app', import.meta.url).pathname

function dateienUnter(pfad: string): string[] {
  const treffer: string[] = []
  for (const eintrag of readdirSync(pfad)) {
    const voll = join(pfad, eintrag)
    if (statSync(voll).isDirectory()) treffer.push(...dateienUnter(voll))
    else if (/\.tsx?$/.test(eintrag)) treffer.push(voll)
  }
  return treffer
}

describe('Server Actions', () => {
  test('werfen keine fachlichen Fehler, sondern geben sie zurück', () => {
    const verstoesse: string[] = []

    for (const datei of dateienUnter(WURZEL)) {
      const inhalt = readFileSync(datei, 'utf8')
      if (!inhalt.includes("'use server'")) continue

      inhalt.split('\n').forEach((zeile, i) => {
        if (/\bthrow new Error\(/.test(zeile)) {
          verstoesse.push(`${datei.replace(WURZEL, 'src/app')}:${i + 1}  ${zeile.trim()}`)
        }
      })
    }

    assert.deepEqual(
      verstoesse,
      [],
      'Statt zu werfen: `return actionError("…")` bzw. `return actionFail(err)` ' +
        'aus @/modules/shared/action — sonst sieht der Benutzer im Produktionsbau ' +
        `nur eine React-Fehlernummer.\n${verstoesse.join('\n')}`,
    )
  })

  test('die Oberfläche prüft Rückgabewerte auf Fehler', () => {
    const komponente = readFileSync(
      new URL('../src/components/action-button.tsx', import.meta.url).pathname,
      'utf8',
    )
    const treffer = komponente.match(/isActionError\(/g) ?? []
    assert.ok(
      treffer.length >= 2,
      'ActionButton und ActionForm müssen beide auf zurückgegebene Fehler prüfen',
    )
  })
})
