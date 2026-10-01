-- ============================================================================
-- 0106  Shopify-Zweitangebote: Bestand auch an weitere Angebote derselben SKU
-- ----------------------------------------------------------------------------
-- Eine SKU ist genau ein Artikel (Entscheidungslog 2026-09-29). Im Shop kann
-- dieselbe SKU aber in mehreren Angeboten stecken: in der Bestandteil-Liste
-- eines Bundles aus Shopifys Bundles-App („ANVIL NATIVE 75 - Black Week
-- Editions") oder in einer Aktions-Edition. Bisher bekam nur das verknüpfte
-- Angebot (product_variants.shopify_variant_id) den Bestand; die Bundles-App
-- rechnet die Bundle-Verfügbarkeit aber aus den Bestandteilen — also aus
-- Angeboten, die nie eine Meldung bekamen.
--
-- shopify_zweitangebote merkt sich je Zweitangebot (eigene Shop-Variante mit
-- eigenem InventoryItem) den Artikel, dem es gehört. Der Bestandsabgleich
-- meldet dorthin dieselbe Menge wie ans verknüpfte Angebot — in allen drei
-- Modi wie bisher (lesen: nichts, Probelauf: nur „würde senden", schreiben:
-- senden). Je Angebot eine eigene Steuerung (auto = wie der Artikel, immer =
-- Deckel, aus = 0): so lässt sich eine abgelaufene Aktion abschalten, ohne
-- den Artikel abzuschalten. Gefunden werden Zweitangebote beim Produktimport
-- und beim Lesen des Shop-Stands (viertelstündlich, „Shop-Stand holen").
--
-- Kein eigener Belegstatus: das Angebot ist ein Ableger des Artikels, die
-- Meldung bleibt ein Nebeneffekt des Abgleichs. Gemeldeter Stand, Probe-Stand
-- und Made-to-Order-Einrichtung stehen hier je Angebot wie in
-- shopify_inventory_state je Variante.
-- Entscheidungslog 2026-10-01, „Bestand an Zweitangebote".
-- ============================================================================

create table shopify_zweitangebote (
  id                         uuid primary key default gen_random_uuid(),
  variant_id                 uuid not null references product_variants on delete cascade,
  shopify_variant_id         text not null unique,
  shopify_inventory_item_gid text,
  shopify_product_id         text,
  produkt                    text,
  sku                        text,
  shop_modus                 text not null default 'auto' check (shop_modus in ('auto', 'immer', 'aus')),
  pushed_qty                 numeric(16,4),
  pushed_at                  timestamptz,
  push_fehler                text,
  push_fehler_qty            numeric(16,4),
  probe_qty                  numeric(16,4),
  probe_at                   timestamptz,
  mto_eingerichtet_at        timestamptz,
  probe_eingerichtet_at      timestamptz,
  shop_qty                   numeric(16,4),
  shop_seen_at               timestamptz,
  shop_verkaufbar            boolean,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz
);
select attach_touch_trigger('shopify_zweitangebote');

create index shopify_zweitangebote_variant_idx on shopify_zweitangebote (variant_id);
create unique index shopify_zweitangebote_item_idx
  on shopify_zweitangebote (shopify_inventory_item_gid)
  where shopify_inventory_item_gid is not null;

comment on table shopify_zweitangebote is
  'Weitere Shop-Angebote mit der SKU eines Artikels (Bundle-Bestandteile, Aktions-Editionen) — bekommen denselben Bestand (0106)';
comment on column shopify_zweitangebote.produkt is 'Titel des Shop-Angebots, z. B. „ANVIL NATIVE 75 - Black Week Editions"';
comment on column shopify_zweitangebote.shop_modus is
  'An Shopify: auto = wie der Artikel (shopify_soll_menge), immer = Deckel, aus = 0 (0106)';
comment on column shopify_zweitangebote.push_fehler is
  'Letzte Ablehnung durch Shopify (userErrors) — erneut versucht, sobald sich die Menge ändert';
comment on column shopify_zweitangebote.probe_qty is
  'Probelauf: Menge, die KRNL gemeldet HÄTTE — getrennt von pushed_qty (wie 0102)';

-- Die Menge, die ein Zweitangebot bekommt: aus → 0, immer → Deckel, sonst
-- dieselbe wie das verknüpfte Angebot des Artikels (alle Regeln aus 0101).
create or replace function shopify_soll_menge_zweitangebot(p_angebot uuid) returns int
language sql stable
set search_path = public, pg_temp as $$
  select case z.shop_modus
           when 'aus' then 0
           when 'immer' then coalesce(
             (select (value -> 'mto' ->> 'deckel')::int from settings where key = 'shopify'), 99)
           else shopify_soll_menge(z.variant_id)
         end
  from shopify_zweitangebote z
  where z.id = p_angebot;
$$;

comment on function shopify_soll_menge_zweitangebot(uuid) is
  'An ein Zweitangebot zu meldende Menge (0106): aus 0, immer Deckel, sonst shopify_soll_menge des Artikels';
