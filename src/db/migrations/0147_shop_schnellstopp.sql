-- ===========================================================================
-- 0147  Schnellstopp: nach einer Bestellung gezielt sperren, was nicht mehr geht
-- ===========================================================================
-- Modus „feste Menge" (Entscheidungslog 2026-11-28): jedes Angebot steht voll
-- im Shop, bis ein Teil seiner Stückliste nur noch für „Puffer" Stück reicht —
-- dann müssen ALLE Angebote mit diesem Teil auf 0. Bisher rechnete dafür jeder
-- Durchlauf alle Shop-Angebote neu (in der Produktion gemessen: 5 bis 15
-- Sekunden). Hier die gezielte Frage: Welche Angebote müssen JETZT auf 0,
-- weil diese eine Bestellung ein Teil unter die Schwelle gebracht hat?
--
-- Der Regelfall (kein Teil ist knapp) kostet ein paar Millisekunden: nur die
-- Teile der verkauften Artikel werden angesehen. Erst wenn eines knapp ist,
-- werden die Angebote geprüft, in deren Stückliste es steht — und davon nur
-- die, die laut Buch noch etwas im Shop stehen haben.

-- Die Stücklisten nach Teil durchsuchen (bisher nur nach Stückliste indiziert).
create index if not exists bom_lines_component_idx on bom_lines (component_variant_id);

-- Größter Verbrauch eines Teils je gefertigtem Stück, über alle aktiven
-- Stücklisten. Bewusst OHNE die Variantenfilter der Zeilen: die Summe aller
-- Zeilen einer Stückliste ist mindestens so groß wie der Verbrauch jeder
-- einzelnen Variante — „knapp" wird damit eher zu früh als zu spät erkannt.
create or replace function shop_je_max(p_komponente uuid) returns numeric
language sql stable
set search_path = public, pg_temp as $$
  select coalesce(max(x.je), 1)
  from (
    select sum(uom_convert(bl.qty, bl.uom_id, kt.uom_id))
           / nullif(uom_convert(b.qty, b.uom_id, pt.uom_id), 0) as je
    from bom_lines bl
    join boms b on b.id = bl.bom_id and b.active
    join product_templates pt on pt.id = b.template_id
    join product_variants kv on kv.id = bl.component_variant_id
    join product_templates kt on kt.id = kv.template_id
    where bl.component_variant_id = p_komponente
    group by b.id, b.qty, b.uom_id, pt.uom_id
  ) x;
$$;

comment on function shop_je_max(uuid) is
  'Größter Verbrauch eines Teils je Stück über alle aktiven Stücklisten, ohne Variantenfilter — Obergrenze für den Schnellstopp (0147)';

-- Welche Shop-Angebote müssen nach dem Verkauf dieser Artikel auf 0?
--   art 'v' = verknüpfte Variante, 'z' = Zweitangebot.
-- Geliefert wird nur, was laut Buch noch eine Menge im Shop stehen hat und
-- nach shopify_soll_menge() jetzt 0 bekäme — dieselbe Rechnung wie der volle
-- Abgleich, nur auf die betroffenen Angebote beschränkt.
create or replace function shop_stopp_kandidaten(p_variants uuid[])
returns table (art text, id uuid, inventory_item_gid text, bezeichnung text)
language plpgsql stable
set search_path = public, pg_temp as $$
declare
  v_puffer int;
  v_teile uuid[];
  v_knapp uuid[];
begin
  if p_variants is null or cardinality(p_variants) = 0 then
    return;
  end if;
  select coalesce((value -> 'mto' ->> 'puffer')::int, 2) into v_puffer from settings where key = 'shopify';
  v_puffer := coalesce(v_puffer, 2);

  -- 1. Was diese Artikel verbrauchen: die Teile ihrer Stückliste (bei
  --    Lagerware der Artikel selbst) — und die Artikel selbst, falls sie aus
  --    Fertigbestand verkauft wurden.
  select array_agg(distinct b.komponente) into v_teile
  from unnest(p_variants) v cross join lateral shop_bedarf(v) b;
  v_teile := coalesce(v_teile, '{}'::uuid[]) || p_variants;

  -- 2. Knapp ist ein Teil, wenn es beim größten Verbraucher nur noch für
  --    höchstens „Puffer" Stück reicht (genau die Schwelle, unter der
  --    shopify_soll_menge() ein Angebot auf 0 setzt).
  select array_agg(distinct t) into v_knapp
  from unnest(v_teile) t
  where floor(greatest(shop_frei(t), 0) / shop_je_max(t)) <= v_puffer;

  return query
  with recursive hoch(vid, tiefe) as (
    -- Angebote, in deren Stückliste ein knappes Teil steht — auch über
    -- Baugruppen (so tief, wie baubar() rechnet).
    select t, 0 from unnest(coalesce(v_knapp, '{}'::uuid[])) t
    union
    select pv.id, h.tiefe + 1
    from hoch h
    join bom_lines bl on bl.component_variant_id = h.vid
    join boms b on b.id = bl.bom_id and b.active
    join product_variants pv on pv.template_id = b.template_id
                            and (b.variant_id is null or b.variant_id = pv.id) and pv.active
    where h.tiefe < 4
  ),
  betroffen as (
    select vid from hoch
    union
    select t from unnest(v_teile) t
  ),
  -- Nur was laut Buch noch im Shop steht — ein schon gesperrtes Angebot wird
  -- nicht bei jeder weiteren Bestellung neu gerechnet.
  offen_v as materialized (
    select pv.id, pv.shopify_inventory_item_gid as gid, coalesce(nullif(pv.sku, ''), pv.display_name) as bez
    from betroffen x
    join product_variants pv on pv.id = x.vid and pv.active and pv.shopify_variant_id is not null
    join shopify_inventory_state s on s.variant_id = pv.id
    where s.pushed_qty > 0 and s.buch_ab is not null
  ),
  offen_z as materialized (
    select z.id, z.shopify_inventory_item_gid as gid, coalesce(z.sku, z.produkt, z.shopify_variant_id) as bez
    from betroffen x
    join shopify_zweitangebote z on z.variant_id = x.vid
    where z.pushed_qty > 0 and z.buch_ab is not null
      and not exists (select 1 from product_variants p2 where p2.shopify_variant_id = z.shopify_variant_id)
  )
  select 'v'::text, o.id, o.gid, o.bez from offen_v o where shopify_soll_menge(o.id) = 0
  union all
  select 'z'::text, o.id, o.gid, o.bez from offen_z o where shopify_soll_menge_zweitangebot(o.id) = 0;
end $$;

comment on function shop_stopp_kandidaten(uuid[]) is
  'Schnellstopp (0147): Shop-Angebote, die nach dem Verkauf dieser Artikel auf 0 müssen — nur Angebote mit einem knappen Teil in der Stückliste, die laut Buch noch im Shop stehen';
