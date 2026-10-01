import type { Sql, TransactionSql } from 'postgres'

/**
 * Shopify-Zweitangebote (0106): weitere Shop-Angebote mit der SKU eines
 * Artikels — die Bestandteil-Liste eines Bundles („Black Week Editions")
 * oder eine Aktions-Edition. Eine SKU bleibt genau ein Artikel
 * (Entscheidungslog 2026-09-29); das Zweitangebot bekommt beim
 * Bestandsabgleich nur dieselbe Menge (inventar.ts).
 *
 * Gefunden werden sie an zwei Stellen: beim Produktimport (Varianten, deren
 * SKU schon einem Artikel gehört — produkt-import.ts) und beim Lesen des
 * Shop-Stands (Shop-Varianten ohne Verknüpfung, deren SKU ein Artikel trägt
 * — inventar.ts, shopStandHolen). Bundles selbst sind nie Zweitangebote.
 */

export interface ShopAngebot {
  /** GID der Shop-Variante. */
  gid: string
  inventoryItemGid: string | null
  productGid: string | null
  /** Titel des Shop-Produkts. */
  produkt: string | null
  sku: string | null
  barcode: string | null
}

/**
 * Merkt (oder aktualisiert) ein Zweitangebot: die Shop-Variante gehört über
 * die SKU — sonst den Barcode — einem aktiven Artikel, ist aber nicht dessen
 * verknüpftes Angebot. Liefert die ID des Artikels, oder null, wenn kein
 * Artikel diese Kennung trägt (dann ist es kein Zweitangebot).
 */
export async function zweitangebotMerken(db: Sql | TransactionSql, a: ShopAngebot): Promise<string | null> {
  const sku = a.sku?.trim() || null
  const barcode = a.barcode?.trim() || null
  if (!sku && !barcode) return null
  const [zeile] = await db<{ variant_id: string }[]>`
    insert into shopify_zweitangebote
      (variant_id, shopify_variant_id, shopify_inventory_item_gid, shopify_product_id, produkt, sku)
    select pv.id, ${a.gid}, ${a.inventoryItemGid}, ${a.productGid}, ${a.produkt}, coalesce(${sku}, pv.sku)
    from product_variants pv
    where pv.active
      and pv.shopify_variant_id is distinct from ${a.gid}
      and ((${sku}::text is not null and pv.sku = ${sku})
        or (${barcode}::text is not null and pv.barcode = ${barcode}))
    -- SKU vor Barcode, das verknüpfte Angebot vor unverknüpften Artikeln
    order by (pv.sku is not distinct from ${sku}) desc, (pv.shopify_variant_id is not null) desc
    limit 1
    on conflict (shopify_variant_id) do update set
      variant_id = excluded.variant_id,
      shopify_inventory_item_gid =
        coalesce(excluded.shopify_inventory_item_gid, shopify_zweitangebote.shopify_inventory_item_gid),
      shopify_product_id = coalesce(excluded.shopify_product_id, shopify_zweitangebote.shopify_product_id),
      produkt = coalesce(excluded.produkt, shopify_zweitangebote.produkt),
      sku = excluded.sku
    returning variant_id`
  return zeile?.variant_id ?? null
}
