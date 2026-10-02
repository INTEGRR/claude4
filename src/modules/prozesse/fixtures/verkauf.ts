import assert from 'node:assert/strict'
import type { Sql } from 'postgres'
import type { ProzessFixture } from './typen.ts'
import { bestellungEinspeisen, shopStornoEinspeisen } from './shopify-versand.ts'

/**
 * P: Manueller Verkauf als KOMPONIERTE Kette (0064) — Angebot,
 * wiederholbarer Positionsschritt, Bestätigung (der Ausgangs-Transfer
 * entsteht), Teilprozess Lieferung am Transfer, Ende. Dazu der
 * Storno-Ausstieg: manuell im Entwurf, beim Shop-Auftrag aus Shopify.
 */

/** Den Warenausgang buchen — wie im Betrieb über picking_validate. */
async function lieferungBuchen(sql: Sql, orderId: string): Promise<void> {
  const [lieferung] = await sql<{ id: string }[]>`
    select p.id from stock_pickings p
    join operation_types ot on ot.id = p.operation_type_id
    where p.origin_model = 'sales_order' and p.origin_id = ${orderId}
      and ot.kind = 'delivery' and p.state not in ('done', 'cancel')
    limit 1`
  assert.ok(lieferung, 'die Bestätigung muss eine Lieferung angelegt haben')
  await sql`select picking_validate(${lieferung.id}, '{}'::jsonb, false)`
}

export const VERKAUF_FIXTURE: ProzessFixture = {
  prozess: 'verkauf',
  benoetigt: ['basis'],
  laeufe: [
    {
      name: 'Angebot bestätigen, Teilprozess Lieferung, Ende',
      pfad: ['anlegen', 'positionen', 'bestaetigen', 'lieferung'],
      eingaben: {
        anlegen: (ctx) => ({ partner_id: ctx.kundeId }),
        positionen: (ctx) => ({ variant_id: ctx.geraetId, qty: 1 }),
      },
      ereignisse: {
        // Teilprozess Lieferung: der Kindbeleg (Warenausgang) läuft seinen
        // eigenen Prozess bis „gebucht" — erst danach ist der Auftrag fertig.
        lieferung: async (ctx, sql) => {
          await lieferungBuchen(sql, ctx.verkauf_beleg_id)
        },
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
        // Der Teilprozess ist durch — der Warenausgang ist gebucht.
        assert.deepEqual(pickings.map((p) => p.state), ['done'])
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
      // Storno führt Shopify (2026-10-02, löst BUG/00001 ab): KRNL lehnt den
      // Storno eines Shop-Auftrags ab und meldet nichts an den Shop; der
      // Shop-Storno (Webhook) storniert hier samt Lieferung.
      name: 'Shop-Auftrag: Storno kommt aus Shopify, KRNL zieht nach',
      beleg: async (ctx, sql) => {
        await bestellungEinspeisen(ctx, sql)
        return ctx.p4AuftragId
      },
      pfad: ['shop_storniert'],
      ereignisse: {
        shop_storniert: async (ctx, sql) => {
          const { aktionAusfuehrenGeprueft } = await import('../torwaechter.ts')
          await assert.rejects(
            aktionAusfuehrenGeprueft(
              'verkauf.stornieren',
              { recordId: ctx.p4AuftragId },
              { name: 'prozesstest', role: 'admin' },
            ),
            /im Shopify-Admin stornieren/,
            'Shop-Aufträge storniert Shopify, nicht KRNL',
          )
          await shopStornoEinspeisen(sql, ctx.p4AuftragId)
          return undefined
        },
      },
      danachKeineSchritte: true,
      pruefen: async (sql, ctx) => {
        const [auftrag] = await sql<{ state: string }[]>`
          select state from sales_orders where id = ${ctx.p4AuftragId}`
        assert.equal(auftrag.state, 'cancel')

        const lieferungen = await sql<{ state: string }[]>`
          select state from stock_pickings
          where origin_model = 'sales_order' and origin_id = ${ctx.p4AuftragId}`
        assert.ok(lieferungen.length > 0)
        assert.ok(lieferungen.every((l) => l.state === 'cancel'), 'offene Lieferungen werden mit storniert')

        // Kein Rückweg an den Shop: es gibt keinen Storno-Job mehr.
        const [{ n }] = await sql<{ n: number }[]>`
          select count(*)::int as n from integration_jobs
          where kind = 'shopify_order_cancel' and payload ->> 'sales_order_id' = ${ctx.p4AuftragId}`
        assert.equal(n, 0, 'KRNL meldet keinen Storno an Shopify')

        const [log] = await sql<{ actor: string }[]>`
          select actor from audit_log
          where model = 'sales_order' and record_id = ${ctx.p4AuftragId}::uuid
            and message = 'Auftrag storniert'`
        assert.equal(log?.actor, 'shopify', 'storniert hat der Shop')
      },
    },
  ],
}
