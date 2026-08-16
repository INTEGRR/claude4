import type { Sql } from 'postgres'
import type { FixtureKontext, ProzessFixture } from './typen.ts'

/**
 * Grundbestand, den mehrere Prozesse brauchen: ein Kunde, ein Gerät (das
 * Objekt einer Reparatur) und ein Ersatzteil mit Lagerbestand. Alles über
 * die regulären Buchungswege (generate_variants, Inventur), nichts direkt
 * in Quants geschrieben — der Ledger bleibt konsistent.
 */

async function findeOderPartner(
  sql: Sql,
  name: string,
  rolle: 'kunde' | 'lieferant',
): Promise<string> {
  const [vorhanden] = await sql<{ id: string }[]>`
    select id from partners where name = ${name} limit 1`
  if (vorhanden) return vorhanden.id
  const [neu] = await sql<{ id: string }[]>`
    insert into partners (name, is_customer, is_vendor)
    values (${name}, ${rolle === 'kunde'}, ${rolle === 'lieferant'}) returning id`
  return neu.id
}

async function findeOderProdukt(sql: Sql, name: string, sku: string): Promise<string> {
  const [vorhanden] = await sql<{ id: string }[]>`
    select id from product_variants where sku = ${sku} limit 1`
  if (vorhanden) return vorhanden.id

  const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, weight_g)
    values (${name}, ${stueck.id}, 500) returning id`
  await sql`select generate_variants(${tpl.id})`
  const [variante] = await sql<{ id: string }[]>`
    select id from product_variants where template_id = ${tpl.id} and active limit 1`
  await sql`update product_variants set sku = ${sku} where id = ${variante.id}`
  return variante.id
}

/** Füllt den frei verwendbaren Bestand per Inventur auf mindestens `mindest` auf. */
async function bestandAuffuellen(sql: Sql, variantId: string, mindest: number): Promise<void> {
  const [frei] = await sql<{ qty: number }[]>`select free_to_use(${variantId}) as qty`
  const fehlt = mindest - Number(frei.qty)
  if (fehlt <= 0) return

  const [ort] = await sql<{ id: string }[]>`
    select id from stock_locations where full_path = 'WH/Stock'`
  const [buch] = await sql<{ on_hand: number }[]>`
    select coalesce(on_hand, 0) as on_hand from stock_quants
    where location_id = ${ort.id} and variant_id = ${variantId}`
  const bestand = Number(buch?.on_hand ?? 0)
  const [zaehlung] = await sql<{ id: string }[]>`
    insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
    values (${ort.id}, ${variantId}, ${bestand + fehlt}, ${bestand}) returning id`
  await sql`select inventory_apply(${zaehlung.id}, 'prozessdaten')`
}

export const BASIS: ProzessFixture = {
  prozess: null,
  aufbauen: async (sql: Sql, ctx: FixtureKontext) => {
    ctx.kundeId = await findeOderPartner(sql, 'Prozesstest Kunde', 'kunde')
    ctx.lieferantId = await findeOderPartner(sql, 'Prozesstest Lieferant', 'lieferant')
    ctx.geraetId = await findeOderProdukt(sql, 'Prozesstest Gerät', 'PT-GERAET')
    ctx.teilId = await findeOderProdukt(sql, 'Prozesstest Ersatzteil', 'PT-TEIL')
    await bestandAuffuellen(sql, ctx.teilId, 10)
  },
}
