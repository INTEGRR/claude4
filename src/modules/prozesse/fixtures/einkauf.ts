import assert from 'node:assert/strict'
import type { Sql } from 'postgres'
import type { FixtureKontext, ProzessFixture } from './typen.ts'

/**
 * P6: Einkaufsbestellung (bis zur erzeugten Rechnung) und die
 * Lieferantenrechnung als eigener Prozess. Der Wareneingang wird — wie im
 * Betrieb — über picking_validate gebucht; im Bestellprozess passiert das
 * vor dem Rechnungs-Schritt (bill_policy 'received').
 */

async function wareneingangBuchen(sql: Sql, poId: string): Promise<void> {
  const [receipt] = await sql<{ id: string }[]>`
    select id from stock_pickings
    where origin_model = 'purchase_order' and origin_id = ${poId}
      and state not in ('done', 'cancel')
    limit 1`
  if (receipt) await sql`select picking_validate(${receipt.id}, '{}'::jsonb, false)`
}

export const EINKAUF_FIXTURE: ProzessFixture = {
  prozess: 'einkauf_wareneingang_rechnung',
  benoetigt: ['basis'],
  laeufe: [
    {
      name: 'Bestellung mit Position, Wareneingang, Rechnung',
      pfad: ['anlegen', 'position', 'bestaetigen', 'rechnung'],
      eingaben: {
        anlegen: (ctx) => ({ vendor_id: ctx.lieferantId }),
        position: (ctx) => ({ variant_id: ctx.teilId, qty: 5 }),
        // Der Rechnungs-Schritt setzt den Wareneingang voraus — die
        // Eingabefunktion läuft genau davor und bucht ihn wie im Betrieb.
        rechnung: async (ctx, sql) => {
          await wareneingangBuchen(sql, ctx.einkauf_wareneingang_rechnung_beleg_id)
          return {}
        },
      },
      pruefen: async (sql, _ctx, poId) => {
        const [po] = await sql<{ state: string }[]>`
          select state from purchase_orders where id = ${poId}`
        assert.equal(po.state, 'purchase')

        const [receipt] = await sql<{ state: string }[]>`
          select state from stock_pickings
          where origin_model = 'purchase_order' and origin_id = ${poId}`
        assert.equal(receipt.state, 'done', 'der Wareneingang ist gebucht')

        const [bill] = await sql<{ state: string }[]>`
          select state from vendor_bills where purchase_order_id = ${poId}`
        assert.equal(bill.state, 'draft', 'die Rechnung liegt im Entwurf')
      },
    },
  ],
}

export const LIEFERANTENRECHNUNG_FIXTURE: ProzessFixture = {
  prozess: 'lieferantenrechnung',
  benoetigt: ['basis'],
  laeufe: [
    {
      name: 'Entwurf buchen und bezahlen',
      // Die Rechnung entsteht vor dem Lauf über die Buchungswege — der
      // Pfad steigt mitten im Prozess ein (Standort: erfassen).
      beleg: async (ctx, sql) => {
        const [po] = await sql<{ id: string }[]>`
          insert into purchase_orders (number, vendor_id)
          values (next_sequence('purchase'), ${ctx.lieferantId}) returning id`
        await sql`
          insert into purchase_order_lines
            (order_id, sequence, variant_id, name, qty, uom_id, price_unit, tax_rate)
          select ${po.id}, 10, pv.id, variant_display_name(pv.id), 3, pt.uom_id, 10, 19
          from product_variants pv join product_templates pt on pt.id = pv.template_id
          where pv.id = ${ctx.teilId}`
        await sql`select confirm_purchase_order(${po.id}, 'prozessdaten')`
        await wareneingangBuchen(sql, po.id)
        const [bill] = await sql<{ id: string }[]>`
          select create_vendor_bill(${po.id}, 'prozessdaten') as id`
        // Was sonst der Erfassen-Schritt tut: ohne Rechnungsdatum bucht
        // post_vendor_bill nicht.
        await sql`update vendor_bills set bill_date = current_date where id = ${bill.id}`
        return bill.id
      },
      pfad: ['buchen', 'zahlen'],
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, billId) => {
        const [bill] = await sql<{ state: string }[]>`
          select state from vendor_bills where id = ${billId}`
        assert.equal(bill.state, 'paid')
      },
    },
  ],
}
