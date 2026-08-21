import assert from 'node:assert/strict'
import type { Sql } from 'postgres'
import type { ProzessFixture } from './typen.ts'

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
      // Die KOMPONIERTE Kette: Bestellung → Teilprozess Wareneingang
      // (eigener Prozess am Eingangs-Transfer) → Rechnung erstellen →
      // Teilprozess Lieferantenrechnung (bis bezahlt) → Ende.
      name: 'Bestellung, Teilprozess Wareneingang, Teilprozess Rechnung',
      pfad: ['anlegen', 'position', 'bestaetigen', 'wareneingang', 'rechnung', 'abrechnung'],
      eingaben: {
        anlegen: (ctx) => ({ vendor_id: ctx.lieferantId }),
        position: (ctx) => ({ variant_id: ctx.teilId, qty: 5 }),
      },
      ereignisse: {
        // Teilprozess Wareneingang: der Kindbeleg wird gebucht — erst
        // danach rückt der Elternprozess zur Rechnung weiter.
        wareneingang: async (ctx, sql) => {
          await wareneingangBuchen(sql, ctx.einkauf_wareneingang_rechnung_beleg_id)
        },
        // Teilprozess Lieferantenrechnung: die Rechnung läuft ihren
        // eigenen Prozess bis „bezahlt" — über den Torwächter, wie im Betrieb.
        abrechnung: async (ctx, sql) => {
          const [bill] = await sql<{ id: string }[]>`
            select id from vendor_bills
            where purchase_order_id = ${ctx.einkauf_wareneingang_rechnung_beleg_id}`
          assert.ok(bill, 'die Rechnung muss existieren')
          await sql`update vendor_bills set bill_date = current_date where id = ${bill.id}`
          const { aktionAusfuehrenGeprueft } = await import('../torwaechter.ts')
          const nutzer = { name: 'prozesstest', role: 'admin' as const }
          await aktionAusfuehrenGeprueft('einkauf.rechnung_buchen', { recordId: bill.id }, nutzer)
          await aktionAusfuehrenGeprueft('einkauf.rechnung_zahlen', { recordId: bill.id }, nutzer)
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
        assert.equal(bill.state, 'paid', 'die Rechnung ist durch ihren Teilprozess bezahlt')
      },
    },
    {
      // Der zweite START der Kette: nicht ein Mensch legt an, sondern der
      // Meldebestand — „Beschaffung ausführen" macht aus dem Vorschlag die
      // Bestellung (record_id = die Meldebestand-Regel).
      name: 'Meldebestand erreicht — die Beschaffung wird zur Bestellung',
      pfad: ['beschaffen', 'bestaetigen'],
      eingaben: {
        beschaffen: async (ctx, sql) => {
          // Frischer Artikel je Lauf (Staging-wiederholbar), Bestand 0,
          // Mindestbestand 10 → der Vorschlag steht sofort an.
          const [{ n }] = await sql<{ n: number }[]>`
            select count(*)::int as n from product_templates
            where name like 'Prozesstest Meldeartikel%'`
          const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
          const [tpl] = await sql<{ id: string }[]>`
            insert into product_templates (name, uom_id, list_price, route_buy)
            values (${`Prozesstest Meldeartikel ${Number(n) + 1}`}, ${stueck.id}, 5, true)
            returning id`
          await sql`select generate_variants(${tpl.id})`
          const [variante] = await sql<{ id: string }[]>`
            select id from product_variants where template_id = ${tpl.id} and active limit 1`
          await sql`
            insert into vendor_prices (vendor_id, template_id, variant_id, price)
            values (${ctx.lieferantId}, ${tpl.id}, ${variante.id}, 3.5)`
          const [ort] = await sql<{ id: string }[]>`
            select id from stock_locations where full_path = 'WH/Stock'`
          const [regel] = await sql<{ id: string }[]>`
            insert into stock_orderpoints (variant_id, location_id, min_qty, max_qty)
            values (${variante.id}, ${ort.id}, 10, 20) returning id`
          return { record_id: regel.id }
        },
      },
      pruefen: async (sql, _ctx, poId) => {
        const [po] = await sql<{ state: string; origin: string | null }[]>`
          select state, origin from purchase_orders where id = ${poId}`
        assert.equal(po.state, 'purchase')
        assert.equal(po.origin, 'Meldebestand', 'die Herkunft benennt den Auslöser')

        const [receipt] = await sql<{ id: string }[]>`
          select id from stock_pickings
          where origin_model = 'purchase_order' and origin_id = ${poId}`
        assert.ok(receipt, 'die Bestätigung erzeugt den Wareneingang')
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
