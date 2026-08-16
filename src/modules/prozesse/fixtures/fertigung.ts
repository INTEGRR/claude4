import assert from 'node:assert/strict'
import type { Sql } from 'postgres'
import type { FixtureKontext, ProzessFixture } from './typen.ts'

/**
 * P5: Fertigungsauftrag — Baugruppe aus Stückliste, Komponenten per
 * Backflush, Erzeugnis geht ins Lager (Ledger-Invariante nach jedem Schritt).
 */

async function baugruppeMitStueckliste(sql: Sql, ctx: FixtureKontext): Promise<void> {
  const [vorhanden] = await sql<{ id: string; template_id: string }[]>`
    select id, template_id from product_variants where sku = 'PT-BAUGRUPPE' limit 1`
  if (vorhanden) {
    ctx.baugruppeId = vorhanden.id
    return
  }

  const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, weight_g, route_manufacture)
    values ('Prozesstest Baugruppe', ${stueck.id}, 700, true) returning id`
  await sql`select generate_variants(${tpl.id})`
  const [variante] = await sql<{ id: string }[]>`
    select id from product_variants where template_id = ${tpl.id} and active limit 1`
  await sql`update product_variants set sku = 'PT-BAUGRUPPE' where id = ${variante.id}`

  // Stückliste: 1 × Ersatzteil je Baugruppe, Backflush.
  const [bom] = await sql<{ id: string }[]>`
    insert into boms (template_id, qty, uom_id) values (${tpl.id}, 1, ${stueck.id}) returning id`
  await sql`
    insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id, issue_method)
    select ${bom.id}, 10, ${ctx.teilId}, 1, pt.uom_id, 'backflush'
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.id = ${ctx.teilId}`

  ctx.baugruppeId = variante.id
}

export const FERTIGUNG_FIXTURE: ProzessFixture = {
  prozess: 'fertigung',
  benoetigt: ['basis'],
  aufbauen: baugruppeMitStueckliste,
  laeufe: [
    {
      name: 'anlegen, bestätigen, starten, fertig melden (Backflush)',
      pfad: ['anlegen', 'bestaetigen', 'beginnen', 'fertig_melden'],
      eingaben: {
        anlegen: (ctx) => ({ variant_id: ctx.baugruppeId, qty: 2 }),
        fertig_melden: { mengen: {}, backorder: true },
      },
      danachKeineSchritte: true,
      pruefen: async (sql, ctx, moId) => {
        const [mo] = await sql<{ state: string }[]>`
          select state from manufacturing_orders where id = ${moId}`
        assert.equal(mo.state, 'done')

        // Das Erzeugnis liegt im Lager, die Komponenten sind verbraucht.
        const [bestand] = await sql<{ qty: number }[]>`
          select on_hand_qty(${ctx.baugruppeId}, null) as qty`
        assert.ok(Number(bestand.qty) >= 2, 'die Baugruppen müssen im Bestand sein')
        const verbraucht = await sql<{ qty_done: number }[]>`
          select qty_done from stock_moves
          where production_id = ${moId} and variant_id = ${ctx.teilId} and state = 'done'`
        assert.ok(verbraucht.length > 0, 'die Komponente muss per Backflush verbraucht sein')
      },
    },
    {
      name: 'direkt aus der Bestätigung fertig melden',
      pfad: ['anlegen', 'bestaetigen', 'fertig_melden'],
      eingaben: {
        anlegen: (ctx) => ({ variant_id: ctx.baugruppeId, qty: 1 }),
        fertig_melden: { mengen: {}, backorder: true },
      },
      danachKeineSchritte: true,
    },
    {
      name: 'Storno gibt Reservierungen frei',
      pfad: ['anlegen', 'bestaetigen', 'stornieren'],
      eingaben: {
        anlegen: (ctx) => ({ variant_id: ctx.baugruppeId, qty: 1 }),
      },
      danachKeineSchritte: true,
      pruefen: async (sql, _ctx, moId) => {
        const offene = await sql<{ id: string }[]>`
          select id from stock_moves
          where production_id = ${moId} and state not in ('cancel', 'done')`
        assert.equal(offene.length, 0, 'keine offenen Bewegungen nach dem Storno')
      },
    },
  ],
}
