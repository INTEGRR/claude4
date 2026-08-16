import assert from 'node:assert/strict'
import type { ProzessFixture } from './typen.ts'

/**
 * P: Inventur — der Beweis für beleggebundene FOLGESCHRITTE im Assistenten:
 * „zaehlen" erzeugt die Zählung (Beleg), „buchen" arbeitet ohne explizite
 * record_id auf genau diesem Beleg weiter (beleg_id aus der Instanz).
 */
export const INVENTUR_FIXTURE: ProzessFixture = {
  prozess: 'inventur',
  benoetigt: ['basis'],
  laeufe: [
    {
      name: 'zählen, Differenz buchen — der Bestand folgt der Zählung',
      pfad: ['zaehlen', 'buchen'],
      eingaben: {
        zaehlen: async (ctx, sql) => {
          // Ist-Bestand + 3: die Differenz ist garantiert ungleich null.
          const [{ qty }] = await sql<{ qty: number }[]>`
            select coalesce(on_hand_qty(${ctx.teilId}, null), 0)::float as qty`
          ctx.inventur_soll = String(Number(qty) + 3)
          return { variant_id: ctx.teilId, counted_qty: Number(qty) + 3 }
        },
      },
      danachKeineSchritte: true,
      pruefen: async (sql, ctx) => {
        // Die Zählung ist angewandt …
        const [zaehlung] = await sql<{ applied_at: string | null }[]>`
          select applied_at from inventory_counts
          where variant_id = ${ctx.teilId}
          order by created_at desc limit 1`
        assert.ok(zaehlung.applied_at, 'die Zählung muss gebucht sein')

        // … und der Bestand steht exakt auf dem gezählten Wert.
        const [{ qty }] = await sql<{ qty: number }[]>`
          select coalesce(on_hand_qty(${ctx.teilId}, null), 0)::float as qty`
        assert.equal(Number(qty), Number(ctx.inventur_soll))
      },
    },
  ],
}
