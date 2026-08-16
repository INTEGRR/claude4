import assert from 'node:assert/strict'
import type { ProzessFixture } from './typen.ts'

/**
 * Der Chamäleon-Beweis: ein reiner LAUFZEIT-Prozess auf generischen
 * Vorgängen — kein Enum, keine Fachtabelle — läuft end-to-end durch den
 * Prozesstest. Dazu ein eigenes Feld (budget), das ohne Migration in der
 * Maske erscheint und sofort in der Bedingungssprache erreichbar ist.
 */
export const ANFRAGE: ProzessFixture = {
  prozess: 'anfrage',
  benoetigt: ['basis'],
  aufbauen: async (sql) => {
    await sql`
      insert into feld_definitionen (modell, name, label, typ)
      values ('vorgang', 'budget', 'Budget (€)', 'nummer')
      on conflict (modell, name) do nothing`
  },
  laeufe: [
    {
      name: 'Anfrage prüfen und anbieten — mit eigenem Feld',
      pfad: ['anlegen', 'pruefen', 'angebot'],
      eingaben: {
        // prozess_code kommt aus den Schritt-params der Definition.
        anlegen: (ctx) => ({
          titel: 'Prozesstest Anfrage',
          partner_id: ctx.kundeId,
          zusatz: { budget: 5000 },
        }),
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, vorgangId) => {
        const [v] = await sql<
          { number: string; state: string; zusatz: { budget?: number } }[]
        >`select number, state, zusatz from vorgaenge where id = ${vorgangId}`
        assert.match(v.number, /^VG\//)
        assert.equal(v.state, 'angeboten')
        assert.equal(Number(v.zusatz.budget), 5000, 'das eigene Feld liegt im zusatz')

        // Das eigene Feld ist ohne Migration prozessfähig: die
        // Bedingungssprache erreicht es über den Pfad zusatz.budget.
        const [bedingung] = await sql<{ ok: boolean }[]>`
          select bedingung_pruefen(
            prozess_beleg_daten('vorgang', ${vorgangId}),
            '{"feld": "zusatz.budget", "op": ">", "wert": 1000}'::jsonb
          ) as ok`
        assert.equal(bedingung.ok, true)
      },
    },
    {
      name: 'Anfrage ablehnen',
      pfad: ['anlegen', 'pruefen', 'ablehnen'],
      eingaben: {
        anlegen: { titel: 'Prozesstest Absage' },
        ablehnen: { vermerk: 'Passt nicht ins Sortiment.' },
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, vorgangId) => {
        const [v] = await sql<{ state: string }[]>`
          select state from vorgaenge where id = ${vorgangId}`
        assert.equal(v.state, 'abgelehnt')
      },
    },
  ],
}
