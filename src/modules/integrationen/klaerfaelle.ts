import type { Sql, TransactionSql } from 'postgres'

/**
 * Klärfälle je Shop-Artikel (Entscheidungslog 2026-11-23): dieselbe
 * Shop-Variante — ohne sie dieselbe SKU und derselbe Titel — ist EINE
 * Zuordnung. Am Release-Tag stehen schnell 200 Zeilen desselben Artikels;
 * die Sammelaktion `integrationen.klaerfaelle_aufloesen` löst sie auf.
 *
 * Bewusst datenbankfrei aufrufbar (Client als Parameter), damit die
 * Gruppierung im Prozesstest gegen eine echte Datenbank läuft.
 */

type Db = Sql | TransactionSql

export interface KlaerfallGruppe {
  variant_gid: string | null
  sku: string | null
  title: string | null
  zeilen: number
  stueck: number
  bestellungen: number
  seit: string
  /** KRNL-Variante, die schon mit dieser Shop-Variante oder SKU verknüpft ist. */
  erkannt_id: string | null
}

export async function klaerfallGruppen(db: Db): Promise<KlaerfallGruppe[]> {
  return db<KlaerfallGruppe[]>`
    with roh as (
      select u.variant_gid, u.sku, u.title, u.qty, u.shopify_order_id, u.created_at,
             coalesce(u.variant_gid, 'ohne:' || coalesce(u.sku, '') || '|' || coalesce(u.title, '')) as schluessel
      from shopify_unmatched_lines u
      where u.resolved_at is null),
    gruppen as (
      select max(variant_gid) as variant_gid, max(sku) as sku, max(title) as title,
             count(*)::int as zeilen, sum(qty)::float as stueck,
             count(distinct shopify_order_id)::int as bestellungen, min(created_at) as seit
      from roh
      group by schluessel)
    select g.*,
           (select pv.id from product_variants pv
             where pv.active
               and ((g.variant_gid is not null and pv.shopify_variant_id = g.variant_gid)
                 or (coalesce(g.sku, '') <> '' and pv.sku = g.sku))
             order by (pv.shopify_variant_id = g.variant_gid) desc nulls last limit 1) as erkannt_id
    from gruppen g order by g.zeilen desc limit 50`
}
