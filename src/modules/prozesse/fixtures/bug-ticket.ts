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
          seite: '/lager',
          schwere: 'stoerend',
        },
        // status=behoben kommt aus den Schritt-params der Prozessdefinition.
        beheben: { aufloesung: 'Im Prozesstest behoben.', commit_sha: 'deadbeef' },
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, recordId) => {
        const [ticket] = await sql<
          { status: string; aufloesung: string | null; behoben_am: string | null }[]
        >`select status, aufloesung, behoben_am from bug_reports where id = ${recordId}`
        assert.equal(ticket.status, 'behoben')
        assert.ok(ticket.aufloesung, 'der Abschlussvermerk muss am Ticket stehen')
        assert.ok(ticket.behoben_am, 'behoben_am muss gesetzt sein')
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
