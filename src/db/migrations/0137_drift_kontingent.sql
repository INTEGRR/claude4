-- ===========================================================================
-- 0137  Abweichungs-Sicht vergleicht mit dem Kontingent
-- ===========================================================================
-- Seit 0136 bekommt der Shop das KONTINGENT eines Angebots, nicht mehr die
-- Menge ohne Teilen. Die Monitor-Sicht „Shop weicht ab" vergleicht deshalb
-- den Shop-Stand mit dem Kontingent (solange noch keines gerechnet wurde:
-- mit der Soll-Menge wie bisher). Spalten unverändert.

create or replace view shopify_inventory_drift as
  select s.variant_id,
         v.sku,
         coalesce(s.kontingent, shopify_soll_menge(s.variant_id))::numeric as erp_menge,
         s.shop_qty as shop_menge,
         s.shop_seen_at,
         s.pushed_at
  from shopify_inventory_state s
  join product_variants v on v.id = s.variant_id
  where s.shop_qty is not null
    and s.shop_qty <> coalesce(s.kontingent, shopify_soll_menge(s.variant_id))::numeric;
