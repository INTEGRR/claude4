import { sql } from '@/db/client'

/**
 * Packzettel-Daten — EINE Wahrheit für die HTML-Druckseite
 * (/lager/[id]/druck, Sammeldruck /versand/packzettel) und das PDF der
 * Druckbrücke (packzettel-pdf.tsx), Muster Fertigungszettel (0091).
 * Positionen nach Artikelname sortiert — die Laufreihenfolge beim
 * Kommissionieren (Lagerplätze gibt es vorerst nicht).
 */

export interface PackzettelKopf {
  id: string
  number: string
  state: string
  origin_label: string | null
  sales_order_number: string | null
  shopify_order_name: string | null
  customer: string | null
  ship_name: string | null
  ship_street: string | null
  ship_house_number: string | null
  ship_zip: string | null
  ship_city: string | null
  ship_country_code: string | null
  kundennotiz: string | null
}

export interface PackzettelZeile {
  id: string
  product: string
  sku: string | null
  barcode: string | null
  qty: number
  uom: string
  belegtext: string | null
}

export interface Packzettel {
  kopf: PackzettelKopf
  zeilen: PackzettelZeile[]
  firma: string | null
}

export async function packzettelDaten(ids: string[]): Promise<Packzettel[]> {
  if (ids.length === 0) return []
  const koepfe = await sql<PackzettelKopf[]>`
    select p.id, p.number, p.state, p.origin_label,
           so.number as sales_order_number, so.shopify_order_name,
           pa.name as customer,
           so.ship_name, so.ship_street, so.ship_house_number,
           so.ship_zip, so.ship_city, so.ship_country_code,
           nullif(trim(so.note), '') as kundennotiz
    from stock_pickings p
    left join sales_orders so on so.id = p.origin_id and p.origin_model = 'sales_order'
    left join partners pa on pa.id = so.partner_id
    where p.id = any(${ids}::uuid[])`
  const zeilen = await sql<(PackzettelZeile & { picking_id: string })[]>`
    select m.id, m.picking_id, variant_display_name(m.variant_id) as product, pv.sku, pv.barcode,
           m.qty::float as qty, u.name as uom, nullif(trim(pt.description_picking), '') as belegtext
    from stock_moves m
    join product_variants pv on pv.id = m.variant_id
    join product_templates pt on pt.id = pv.template_id
    join uoms u on u.id = m.uom_id
    where m.picking_id = any(${ids}::uuid[]) and m.state <> 'cancel'
    order by variant_display_name(m.variant_id), m.created_at`
  const [firma] = await sql<{ name: string | null }[]>`
    select value ->> 'name' as name from settings where key = 'company'`
  // Reihenfolge wie angefragt (Auswahl im Versand).
  return ids
    .map((id) => koepfe.find((k) => k.id === id))
    .filter((k): k is PackzettelKopf => Boolean(k))
    .map((kopf) => ({
      kopf,
      zeilen: zeilen.filter((z) => z.picking_id === kopf.id).map(({ picking_id: _, ...z }) => z),
      firma: firma?.name ?? null,
    }))
}
