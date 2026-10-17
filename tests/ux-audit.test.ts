import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

/**
 * UX-Audit-Wächter: design/ux-audit/befunde.json ist seit dem 17.10.2026 der
 * gepflegte Backlog der Audit-Befunde. Jeder Befund trägt einen Status;
 * erledigt heißt „mit Commit belegt", verworfen heißt „mit Grund" — sonst
 * verliert der Backlog seine Aussagekraft (Muster: Doku-Wächter).
 */

const PFAD = new URL('../design/ux-audit/befunde.json', import.meta.url).pathname
const WURZEL = new URL('..', import.meta.url).pathname

type Befund = { id: string; schwere: string; status: string; commit?: string; grund?: string }
type Seite = { id: string; screenshot: string; befunde: Befund[] }

describe('UX-Audit-Wächter: Backlog in befunde.json', () => {
  const daten = JSON.parse(readFileSync(PFAD, 'utf8')) as { seiten: Seite[] }

  test('jeder Befund hat eine eindeutige ID und einen gültigen Status', () => {
    const ids = new Set<string>()
    for (const seite of daten.seiten) {
      for (const b of seite.befunde) {
        assert.ok(b.id?.startsWith(`${seite.id}#`), `Befund ohne passende ID auf ${seite.id}`)
        assert.ok(!ids.has(b.id), `doppelte Befund-ID ${b.id}`)
        ids.add(b.id)
        assert.ok(['offen', 'erledigt', 'verworfen'].includes(b.status), `${b.id}: Status „${b.status}"`)
        assert.ok(['kritisch', 'hoch', 'mittel', 'niedrig'].includes(b.schwere), `${b.id}: Schwere`)
      }
    }
  })

  test('erledigt braucht einen Commit, verworfen einen Grund', () => {
    for (const seite of daten.seiten) {
      for (const b of seite.befunde) {
        if (b.status === 'erledigt') assert.match(b.commit ?? '', /^[0-9a-f]{7,40}$/, `${b.id}: erledigt ohne Commit`)
        if (b.status === 'verworfen') assert.ok((b.grund ?? '').length > 10, `${b.id}: verworfen ohne Grund`)
      }
    }
  })

  test('jeder Screenshot existiert', () => {
    for (const seite of daten.seiten) {
      assert.ok(existsSync(`${WURZEL}design/ux-audit/${seite.screenshot}`), `${seite.id}: ${seite.screenshot} fehlt`)
    }
  })
})
