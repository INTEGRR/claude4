import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

/**
 * Der Seitenkatalog in src/modules/befehle.ts nennt sich selbst „Spiegel der
 * Navigation (layout.tsx)" — dafür gab es bis hierher keinen Wächter. Folge:
 * eine neue Seite oder ein umbenannter Pfad fällt in genau EINEM der beiden
 * Kataloge auf; das Befehlsfeld zeigt dann auf Seiten, die es nicht mehr gibt,
 * oder verschweigt neue. Das widerspricht der eigenen Regel aus AGENTS.md:
 * „Jede Konvention, die immer mitwachsen muss, bekommt einen Wächter-Test."
 *
 * Statisch geprüft (Textanalyse wie tests/prozess-registry.test.ts), damit der
 * Test ohne Datenbank und ohne Pfad-Auflösung läuft.
 */

const WURZEL = new URL('..', import.meta.url).pathname
const lies = (rel: string) => readFileSync(WURZEL + rel, 'utf8')

/** href-Literale aus einer Datei. */
function pfade(inhalt: string): string[] {
  return [...inhalt.matchAll(/href:\s*'([^']+)'/g)].map((t) => t[1])
}

describe('Befehlsfeld spiegelt die Navigation', () => {
  const befehlsPfade = pfade(lies('src/modules/befehle.ts'))
  const navPfade = new Set(pfade(lies('src/app/(erp)/layout.tsx')))

  test('beide Kataloge liefern überhaupt Pfade', () => {
    assert.ok(befehlsPfade.length > 30, `nur ${befehlsPfade.length} Befehlsfeld-Pfade`)
    assert.ok(navPfade.size > 20, `nur ${navPfade.size} Navigations-Pfade`)
  })

  test('jeder Befehlsfeld-Pfad zeigt auf eine echte Seite', () => {
    const tot = befehlsPfade.filter(
      (href) => !existsSync(`${WURZEL}src/app/(erp)${href === '/' ? '' : href}/page.tsx`),
    )
    assert.deepEqual(tot, [], `Befehlsfeld-Pfade ohne page.tsx:\n${tot.join('\n')}`)
  })

  test('jeder Navigations-Pfad zeigt auf eine echte Seite', () => {
    const tot = [...navPfade].filter(
      (href) =>
        href.startsWith('/') &&
        !href.startsWith('/api') &&
        !existsSync(`${WURZEL}src/app/(erp)${href === '/' ? '' : href}/page.tsx`),
    )
    assert.deepEqual(tot, [], `Navigations-Pfade ohne page.tsx:\n${tot.join('\n')}`)
  })

  test('Laufzeit-Prozesse: Menü und Befehlsfeld bauen denselben Pfad', () => {
    // Diese Menüpunkte entstehen zur Laufzeit aus der Datenbank, tragen also
    // ein Template-Literal statt eines Pfad-Literals — die Prüfungen oben
    // sehen sie nicht. Was hier zählt: beide Kataloge bauen DENSELBEN Pfad,
    // und dahinter liegt eine echte Route. Sonst führt genau der Menüpunkt
    // ins Leere, den ein Kunde sich gerade selbst gebaut hat.
    const MUSTER = '/vorgaenge/prozess/${'
    for (const datei of ['src/app/(erp)/layout.tsx', 'src/modules/befehle.ts']) {
      assert.ok(lies(datei).includes(MUSTER), `${datei} baut keinen Laufzeit-Prozess-Pfad mehr`)
    }
    assert.ok(
      existsSync(`${WURZEL}src/app/(erp)/vorgaenge/prozess/[code]/page.tsx`),
      'die Route /vorgaenge/prozess/[code] fehlt',
    )
  })

  test('Menüpunkte fehlen nicht im Befehlsfeld', () => {
    // Umgekehrte Richtung: was im Menü steht, soll auch tippbar sein.
    // Ausnahmen sind Ziele ohne eigenen Katalogeintrag — geschlossene Liste.
    const NUR_MENUE = new Set(['/'])
    const fehlend = [...navPfade].filter(
      (href) => href.startsWith('/') && !NUR_MENUE.has(href) && !befehlsPfade.includes(href),
    )
    assert.deepEqual(fehlend, [],
      `Diese Menüpunkte fehlen im Befehlsfeld (src/modules/befehle.ts):\n${fehlend.join('\n')}`)
  })
})
