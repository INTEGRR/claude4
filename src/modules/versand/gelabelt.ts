import { sql } from '@/db/client'

/**
 * Lieferungen mit Label, die noch nicht ausgebucht sind (Entscheidungslog
 * 2026-10-01, „Label bucht aus"): reserviert, mit einer gültigen Sendung —
 * Labels aus der Zeit, als das Ausbuchen ein Haken war, oder bewusst „nur
 * Label". Je Lieferung die jüngste gültige Sendung.
 */
export interface GelabeltOffen {
  picking_id: string
  picking_number: string
  shipment_id: string
  shipment_number: string
}

export async function gelabeltNichtAusgebucht(ids?: string[]): Promise<GelabeltOffen[]> {
  return sql<GelabeltOffen[]>`
    select distinct on (p.id)
           p.id as picking_id, p.number as picking_number,
           s.id as shipment_id, s.shipment_number
    from stock_pickings p
    join operation_types ot on ot.id = p.operation_type_id and ot.kind = 'delivery'
    join shipments s on s.picking_id = p.id and s.state not in ('cancelled', 'failure')
    where p.state = 'assigned'
      ${ids ? sql`and p.id = any(${ids}::uuid[])` : sql``}
    order by p.id, s.created_at desc`
}
