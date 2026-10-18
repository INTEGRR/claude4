import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Dunkelmodus kommt auf zwei Wegen: ausdrücklich gewählt
 * (`:root[data-theme='dark']`) oder über die System-Einstellung
 * (`@media (prefers-color-scheme: dark)`). Beide Blöcke müssen dieselben
 * Farbvariablen mit denselben Werten setzen — sonst sieht die App je nach
 * Weg anders aus. Gefunden beim Design-System-Abgleich (2026-10-17): der
 * System-Block vergaß `--wichtig*`, Violett blieb hell auf dunklem Grund.
 */

const CSS = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8')

/** Variablen aus allen Blöcken, deren Selektor genau `kopf` ist. */
function variablen(kopf: RegExp): Map<string, string> {
  const werte = new Map<string, string>()
  for (const treffer of CSS.matchAll(kopf)) {
    const start = treffer.index! + treffer[0].length
    const ende = CSS.indexOf('}', start)
    for (const v of CSS.slice(start, ende).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) werte.set(v[1], v[2].trim())
  }
  return werte
}

describe('Theme-Tokens', () => {
  test('ausdrücklicher und System-Dunkelmodus setzen dieselben Variablen mit denselben Werten', () => {
    const gewaehlt = variablen(/^:root\[data-theme='dark'\]\s*\{/gm)
    const system = variablen(/^\s+:root:not\(\[data-theme='light'\]\):not\(\[data-theme='dark'\]\)\s*\{/gm)
    assert.ok(gewaehlt.size > 20, `Dunkel-Block gefunden (${gewaehlt.size} Variablen)`)
    const fehlen = [...gewaehlt.keys()].filter((k) => !system.has(k))
    const zuviel = [...system.keys()].filter((k) => !gewaehlt.has(k))
    assert.deepEqual(fehlen, [], `im System-Dunkelmodus fehlen: ${fehlen.join(', ')}`)
    assert.deepEqual(zuviel, [], `nur im System-Dunkelmodus: ${zuviel.join(', ')}`)
    const anders = [...gewaehlt].filter(([k, v]) => system.get(k) !== v).map(([k]) => k)
    assert.deepEqual(anders, [], `abweichende Werte: ${anders.join(', ')}`)
  })

  /**
   * Kontrast (Entscheidungslog 2026-10-17, KRNL-Stil bleibt): Text erreicht
   * in beiden Themes mindestens 4,5:1 (WCAG AA). Der Audit fand gedämpften
   * Text bei 2,75:1 und Weiß auf Orange bei 3,1:1. Orange-Flächen ohne Text
   * (LED, Balken) bleiben `--accent`; die Primärtaste nutzt `--accent-fill`.
   */
  test('Textfarben erreichen 4,5:1 in hell und dunkel', () => {
    const luminanz = (hex: string): number => {
      const roh = hex.replace('#', '')
      const voll = roh.length === 3 ? [...roh].map((c) => c + c).join('') : roh
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(voll.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const kontrast = (a: string, b: string): number => {
      const [hell, dunkel] = [luminanz(a), luminanz(b)].sort((x, y) => y - x)
      return (hell + 0.05) / (dunkel + 0.05)
    }
    const themes = {
      hell: variablen(/^:root\s*\{/gm),
      dunkel: variablen(/^:root\[data-theme='dark'\]\s*\{/gm),
    }
    const paare: [string, string][] = [
      ...['--text', '--text-2', '--text-muted'].flatMap((t) =>
        ['--bg', '--surface', '--surface-2'].map((g): [string, string] => [t, g])),
      ['#fff', '--accent-fill'],
      ...['--bg', '--surface', '--surface-2', '--accent-soft'].map((g): [string, string] => ['--accent-text', g]),
      ...['success', 'warn', 'danger', 'info'].flatMap((ton) =>
        ['--bg', '--surface', '--surface-2', `--${ton}-soft`].map((g): [string, string] => [`--${ton}`, g])),
      ['--wichtig-kontrast', '--wichtig'],
      ['--display-text', '--display'],
    ]
    const zuSchwach: string[] = []
    for (const [name, v] of Object.entries(themes)) {
      const farbe = (x: string) => (x.startsWith('#') ? x : v.get(x))
      for (const [vorne, hinten] of paare) {
        const a = farbe(vorne)
        const b = farbe(hinten)
        assert.ok(a && b, `${name}: ${vorne} oder ${hinten} fehlt`)
        const k = kontrast(a, b)
        if (k < 4.5) zuSchwach.push(`${name}: ${vorne} auf ${hinten} = ${k.toFixed(2)}:1`)
      }
    }
    assert.deepEqual(zuSchwach, [], `unter 4,5:1:\n${zuSchwach.join('\n')}`)
  })

  /**
   * Satzschreibung (Entscheidungslog 2026-10-18, UX-Audit M8): Beschriftungen,
   * Tabellenköpfe und Statusschilder stehen nicht mehr in gesperrten
   * Mono-Versalien. Versalien bleiben der Marke und dem Instrumenten-Display
   * vorbehalten — geschlossene Liste.
   */
  test('Versalien nur für Marke und Display', () => {
    const ERLAUBT = new Set([
      '.sidebar .brand-sub',
      '.display-panel .display-head',
      '.splash-untertitel',
      '.splash-post-label',
      // Nur der erste Buchstabe — das ist Satzschreibung, keine Versalien.
      '.badge::first-letter',
    ])
    const treffer: string[] = []
    for (const m of CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (!/text-transform:\s*uppercase/.test(m[2])) continue
      const selektor = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim()
      if (!ERLAUBT.has(selektor)) treffer.push(selektor)
    }
    assert.deepEqual(treffer, [], `Versalien außerhalb von Marke/Display:\n${treffer.join('\n')}`)
  })
})
