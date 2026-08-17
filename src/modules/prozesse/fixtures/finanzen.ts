import assert from 'node:assert/strict'
import type { ProzessFixture } from './typen.ts'

/**
 * Fixkosten-Vertrag end-to-end: anlegen (aktiv) → fristgerecht kündigen
 * (gekuendigt). Die Kündigungs-Mathematik selbst (rollierende Laufzeit,
 * Frist-Validierung) prüft tests/finanzen.test.ts im Detail — hier läuft
 * der PROZESS durch den Torwächter.
 */
export const FINANZEN_VERTRAG: ProzessFixture = {
  prozess: 'vertrag_fixkosten',
  benoetigt: ['basis'],
  aufbauen: async () => {},
  laeufe: [
    {
      name: 'Lizenzvertrag anlegen und fristgerecht kündigen',
      pfad: ['anlegen', 'kuendigen'],
      eingaben: {
        anlegen: {
          name: 'Prozesstest-Lizenz',
          kategorie: 'lizenzen',
          betrag: 49.9,
          waehrung: 'EUR',
          intervall: 'monatlich',
          zahltag: 1,
          // Unbefristet ohne Mindestlaufzeit: jederzeit zum Monatsende
          // kündbar — der Prozesstest braucht keinen Kalendertrick.
          beginn: '2026-01-01',
          kuendigungsfrist_monate: 0,
        },
        // Ohne Datum: zum nächstmöglichen Termin.
        kuendigen: {},
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, vertragId) => {
        const [v] = await sql<
          { nummer: string; status: string; gekuendigt_zum: string | null }[]
        >`select nummer, status, gekuendigt_zum from vertraege where id = ${vertragId}`
        assert.match(v.nummer, /^VT\//)
        assert.equal(v.status, 'gekuendigt')
        assert.ok(v.gekuendigt_zum, 'Kündigungstermin ist gesetzt')
      },
    },
  ],
}
