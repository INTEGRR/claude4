import { sql } from '@/db/client'
import { SPERRE_MINUTEN, type SammelPosition, sammelReihenfolge } from './kommissionier-logik.ts'

/**
 * Lesende Seite des Kommissionierens (0091): Arbeitsvorrat, Sammelbeleg
 * für den Handy-Screen und die Marken der Versand-Liste. Geschrieben wird
 * nur über die Registry (lager.kommissionierung_starten, lager.kommissionieren,
 * versand.packzettel_drucken).
 */

export interface VorratZeile {
  pickingId: string
  number: string
  auftrag: string | null
  shopify: string | null
  kunde: string | null
  positionen: number
  stueck: number
  priority: boolean
  geplant: string | null
  /** Wer gerade sammelt — nur solange die Sperre frisch ist. */
  sammler: string | null
  gesammeltStueck: number
  kommissioniertAm: string | null
  kommissioniertVon: string | null
  packzettelGedrucktAm: string | null
}

/**
 * Versandbereite Lieferungen (shipping_ready: reserviert, keine offene
 * Fertigung) — Priorität, dann ältestes geplantes Datum zuerst. Bereits
 * kommissionierte stehen hinten (sie warten am Packtisch).
 */
export async function sammelVorrat(): Promise<VorratZeile[]> {
  return sql<VorratZeile[]>`
    select r.picking_id as "pickingId", r.picking_number as number,
           r.sales_order_number as auftrag, r.shopify_order_name as shopify,
           r.customer_name as kunde,
           (select count(distinct m.variant_id)::int from stock_moves m
             where m.picking_id = p.id and m.state <> 'cancel') as positionen,
           (select coalesce(sum(m.qty), 0)::float from stock_moves m
             where m.picking_id = p.id and m.state <> 'cancel') as stueck,
           (select coalesce(sum(m.qty_kommissioniert), 0)::float from stock_moves m
             where m.picking_id = p.id and m.state <> 'cancel') as "gesammeltStueck",
           (p.priority = '1') as priority, r.scheduled_date::text as geplant,
           case when p.kommissionierung_seit > now() - make_interval(mins => ${SPERRE_MINUTEN})
                then p.kommissionierung_von end as sammler,
           p.kommissioniert_am::text as "kommissioniertAm",
           p.kommissioniert_von as "kommissioniertVon",
           p.packzettel_gedruckt_am::text as "packzettelGedrucktAm"
    from shipping_ready r
    join stock_pickings p on p.id = r.picking_id
    order by (p.kommissioniert_am is not null), p.priority desc,
             r.scheduled_date nulls last, r.picking_number
    limit 200`
}

/** Die nächste Bestellung für diesen Sammler: seine eigene offene, sonst die erste freie. */
export function naechsteFuer(vorrat: VorratZeile[], wer: string): VorratZeile | null {
  const offen = vorrat.filter((z) => !z.kommissioniertAm)
  return offen.find((z) => z.sammler === wer) ?? offen.find((z) => !z.sammler) ?? null
}

export interface SammelMarke {
  sammler: string | null
  kommissioniertAm: string | null
  kommissioniertVon: string | null
  packzettelGedrucktAm: string | null
}

/** Marken je Lieferung für die Versand-Liste. */
export async function sammelMarken(ids: string[]): Promise<Map<string, SammelMarke>> {
  if (ids.length === 0) return new Map()
  const rows = await sql<(SammelMarke & { id: string })[]>`
    select id,
           case when kommissionierung_seit > now() - make_interval(mins => ${SPERRE_MINUTEN})
                then kommissionierung_von end as sammler,
           kommissioniert_am::text as "kommissioniertAm",
           kommissioniert_von as "kommissioniertVon",
           packzettel_gedruckt_am::text as "packzettelGedrucktAm"
    from stock_pickings where id = any(${ids}::uuid[])`
  return new Map(rows.map(({ id, ...m }) => [id, m]))
}

export interface SammelZeile extends SammelPosition {
  belegtext: string | null
  /** Bereits gespeicherter Fortschritt (stock_moves.qty_kommissioniert). */
  gesammelt: number
}

export interface SammelDoc {
  pickingId: string
  number: string
  state: string
  auftrag: string | null
  shopify: string | null
  kunde: string | null
  kundennotiz: string | null
  sammler: string | null
  kommissioniertAm: string | null
  kommissioniertVon: string | null
  /** Offene Fertigungsaufträge des Auftrags — dann ist nichts zu sammeln. */
  fertigungOffen: string[]
  positionen: SammelZeile[]
}

export async function sammelDoc(pickingId: string): Promise<SammelDoc | null> {
  const [kopf] = await sql<Omit<SammelDoc, 'positionen' | 'fertigungOffen'>[]>`
    select p.id as "pickingId", p.number, p.state::text as state,
           so.number as auftrag, so.shopify_order_name as shopify, pa.name as kunde,
           nullif(trim(so.note), '') as kundennotiz,
           case when p.kommissionierung_seit > now() - make_interval(mins => ${SPERRE_MINUTEN})
                then p.kommissionierung_von end as sammler,
           p.kommissioniert_am::text as "kommissioniertAm",
           p.kommissioniert_von as "kommissioniertVon"
    from stock_pickings p
    join operation_types ot on ot.id = p.operation_type_id and ot.kind = 'delivery'
    left join sales_orders so on so.id = p.origin_id and p.origin_model = 'sales_order'
    left join partners pa on pa.id = coalesce(so.partner_id, p.partner_id)
    where p.id = ${pickingId}`
  if (!kopf) return null
  const fertigung = await sql<{ number: string }[]>`
    select mo.number from manufacturing_orders mo
    join stock_pickings p on p.origin_model = 'sales_order' and p.origin_id = mo.sales_order_id
    where p.id = ${pickingId} and mo.state not in ('done', 'cancel')
    order by mo.number`
  // Je VARIANTE aggregiert — wie am Packtisch zählen zwei Auftragszeilen
  // derselben Variante als eine Sollmenge.
  const zeilen = await sql<SammelZeile[]>`
    select m.variant_id as "variantId", variant_display_name(m.variant_id) as name,
           pv.sku, pv.barcode, sum(m.qty)::float as soll, min(u.name) as uom,
           max(nullif(trim(pt.description_picking), '')) as belegtext,
           sum(m.qty_kommissioniert)::float as gesammelt
    from stock_moves m
    join product_variants pv on pv.id = m.variant_id
    join product_templates pt on pt.id = pv.template_id
    join uoms u on u.id = m.uom_id
    where m.picking_id = ${pickingId} and m.state <> 'cancel'
    group by m.variant_id, pv.sku, pv.barcode`
  return {
    ...kopf,
    fertigungOffen: fertigung.map((f) => f.number),
    positionen: sammelReihenfolge([...zeilen]),
  }
}
