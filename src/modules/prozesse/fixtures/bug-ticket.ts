import assert from 'node:assert/strict'
import type { ProzessFixture } from './typen.ts'

/**
 * Der Prozess, der den Bug-Loop trägt: melden → übernehmen → beheben bzw.
 * verwerfen. Braucht keine Stammdaten — ein Ticket entsteht aus dem Nichts.
 */
export const BUG_TICKET: ProzessFixture = {
  prozess: 'bug_ticket',
  laeufe: [
    {
      name: 'melden → übernehmen → beheben (mit Commit)',
      pfad: ['melden', 'uebernehmen', 'beheben'],
      eingaben: {
        melden: {
          titel: 'Prozesstest: Knopf ohne Wirkung',
          beschreibung: 'Automatisch gemeldet vom Prozesstest-Harness.',
          seite: '/reparatur',
          schwere: 'stoerend',
        },
        // status=behoben kommt aus den Schritt-params der Prozessdefinition.
        beheben: { aufloesung: 'Im Prozesstest behoben.', commit_sha: 'deadbeef' },
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, recordId) => {
        const [ticket] = await sql<
          {
            number: string
            status: string
            aufloesung: string | null
            behoben_am: string | null
            prozess_code: string | null
          }[]
        >`
          select number, status, aufloesung, behoben_am, prozess_code
          from bug_reports where id = ${recordId}`
        assert.equal(ticket.status, 'behoben')
        assert.ok(ticket.aufloesung, 'der Abschlussvermerk muss am Ticket stehen')
        assert.ok(ticket.behoben_am, 'behoben_am muss gesetzt sein')
        // Bug-Loop: die meldende Seite ordnet das Ticket dem Prozess zu …
        assert.equal(ticket.prozess_code, 'reparatur')

        // … und ticket-abschliessen.ts schreibt das Testergebnis samt Commit
        // ans Ticket — hier einmal komplett gegen die Harness-Datenbank.
        const { spawnSync } = await import('node:child_process')
        const lauf = spawnSync(
          process.execPath,
          ['--experimental-strip-types', 'scripts/ticket-abschliessen.ts',
           ticket.number, 'deadbeefcafe4711'],
          { encoding: 'utf8', env: { ...process.env, DIRECT_URL: '' } },
        )
        assert.equal(lauf.status, 0, `ticket-abschliessen scheiterte:\n${lauf.stderr}`)
        const [nachher] = await sql<
          { test_ok: boolean | null; test_commit_sha: string | null }[]
        >`select test_ok, test_commit_sha from bug_reports where id = ${recordId}`
        assert.equal(nachher.test_ok, true)
        assert.equal(nachher.test_commit_sha, 'deadbeefcafe4711')
      },
    },
    {
      name: 'melden → verwerfen (kein Fehler / Duplikat)',
      pfad: ['melden', 'verwerfen'],
      eingaben: {
        melden: { titel: 'Prozesstest: Duplikat', schwere: 'kosmetisch' },
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, recordId) => {
        const [ticket] = await sql<{ status: string }[]>`
          select status from bug_reports where id = ${recordId}`
        assert.equal(ticket.status, 'verworfen')
      },
    },
  ],
}
