import assert from 'node:assert/strict'
import type { ProzessFixture } from './typen.ts'

/**
 * Reparatur — der erste vollständige Belegprozess: Statusmaschine, optionaler
 * Teile-Schritt (echte Lagerbuchung!) und das XOR am Ende (Garantie oder
 * kostenpflichtig mit Angebot).
 */
export const REPARATUR: ProzessFixture = {
  prozess: 'reparatur',
  benoetigt: ['basis'],
  laeufe: [
    {
      name: 'kostenpflichtig: Teile verbauen, abschließen, Angebot',
      pfad: ['anlegen', 'bestaetigen', 'beginnen', 'teile', 'abschliessen', 'angebot'],
      eingaben: {
        anlegen: (ctx) => ({
          partner_id: ctx.kundeId,
          variant_id: ctx.geraetId,
          qty: 1,
          under_warranty: false,
          note: 'Prozesstest: Taste klemmt.',
        }),
        teile: (ctx) => ({ variant_id: ctx.teilId, qty: 2, part_type: 'add' }),
        abschliessen: { mengen: {} }, // leer = Sollmengen buchen
      },
      pruefen: async (sql, ctx, recordId) => {
        const [auftrag] = await sql<{ state: string; sales_order_id: string | null }[]>`
          select state, sales_order_id from repair_orders where id = ${recordId}`
        assert.equal(auftrag.state, 'repaired')
        assert.ok(auftrag.sales_order_id, 'das Angebot muss am Auftrag hängen')

        // Das Einbauteil ist tatsächlich vom Lager abgebucht.
        const [teil] = await sql<{ qty_done: number; state: string }[]>`
          select m.qty_done, m.state
          from repair_parts rp join stock_moves m on m.id = rp.move_id
          where rp.repair_id = ${recordId} and rp.variant_id = ${ctx.teilId}`
        assert.equal(teil.state, 'done')
        assert.equal(Number(teil.qty_done), 2)
      },
    },
    {
      name: 'Garantie: nach dem Abschluss kein Angebot, Prozess zu Ende',
      pfad: ['anlegen', 'bestaetigen', 'beginnen', 'abschliessen'],
      eingaben: {
        anlegen: (ctx) => ({
          partner_id: ctx.kundeId,
          variant_id: ctx.geraetId,
          qty: 1,
          under_warranty: true,
        }),
        abschliessen: { mengen: {} },
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, recordId) => {
        const [auftrag] = await sql<{ state: string; sales_order_id: string | null }[]>`
          select state, sales_order_id from repair_orders where id = ${recordId}`
        assert.equal(auftrag.state, 'repaired')
        assert.equal(auftrag.sales_order_id, null, 'Garantiefall bekommt kein Angebot')
      },
    },
    {
      name: 'Storno: Reservierung wird freigegeben, Prozess zu Ende',
      pfad: ['anlegen', 'bestaetigen', 'stornieren'],
      eingaben: {
        anlegen: (ctx) => ({
          partner_id: ctx.kundeId,
          variant_id: ctx.geraetId,
          qty: 1,
          under_warranty: false,
        }),
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, recordId) => {
        const [auftrag] = await sql<{ state: string }[]>`
          select state from repair_orders where id = ${recordId}`
        assert.equal(auftrag.state, 'cancel')
        const offene = await sql<{ id: string }[]>`
          select m.id from repair_parts rp
          join stock_moves m on m.id = rp.move_id
          where rp.repair_id = ${recordId} and m.state not in ('cancel', 'done')`
        assert.equal(offene.length, 0, 'keine offenen Teilebewegungen nach dem Storno')
      },
    },
  ],
}
