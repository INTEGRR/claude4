-- ===========================================================================
-- 0148  Zweitangebote: Produktstatus im Shop
-- ===========================================================================
-- Für verknüpfte Varianten merkt sich der Shop-Stand, ob das Shop-Produkt
-- aktiv, nur per Link erreichbar, Entwurf oder archiviert ist
-- (shopify_inventory_state.shop_status, 0101). Bei Zweitangeboten fehlte das:
-- in der vollständigen Bestandsliste (2026-11-28) stand ein Angebot aus einem
-- Entwurf deshalb als „ginge aus dem Verkauf", obwohl Kunden es gar nicht
-- sehen. Gefüllt wird die Spalte beim nächsten Lesen des Shop-Stands
-- (viertelstündlich und von Hand).

alter table shopify_zweitangebote add column if not exists shop_status text;

comment on column shopify_zweitangebote.shop_status is
  'Shop-Stand (gelesen, 0148): Status des Shop-Produkts — ACTIVE, UNLISTED, DRAFT, ARCHIVED';
