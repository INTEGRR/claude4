import assert from 'node:assert/strict'
import type { ProzessFixture } from './typen.ts'

/**
 * Reparatur — der erste vollständige Belegprozess: Statusmaschine, optionaler
 * Teile-Schritt (echte Lagerbuchung!), das XOR am Ende (Garantie oder
 * kostenpflichtig mit Angebot) und seit v2 (0082) beide Enden per Post:
 * Retourenlabel → Geräteeingang vor dem Bestätigen, Rückversand danach.
 */
export const REPARATUR: ProzessFixture = {
  prozess: 'reparatur',
  benoetigt: ['basis'],
  aufbauen: async (sql, ctx) => {
    // Retourenlabel und Rückversand brauchen eine vollständige Adresse und
    // eine E-Mail am Prozesstest-Kunden — nur leere Felder füllen (wiederholbar).
    await sql`
      update partners set
        street = coalesce(street, 'Prozessweg'),
        house_number = coalesce(house_number, '1'),
        zip = coalesce(zip, '10115'),
        city = coalesce(city, 'Berlin'),
        email = coalesce(email, 'prozesstest-kunde@example.com')
      where id = ${ctx.kundeId}`
  },
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
      name: 'Garantie: kein Angebot, Rückversand per DHL, Prozess zu Ende',
      pfad: ['anlegen', 'bestaetigen', 'beginnen', 'abschliessen', 'rueckversand'],
      eingaben: {
        anlegen: (ctx) => ({
          partner_id: ctx.kundeId,
          variant_id: ctx.geraetId,
          qty: 1,
          under_warranty: true,
        }),
        abschliessen: { mengen: {} },
        rueckversand: { ohne_label: false },
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, recordId) => {
        const [auftrag] = await sql<{ state: string; sales_order_id: string | null }[]>`
          select state, sales_order_id from repair_orders where id = ${recordId}`
        assert.equal(auftrag.state, 'shipped')
        assert.equal(auftrag.sales_order_id, null, 'Garantiefall bekommt kein Angebot')

        // Die Rücksendung ist eine Sendung OHNE Lieferung — sie hängt an der Reparatur.
        const [sendung] = await sql<
          { picking_id: string | null; shipment_number: string | null; tracking_url: string | null; state: string }[]
        >`
          select picking_id, shipment_number, tracking_url, state
          from shipments where repair_order_id = ${recordId}`
        assert.ok(sendung, 'die Rücksendung hängt am Reparaturauftrag')
        assert.equal(sendung.picking_id, null)
        assert.match(sendung.shipment_number ?? '', /^\d{20}$/)
        assert.ok(sendung.tracking_url, 'Tracking-Link vorhanden')
        assert.equal(sendung.state, 'created')
      },
    },
    {
      name: 'per Post, kostenpflichtig: Retourenlabel, Geräteeingang, Teile, Angebot, Rückversand',
      pfad: [
        'anlegen', 'retourenlabel', 'eingang', 'bestaetigen', 'beginnen',
        'teile', 'abschliessen', 'angebot', 'rueckversand',
      ],
      eingaben: {
        anlegen: (ctx) => ({
          partner_id: ctx.kundeId,
          variant_id: ctx.geraetId,
          qty: 1,
          under_warranty: false,
          note: 'Prozesstest: kommt per Post.',
        }),
        eingang: { vermerk: 'Karton unbeschädigt' },
        teile: (ctx) => ({ variant_id: ctx.teilId, qty: 1, part_type: 'add' }),
        abschliessen: { mengen: {} },
        rueckversand: { ohne_label: false, weight_g: 900 },
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, recordId) => {
        const [auftrag] = await sql<
          { number: string; state: string; received_at: string | null; sales_order_id: string | null }[]
        >`select number, state, received_at, sales_order_id from repair_orders where id = ${recordId}`
        assert.equal(auftrag.state, 'shipped')
        assert.ok(auftrag.received_at, 'der Geräteeingang ist datiert')
        assert.ok(auftrag.sales_order_id, 'kostenpflichtig: das Angebot hängt am Auftrag')

        const [label] = await sql<{ shipment_number: string | null }[]>`
          select shipment_number from return_labels where repair_order_id = ${recordId}`
        assert.ok(label, 'Retourenlabel hängt am Auftrag')
        const [dhl] = await sql<{ reference: string | null }[]>`
          select reference from api_transactions
          where system = 'dhl' and kind = 'fake:return_label' and reference = ${auftrag.number}
          limit 1`
        assert.ok(dhl, 'Retourenlabel mit RMA-Nummer als Referenz')

        const [sendung] = await sql<{ weight_g: number; picking_id: string | null }[]>`
          select weight_g, picking_id from shipments where repair_order_id = ${recordId}`
        assert.equal(Number(sendung.weight_g), 900, 'Handgewicht zählt')
        assert.equal(sendung.picking_id, null)
      },
    },
    {
      name: 'Abholung: Rückgabe ohne Versandlabel schließt den Auftrag',
      pfad: ['anlegen', 'bestaetigen', 'beginnen', 'abschliessen', 'rueckversand'],
      eingaben: {
        anlegen: (ctx) => ({
          partner_id: ctx.kundeId,
          variant_id: ctx.geraetId,
          qty: 1,
          under_warranty: true,
        }),
        abschliessen: { mengen: {} },
        rueckversand: { ohne_label: true, vermerk: 'Kunde holt am Tresen ab' },
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, recordId) => {
        const [auftrag] = await sql<{ state: string }[]>`
          select state from repair_orders where id = ${recordId}`
        assert.equal(auftrag.state, 'shipped')
        const sendungen = await sql<{ id: string }[]>`
          select id from shipments where repair_order_id = ${recordId}`
        assert.equal(sendungen.length, 0, 'ohne Label keine Sendung')
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
