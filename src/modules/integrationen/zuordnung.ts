import { sql } from '@/db/client'
import type { Seite } from '@/modules/shared/seiten'

/**
 * Zuordnungen (Entscheidungslog 2026-11-27): je Artikel, womit er verknüpft
 * ist — Shopify-Variante, weitere Shop-Angebote (Zweitangebote),
 * Odoo-Artikel — und wo etwas fehlt. Die Verknüpfungen selbst sind IDs, die
 * SKU stellt sie nur einmal her; diese Seite macht sie sichtbar. Nur lesend.
 */
export type JaNein = 'ja' | 'nein' | null

export interface ZuordnungFilter {
  shop: JaNein
  odoo: JaNein
  sku: JaNein
  archiv: boolean
  q: string
}

export interface ZuordnungZeile {
  id: string
  template_id: string
  name: string
  sku: string | null
  barcode: string | null
  aktiv: boolean
  verkaufbar: boolean
  /** Shopify-Varianten-ID (GID) oder null. */
  shopify_variant_id: string | null
  herausgeloest: boolean
  /** Weitere Shop-Angebote, die auf diesen Artikel zeigen. */
  zweit: { produkt: string | null; sku: string | null }[]
  /** Odoo-Artikel, die auf diesen Artikel zeigen. */
  odoo: { id: number; herkunft: string }[]
  bestand: number
  /** In so vielen aktiven Stücklisten als Komponente. */
  stuecklisten: number
}

export interface ZuordnungZahlen {
  artikel: number
  mit_shop: number
  mit_odoo: number
  ohne_sku: number
  /** Verkaufbar, aber ohne Shop-Verknüpfung. */
  verkaufbar_ohne_shop: number
  /** Bestand oder Stücklisten-Einsatz, aber weder Shop noch Odoo. */
  ohne_alles: number
  /** Offene Klärfälle: Shop-Positionen, zu denen KRNL keinen Artikel fand. */
  klaerfaelle: number
  zweitangebote: number
}

/** Bedingung „hat einen Odoo-Verweis" — als Fragment, frisch je Abfrage. */
const mitOdoo = () =>
  sql`exists (select 1 from odoo_verweise v where v.krnl_tabelle = 'product_variants' and v.krnl_id = pv.id)`

export async function zuordnungen(f: ZuordnungFilter, seite: Seite): Promise<{ zeilen: ZuordnungZeile[]; gesamt: number }> {
  const q = f.q.trim()
  const muster = `%${q.replace(/[\\%_]/g, (z) => `\\${z}`)}%`
  const zeilen = await sql<(ZuordnungZeile & { gesamt: number })[]>`
    select count(*) over ()::int as gesamt,
           pv.id, pv.template_id, coalesce(pv.display_name, pt.name) as name, nullif(pv.sku, '') as sku, pv.barcode,
           pv.active as aktiv, pt.can_be_sold as verkaufbar, pv.shopify_variant_id, pv.shop_herausgeloest as herausgeloest,
           coalesce((select json_agg(json_build_object('produkt', z.produkt, 'sku', z.sku) order by z.produkt)
                       from shopify_zweitangebote z where z.variant_id = pv.id), '[]'::json) as zweit,
           coalesce((select json_agg(json_build_object('id', v.odoo_id, 'herkunft', v.herkunft) order by v.odoo_id)
                       from odoo_verweise v where v.krnl_tabelle = 'product_variants' and v.krnl_id = pv.id), '[]'::json) as odoo,
           on_hand_qty(pv.id)::float as bestand,
           (select count(distinct b.id)::int from bom_lines l join boms b on b.id = l.bom_id and b.active
             where l.component_variant_id = pv.id) as stuecklisten
    from product_variants pv
    join product_templates pt on pt.id = pv.template_id
    where pv.active = ${!f.archiv}
      ${f.shop === 'ja' ? sql`and pv.shopify_variant_id is not null` : f.shop === 'nein' ? sql`and pv.shopify_variant_id is null` : sql``}
      ${f.odoo === 'ja' ? sql`and ${mitOdoo()}` : f.odoo === 'nein' ? sql`and not ${mitOdoo()}` : sql``}
      ${f.sku === 'ja' ? sql`and nullif(pv.sku, '') is not null` : f.sku === 'nein' ? sql`and nullif(pv.sku, '') is null` : sql``}
      ${q
        ? sql`and (coalesce(pv.display_name, pt.name) ilike ${muster} or pv.sku ilike ${muster} or pv.barcode ilike ${muster}
                   or pv.shopify_variant_id ilike ${muster}
                   or exists (select 1 from shopify_zweitangebote z where z.variant_id = pv.id
                              and (z.produkt ilike ${muster} or z.sku ilike ${muster}))
                   or exists (select 1 from odoo_verweise v where v.krnl_tabelle = 'product_variants' and v.krnl_id = pv.id
                              and v.odoo_id::text = ${q}))`
        : sql``}
    order by coalesce(pv.display_name, pt.name), pv.id
    limit ${seite.limit} offset ${seite.offset}`
  return { zeilen, gesamt: zeilen[0]?.gesamt ?? 0 }
}

export async function zuordnungZahlen(): Promise<ZuordnungZahlen> {
  const [z] = await sql<ZuordnungZahlen[]>`
    select count(*)::int as artikel,
           count(*) filter (where pv.shopify_variant_id is not null)::int as mit_shop,
           count(*) filter (where ${mitOdoo()})::int as mit_odoo,
           count(*) filter (where nullif(pv.sku, '') is null)::int as ohne_sku,
           count(*) filter (where pt.can_be_sold and pv.shopify_variant_id is null)::int as verkaufbar_ohne_shop,
           count(*) filter (where pv.shopify_variant_id is null and not ${mitOdoo()}
                              and (on_hand_qty(pv.id) <> 0
                                   or exists (select 1 from bom_lines l join boms b on b.id = l.bom_id and b.active
                                              where l.component_variant_id = pv.id)))::int as ohne_alles,
           (select count(*)::int from shopify_unmatched_lines where resolved_at is null) as klaerfaelle,
           (select count(*)::int from shopify_zweitangebote) as zweitangebote
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.active`
  return z
}
