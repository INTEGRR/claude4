import assert from 'node:assert/strict'
import type { ProzessFixture } from './typen.ts'

/**
 * P: Manueller Verkauf — Angebot, wiederholbarer Positionsschritt,
 * Bestätigung (Lieferung entsteht) und der Storno-Ausstieg.
 */
export const VERKAUF_FIXTURE: ProzessFixture = {
  prozess: 'verkauf',
  benoetigt: ['basis'],
  laeufe: [
    {
      name: 'Angebot mit Position bestätigen — die Lieferung entsteht',
      pfad: ['anlegen', 'positionen', 'bestaetigen'],
      eingaben: {
        anlegen: (ctx) => ({ partner_id: ctx.kundeId }),
        positionen: (ctx) => ({ variant_id: ctx.geraetId, qty: 1 }),
      },
      pruefen: async (sql, _ctx, orderId) => {
        const [auftrag] = await sql<{ state: string }[]>`
          select state from sales_orders where id = ${orderId}`
        assert.equal(auftrag.state, 'sale')

        // Die Bestätigung hat den Warenausgang angelegt.
        const pickings = await sql<{ state: string }[]>`
          select p.state from stock_pickings p
          join operation_types ot on ot.id = p.operation_type_id
          where p.origin_model = 'sales_order' and p.origin_id = ${orderId}
            and ot.kind = 'delivery'`
        assert.ok(pickings.length > 0, 'die Bestätigung muss eine Lieferung anlegen')
      },
    },
    {
      name: 'Storno im Entwurf, Prozess zu Ende',
      pfad: ['anlegen', 'stornieren'],
      eingaben: {
        anlegen: (ctx) => ({ partner_id: ctx.kundeId }),
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, orderId) => {
        const [auftrag] = await sql<{ state: string }[]>`
          select state from sales_orders where id = ${orderId}`
        assert.equal(auftrag.state, 'cancel')
      },
    },
  ],
}
