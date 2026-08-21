import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Zahlenfelder: `min` und `step` müssen zusammenpassen.
 *
 * Der Browser lässt in einem <input type="number"> nur Werte zu, die sich als
 * `min + k·step` schreiben lassen. Steht dort min=0,01 und step=0,1, sind
 * ausgerechnet die glatten Werte 1 und 0,5 UNGÜLTIG — der Nutzer bekommt
 * „Die zwei nächsten Werte sind 0,91 und 1,01" und kommt nicht weiter. Genau
 * das ist am Feld „Platzbedarf je Stück" passiert, wo 1 und 0,5 im
 * Hilfetext daneben als Beispiele standen.
 *
 * Der Fehler ist unsichtbar, solange niemand einen glatten Wert eintippt —
 * deshalb ein Wächter statt eines Merkzettels.
 */

const WURZEL = new URL('../src', import.meta.url).pathname

function dateien(pfad: string): string[] {
  const treffer: string[] = []
  for (const eintrag of readdirSync(pfad)) {
    const voll = join(pfad, eintrag)
    if (statSync(voll).isDirectory()) treffer.push(...dateien(voll))
    else if (eintrag.endsWith('.tsx')) treffer.push(voll)
  }
  return treffer
}

/** Attributwert, egal ob als {0.1} oder "0.1" geschrieben. */
function zahl(tag: string, name: string): number | null {
  const treffer =
    tag.match(new RegExp(`${name}=\\{([0-9.]+)\\}`)) ??
    tag.match(new RegExp(`${name}="([0-9.]+)"`))
  return treffer ? Number(treffer[1]) : null
}

describe('Zahlenfelder: min und step passen zusammen', () => {
  test('kein Feld sperrt glatte Werte aus', () => {
    const verstoesse: string[] = []
    for (const datei of dateien(WURZEL)) {
      const inhalt = readFileSync(datei, 'utf8')
      for (const treffer of inhalt.matchAll(/<input\b[^>]*type="number"[^>]*>/gs)) {
        const tag = treffer[0]
        const min = zahl(tag, 'min')
        const step = zahl(tag, 'step')
        // Ohne beides oder mit min=0 kann nichts schiefgehen.
        if (min === null || step === null || min === 0) continue
        // min muss ein ganzes Vielfaches von step sein. Als Verhältnis
        // geprüft, damit auch winzige Schritte (Wechselkurse: 1e-8) und
        // Fließkomma-Ungenauigkeiten sauber durchgehen.
        const vielfaches = min / step
        if (Math.abs(vielfaches - Math.round(vielfaches)) > 1e-9) {
          const zeile = inhalt.slice(0, treffer.index).split('\n').length
          const name = tag.match(/name="([^"]+)"/)?.[1] ?? '?'
          verstoesse.push(
            `${datei.replace(WURZEL, 'src')}:${zeile} — Feld „${name}": ` +
              `min=${min} ist kein Vielfaches von step=${step}; glatte Werte sind gesperrt.`,
          )
        }
      }
    }
    assert.deepEqual(verstoesse, [], `\n${verstoesse.join('\n')}`)
  })

  test('der Wächter erkennt die Falle, die es gab — und lässt Gültiges durch', () => {
    const ganzzahlig = (min: number, step: number) =>
      Math.abs(min / step - Math.round(min / step)) <= 1e-9
    // Der echte alte Stand: min 0,01 mit step 0,1 sperrt 1 und 0,5 aus.
    assert.equal(ganzzahlig(0.01, 0.1), false)
    // Die reparierte Fassung und die üblichen unauffälligen Fälle.
    assert.equal(ganzzahlig(0.001, 0.001), true)
    assert.equal(ganzzahlig(0.00000001, 0.00000001), true, 'Wechselkurse mit 1e-8')
    assert.equal(ganzzahlig(0.5, 0.1), true)
  })
})
