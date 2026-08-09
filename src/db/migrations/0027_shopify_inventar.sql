-- ===========================================================================
-- Shopify: Bestandsabgleich (verfügbare Menge an den Shop melden)
-- ===========================================================================
--
-- Das ERP ist die Quelle der Wahrheit für Bestände. Der Shop bekommt die
-- frei verfügbare Menge (Bestand minus Reservierungen an internen Orten)
-- gemeldet, damit er nichts verkauft, was nicht da ist.
--
-- Gemerkt wird je Variante, was zuletzt gemeldet wurde (pushed_qty) und was
-- der Shop zuletzt selbst berichtet hat (shop_qty, aus dem Webhook
-- inventory_levels/update). Weichen Shop und ERP voneinander ab — etwa weil
-- jemand im Shopify-Admin von Hand korrigiert hat —, ist das eine Abweichung,
-- die sichtbar gemacht und beim nächsten Abgleich überschrieben wird.

-- Shopify adressiert Bestände nicht über die Variante, sondern über deren
-- InventoryItem. Die Zuordnung ändert sich nie und wird einmal erfragt.
alter table product_variants add column if not exists shopify_inventory_item_gid text;
create unique index if not exists product_variants_inventory_item_idx
  on product_variants (shopify_inventory_item_gid)
  where shopify_inventory_item_gid is not null;

create table shopify_inventory_state (
  variant_id   uuid primary key references product_variants on delete cascade,
  pushed_qty   numeric(16,4),           -- zuletzt an den Shop gemeldet
  pushed_at    timestamptz,
  shop_qty     numeric(16,4),           -- zuletzt VOM Shop gemeldet (Webhook)
  shop_seen_at timestamptz,
  updated_at   timestamptz
);
select attach_touch_trigger('shopify_inventory_state');

/*
 * Abweichungen zwischen Shop und ERP. Eine Zeile heißt: der Shop glaubt
 * etwas anderes als wir. Quelle ist immer die letzte Meldung des Shops —
 * ohne dessen Webhook bleibt die Sicht leer, dann gibt es nur den Push.
 */
create or replace view shopify_inventory_drift as
  select
    s.variant_id,
    v.sku,
    free_to_use(s.variant_id) as erp_menge,
    s.shop_qty                as shop_menge,
    s.shop_seen_at,
    s.pushed_at
  from shopify_inventory_state s
  join product_variants v on v.id = s.variant_id
  where s.shop_qty is not null
    and s.shop_qty <> free_to_use(s.variant_id);
