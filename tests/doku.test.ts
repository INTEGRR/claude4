import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Doku-Wächter: die Dokumentation muss ZUSAMMENHÄNGEN und aktuell bleiben.
 * Erzwingbar ist die Struktur — und genau die wird hier erzwungen:
 *
 * 1. Jede Doku-Datei ist in der Landkarte (docs/README.md) verlinkt —
 *    neue Doku ohne Index-Eintrag macht die Suite rot (Muster wie der
 *    Schema-Doku-Wächter in ki.test.ts).
 * 2. Kein Link in der Landkarte zeigt ins Leere.
 * 3. Das Entscheidungslog hat datierte Einträge im festen Format.
 * 4. Die Doku-Pflicht selbst steht in der AGENTS.md — sie darf beim
 *    nächsten Umbau nicht verloren gehen.
 */

const DOCS = new URL('../docs', import.meta.url).pathname
const WURZEL = new URL('..', import.meta.url).pathname

function markdownDateien(pfad: string): string[] {
  const treffer: string[] = []
  for (const eintrag of readdirSync(pfad)) {
    const voll = join(pfad, eintrag)
    if (statSync(voll).isDirectory()) treffer.push(...markdownDateien(voll))
    else if (eintrag.endsWith('.md')) treffer.push(voll)
  }
  return treffer
}

/** Alle relativen Markdown-Link-Ziele aus einem Dokument. */
function linkZiele(markdown: string): string[] {
  return [...markdown.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)]
    .map((m) => m[1])
    .filter((ziel) => !/^[a-z]+:\/\//.test(ziel))
}

describe('Doku-Wächter: Landkarte, Links, Entscheidungslog', () => {
  const landkarte = readFileSync(join(DOCS, 'README.md'), 'utf8')

  test('jede Doku-Datei ist in der Landkarte verlinkt', () => {
    const dateien = markdownDateien(DOCS)
      .map((f) => relative(DOCS, f))
      .filter((f) => f !== 'README.md')
    for (const datei of dateien) {
      assert.ok(
        landkarte.includes(`](${datei})`),
        `docs/${datei} fehlt in der Landkarte docs/README.md — ` +
          `neue Doku wird dort verlinkt (AGENTS.md, Doku-Pflicht).`,
      )
    }
  })

  test('kein Link der Landkarte zeigt ins Leere', () => {
    for (const ziel of linkZiele(landkarte)) {
      const voll = join(DOCS, ziel)
      assert.ok(
        (() => {
          try {
            statSync(voll)
            return true
          } catch {
            return false
          }
        })(),
        `Landkarten-Link „${ziel}" zeigt auf keine Datei.`,
      )
    }
  })

  test('das Entscheidungslog hat ausschließlich datierte Einträge', () => {
    const log = readFileSync(join(DOCS, 'entscheidungen.md'), 'utf8')
    const eintraege = [...log.matchAll(/^## (.+)$/gm)].map((m) => m[1])
    assert.ok(eintraege.length >= 10, 'das Log ist rückwirkend befüllt')
    for (const titel of eintraege) {
      assert.match(
        titel,
        /^\d{4}-\d{2}-\d{2} — .{5,}/,
        `Eintrag „${titel}" folgt nicht dem Format "JJJJ-MM-TT — Titel".`,
      )
    }
  })

  test('die Doku-Pflicht steht in der AGENTS.md (außerhalb des Next-Blocks)', () => {
    const agents = readFileSync(join(WURZEL, 'AGENTS.md'), 'utf8')
    const eigenerTeil = agents.split('<!-- END:nextjs-agent-rules -->')[1] ?? ''
    assert.ok(eigenerTeil.includes('Doku-Pflicht'), 'Abschnitt „Doku-Pflicht" fehlt')
    assert.ok(eigenerTeil.includes('docs/entscheidungen.md'), 'Verweis aufs Entscheidungslog fehlt')
    assert.ok(eigenerTeil.includes('docs/README.md'), 'Verweis auf die Landkarte fehlt')
  })
})
