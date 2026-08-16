import assert from 'node:assert/strict'
import type { ProzessFixture } from './typen.ts'

/**
 * Wareneingang — der Teilprozess des Einkaufs am Eingangs-Transfer
 * (Beleg-Filter origin = purchase_order). Eigenständig testbar: der Beleg
 * entsteht über die Buchungswege, der Pfad steigt am wartenden Eingang ein.
 */
export const WARENEINGANG_FIXTURE: ProzessFixture = {
  prozess: 'wareneingang',
  benoetigt: ['basis'],
  laeufe: [
    {
      name: 'Eingang validieren — der Bestand kommt an, die Bestellung wird erledigt',
      beleg: async (ctx, sql) => {
        const [po] = await sql<{ id: string }[]>`
          insert into purchase_orders (number, vendor_id)
          values (next_sequence('purchase'), ${ctx.lieferantId}) returning id`
        await sql`
          insert into purchase_order_lines
            (order_id, sequence, variant_id, name, qty, uom_id, price_unit, tax_rate)
          select ${po.id}, 10, pv.id, variant_display_name(pv.id), 4, pt.uom_id, 10, 19
          from product_variants pv join product_templates pt on pt.id = pv.template_id
          where pv.id = ${ctx.teilId}`
        await sql`select confirm_purchase_order(${po.id}, 'prozesstest')`
        ctx.wareneingang_po_id = po.id
        const [receipt] = await sql<{ id: string }[]>`
          select id from stock_pickings
          where origin_model = 'purchase_order' and origin_id = ${po.id}`
        assert.ok(receipt, 'die Bestätigung muss den Eingangs-Transfer anlegen')
        return receipt.id
      },
      pfad: ['buchen'],
      eingaben: {
        buchen: { mengen: {}, lose: {}, backorder: false },
      },
      danachKeineSchritte: true,
      pruefen: async (sql, ctx, receiptId) => {
        const [receipt] = await sql<{ state: string }[]>`
          select state from stock_pickings where id = ${receiptId}`
        assert.equal(receipt.state, 'done')

        // Der Bestand ist tatsächlich angekommen (Moves gebucht).
        const [move] = await sql<{ qty_done: number }[]>`
          select qty_done from stock_moves
          where picking_id = ${receiptId} and variant_id = ${ctx.teilId} and state = 'done'`
        assert.equal(Number(move.qty_done), 4)
      },
    },
  ],
}
