import 'server-only'
import { sql } from '@/db/client'

/**
 * Die Daten des Fertigungszettels — EINE Quelle für beide Ausgaben: die
 * Browser-Druckseite (/fertigung/[id]/druck) und das PDF der Druckbrücke
 * (zettel-pdf.ts). Divergierende Zettel je nach Druckweg wären ein
 * Werkstatt-Ärgernis, deshalb teilen sich beide diese Abfragen.
 */

export interface ZettelKopf {
  number: string
  product: string
  sku: string | null
  barcode: string | null
  qty_to_produce: number
  uom: string
  scheduled_date: string | Date
  state: string
  sales_order_id: string | null
  sales_order_number: string | null
  shopify_order_name: string | null
  customer: string | null
  note: string | null
}

export interface ZettelKomponente {
  id: string
  product: string
  sku: string | null
  qty: number
  uom: string
}

export interface ZettelDaten {
  mo: ZettelKopf
  /** Nummer der Lieferung des Auftrags — der VERSAND-Barcode; null ohne Auftrag/Lieferung. */
  lieferung: string | null
  components: ZettelKomponente[]
  firma: string | null
}

export async function moZettelDaten(id: string): Promise<ZettelDaten | null> {
  const [mo] = await sql<ZettelKopf[]>`
    select mo.number, variant_display_name(mo.variant_id) as product, pv.sku, pv.barcode,
           mo.qty_to_produce, u.name as uom, mo.scheduled_date, mo.state,
           mo.sales_order_id, so.number as sales_order_number, so.shopify_order_name,
           p.name as customer, mo.note
    from manufacturing_orders mo
    join product_variants pv on pv.id = mo.variant_id
    join uoms u on u.id = mo.uom_id
    left join sales_orders so on so.id = mo.sales_order_id
    left join partners p on p.id = so.partner_id
    where mo.id = ${id}`
  if (!mo) return null

  // Die Lieferung des Auftrags — deren Nummer wird am Packtisch gescannt.
  // Jüngstes nicht storniertes Delivery-Picking; Lagerfertigung ohne
  // Auftrag hat keins, dann entfällt der zweite Barcode.
  const [lieferung] = mo.sales_order_id
    ? await sql<{ number: string }[]>`
        select p.number from stock_pickings p
        join operation_types ot on ot.id = p.operation_type_id
        where p.origin_model = 'sales_order' and p.origin_id = ${mo.sales_order_id}
          and ot.kind = 'delivery' and p.state <> 'cancel'
        order by p.created_at desc limit 1`
    : []

  const components = await sql<ZettelKomponente[]>`
    select m.id, variant_display_name(m.variant_id) as product, pv.sku, m.qty, u.name as uom
    from stock_moves m
    join product_variants pv on pv.id = m.variant_id
    join uoms u on u.id = m.uom_id
    where m.production_id = ${id} and m.reference = 'Komponentenverbrauch'
      and m.state <> 'cancel'
    order by m.created_at`

  const [company] = await sql<{ name: string }[]>`
    select value ->> 'name' as name from settings where key = 'company'`

  return { mo, lieferung: lieferung?.number ?? null, components, firma: company?.name ?? null }
}
