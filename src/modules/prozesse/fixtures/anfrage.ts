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
    // prozess_code gesetzt: Das Budget gehört zur Anfrage, nicht zu jedem
    // Vorgang (Migration 0071). Die Eindeutigkeit ist seitdem ein
    // Ausdrucks-Index — ON CONFLICT braucht dieselbe Schreibweise.
    await sql`
      insert into feld_definitionen (modell, prozess_code, name, label, typ)
      values ('vorgang', 'anfrage', 'budget', 'Budget (€)', 'nummer')
      on conflict (modell, (coalesce(prozess_code, '')), name) do nothing`
  },
  laeufe: [
    {
      name: 'Anfrage anbieten, Auftrag anlegen — die Kette zum Fachbeleg',
      pfad: ['anlegen', 'pruefen', 'angebot', 'auftrag'],
      eingaben: {
        // prozess_code kommt aus den Schritt-params der Definition.
        anlegen: (ctx) => ({
          titel: 'Prozesstest Anfrage',
          partner_id: ctx.kundeId,
          zusatz: { budget: 5000 },
        }),
      },
      // Nach „auftrag" wartet der Teilprozess „Auftrag & Lieferung" — der
      // Lauf endet hier bewusst VOR der Abwicklung (die gehört dem
      // Verkaufsprozess und seiner eigenen Fixture).
      pruefen: async (sql, _ctx, vorgangId) => {
        const [v] = await sql<
          { number: string; state: string; zusatz: { budget?: number } }[]
        >`select number, state, zusatz from vorgaenge where id = ${vorgangId}`
        assert.match(v.number, /^VG\//)
        assert.equal(v.state, 'gewonnen', 'der Auftrag-Schritt schaltet den Vorgang')
        assert.equal(Number(v.zusatz.budget), 5000, 'das eigene Feld liegt im zusatz')

        // Das eigene Feld ist ohne Migration prozessfähig: die
        // Bedingungssprache erreicht es über den Pfad zusatz.budget.
        const [bedingung] = await sql<{ ok: boolean }[]>`
          select bedingung_pruefen(
            prozess_beleg_daten('vorgang', ${vorgangId}),
            '{"feld": "zusatz.budget", "op": ">", "wert": 1000}'::jsonb
          ) as ok`
        assert.equal(bedingung.ok, true)

        // Die Fuge zum Fachbeleg (0072): der Auftrag hängt über origin am
        // Vorgang, trägt den Titel als Kundenreferenz — und teilprozess_stand
        // findet ihn, also läuft „Auftrag & Lieferung" im selben Diagramm.
        const [auftrag] = await sql<
          { id: string; client_order_ref: string | null; origin_label: string | null }[]
        >`
          select id, client_order_ref, origin_label from sales_orders
          where origin_model = 'vorgang' and origin_id = ${vorgangId}`
        assert.ok(auftrag, 'der Auftrag muss über origin am Vorgang hängen')
        assert.equal(auftrag.client_order_ref, 'Prozesstest Anfrage')
        assert.equal(auftrag.origin_label, v.number)

        const [stand] = await sql<{ gesamt: number; fertig: number }[]>`
          select gesamt, fertig
          from teilprozess_stand('verkauf', null, 'vorgang', ${vorgangId})`
        assert.equal(Number(stand.gesamt), 1, 'teilprozess_stand findet den Auftrag')
        assert.equal(Number(stand.fertig), 0, 'die Abwicklung steht noch aus')

        // Höchstens EIN Auftrag je Vorgang — der partielle Unique-Index hält.
        await assert.rejects(
          sql`insert into sales_orders (number, partner_id, origin_model, origin_id)
              select next_sequence('sale'), partner_id, 'vorgang', ${vorgangId}
              from sales_orders where id = ${auftrag.id}`,
          /duplicate key|ein_auftrag_je_vorgang/,
        )
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
