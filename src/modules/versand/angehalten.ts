import { sql } from '@/db/client'

/**
 * Offene Lieferungen, deren Bestellung im Shop angehalten ist (0134). Sie
 * fehlen in „Versandbereit" — diese Liste zeigt sie mit Grund und Notiz,
 * damit niemand sie sucht und keine vergessen wird.
 */
export interface AngehalteneLieferung {
  picking_id: string
  picking_number: string
  picking_state: string
  sales_order_id: string
  auftrag: string
  shopify: string | null
  kunde: string | null
  partner_id: string | null
  grund: string | null
  notiz: string | null
  seit: string | null
}

export async function angehalteneLieferungen(): Promise<AngehalteneLieferung[]> {
  return sql<AngehalteneLieferung[]>`
    select p.id as picking_id, p.number as picking_number, p.state::text as picking_state,
           so.id as sales_order_id, so.number as auftrag, so.shopify_order_name as shopify,
           part.name as kunde, so.partner_id, so.shopify_halt_grund as grund, so.shopify_halt_notiz as notiz,
           so.shopify_halt_seit::text as seit
    from sales_orders so
    join stock_pickings p on p.origin_model = 'sales_order' and p.origin_id = so.id
    join operation_types ot on ot.id = p.operation_type_id and ot.kind = 'delivery'
    left join partners part on part.id = so.partner_id
    where so.shopify_halt and p.state not in ('done', 'cancel')
    order by so.shopify_halt_seit nulls last, p.number
    limit 200`
}
