import assert from 'node:assert/strict'
import type { ProzessFixture } from './typen.ts'
import { bestellungEinspeisen } from './shopify-versand.ts'

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
    {
      // BUG/00001: der ERP-Storno eines Shop-Auftrags zieht den Shop nach
      // (orderCancel mit Restock; Rückerstattung bleibt manuell) — als
      // sichtbarer dienst-Schritt, den es nur für Shop-Aufträge gibt.
      name: 'Shop-Auftrag stornieren meldet den Storno an den Shop',
      beleg: async (ctx, sql) => {
        await bestellungEinspeisen(ctx, sql)
        return ctx.p4AuftragId
      },
      pfad: ['stornieren', 'shop_storno'],
      pruefen: async (sql, ctx) => {
        const [auftrag] = await sql<{ state: string }[]>`
          select state from sales_orders where id = ${ctx.p4AuftragId}`
        assert.equal(auftrag.state, 'cancel')

        const [job] = await sql<{ status: string }[]>`
          select status from integration_jobs
          where kind = 'shopify_order_cancel'
            and payload ->> 'sales_order_id' = ${ctx.p4AuftragId}`
        assert.equal(job?.status, 'done', 'der Shop-Storno-Job muss durchgelaufen sein')

        // Der Storno-Hinweis (inkl. „Rückerstattung manuell") steht am Auftrag.
        const [hinweis] = await sql<{ message: string }[]>`
          select message from audit_log
          where model = 'sales_order' and record_id = ${ctx.p4AuftragId}::uuid
            and message like '%Shop-Bestellung storniert%'`
        assert.ok(hinweis, 'der Storno-Hinweis muss am Auftrag stehen')

        // Der Riegel: ein bereits versandter Shop-Auftrag (aus dem
        // Klärfall-Lauf) lässt sich NICHT stornieren — der Weg ist die Retoure.
        const { aktionAusfuehrenGeprueft } = await import('../torwaechter.ts')
        await assert.rejects(
          aktionAusfuehrenGeprueft(
            'verkauf.stornieren',
            { recordId: ctx.p4KlaerAuftragId },
            { name: 'prozesstest', role: 'admin' },
          ),
          /Retoure/,
        )
      },
    },
  ],
}
