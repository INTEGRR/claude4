/**
 * Made-to-Order an Shopify — Lesesicht für Einstellungen und Vorschau
 * (Entscheidungslog 2026-10-01). Rechnet nichts selbst: baubar() und
 * shopify_soll_menge() (Migration 0100) sind die einzige Wahrheit, dieselbe,
 * die der Bestandsabgleich meldet.
 */
import { sql } from '@/db/client'

export interface MadeToOrderEinstellung {
  modus: 'baubar' | 'fest'
  puffer: number
  deckel: number
}

export const MTO_STANDARD: MadeToOrderEinstellung = { modus: 'baubar', puffer: 2, deckel: 99 }

export async function madeToOrderEinstellung(): Promise<MadeToOrderEinstellung> {
  const [row] = await sql<{ mto: Partial<MadeToOrderEinstellung> | null }[]>`
    select value -> 'mto' as mto from settings where key = 'shopify'`
  return { ...MTO_STANDARD, ...(row?.mto ?? {}) }
}

export interface MadeToOrderZeile {
  id: string
  sku: string | null
  name: string
  baubar: number
  engpass: string | null
  soll: number
  gemeldet: number | null
  eingerichtet: boolean
}

/** Alle Shopify-gekoppelten Made-to-Order-Varianten, knappste zuerst. */
export async function madeToOrderVorschau(): Promise<MadeToOrderZeile[]> {
  const rows = await sql<
    { id: string; sku: string | null; name: string; baubar: number; engpass: string | null; soll: number; gemeldet: number | null; eingerichtet: boolean }[]
  >`
    select pv.id, nullif(pv.sku, '') as sku, pv.display_name as name,
           b.menge::float as baubar, e.display_name as engpass,
           shopify_soll_menge(pv.id) as soll,
           s.pushed_qty::float as gemeldet,
           s.mto_eingerichtet_at is not null as eingerichtet
    from product_variants pv
    cross join lateral baubar(pv.id) b
    left join product_variants e on e.id = b.engpass
    left join shopify_inventory_state s on s.variant_id = pv.id
    where pv.active and pv.shopify_variant_id is not null and ist_made_to_order(pv.id)
    order by b.menge, pv.display_name`
  return rows.map((r) => ({ ...r, baubar: Number(r.baubar), gemeldet: r.gemeldet === null ? null : Number(r.gemeldet) }))
}
