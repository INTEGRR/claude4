-- ============================================================================
-- 0101  Shop-Verfügbarkeit: Regeln, Projekte, Shop-Stand
-- ----------------------------------------------------------------------------
-- Die baubare Menge (0100) allein reicht nicht — ANVIL steuert den Shop mit
-- festen Regeln (Entscheidungslog 2026-10-01, „Shop-Verfügbarkeit: Regeln"):
--
--   - Schwelle je Teil: „ausverkauft unter N Stück" (Blue Cases unter 2 →
--     alles mit Blue Case weg). Es zählt nur, was über der Schwelle liegt.
--   - Teil zurückhalten (Yellow Cases): zählt für den Shop als 0.
--   - Artikel bzw. Variante: auto (berechnet), immer (Deckel melden —
--     Switch-Tester, der 3D-Druck ist schnell nachgebaut), aus (0 — Black
--     Week Editions).
--   - Einzelne Optionswerte eines Artikels aus (z. B. Switches: Clicky Blue).
--
-- Die Regeln gelten NUR für das, was Shopify bekommt; baubar() ohne
-- Shop-Schalter bleibt die Fertigungssicht.
--
-- Dazu: product_templates.projekt fasst Shopify-Produkte zusammen, die im
-- Shop als EIN Artikel mit Farb-Pills erscheinen (Shopify erlaubt je Produkt
-- nur begrenzt viele Varianten — jede Gehäusefarbe ist ein eigenes Produkt),
-- und shopify_inventory_state hält den gelesenen Shop-Stand (Ist).
-- ============================================================================

alter table product_templates
  add column if not exists projekt text,
  add column if not exists shop_modus text not null default 'auto'
    check (shop_modus in ('auto', 'immer', 'aus'));

alter table product_variants
  add column if not exists shop_modus text check (shop_modus in ('auto', 'immer', 'aus')),
  add column if not exists shop_oos_unter int check (shop_oos_unter > 0),
  add column if not exists shop_zurueckhalten boolean not null default false;

comment on column product_templates.projekt is
  'Shop-Projekt: Shopify-Produkte, die im Shop als ein Artikel mit Farb-Pills erscheinen (0101)';
comment on column product_templates.shop_modus is
  'An Shopify: auto = berechnet, immer = Deckel, aus = 0 (0101)';
comment on column product_variants.shop_modus is
  'Wie product_templates.shop_modus für eine Variante; null = wie der Artikel (0101)';
comment on column product_variants.shop_oos_unter is
  'Als Teil/Artikel: für den Shop ausverkauft unter N Stück — zählt nur, was darüber liegt (0101)';
comment on column product_variants.shop_zurueckhalten is
  'Als Teil/Artikel zurückgehalten: zählt für den Shop als 0 (0101)';

create table if not exists shop_option_sperren (
  template_id uuid not null references product_templates on delete cascade,
  ptav_id     uuid not null references product_template_attribute_values on delete cascade,
  von         text,
  created_at  timestamptz not null default now(),
  primary key (template_id, ptav_id)
);

comment on table shop_option_sperren is
  'Optionswerte eines Artikels, die nicht an Shopify gemeldet werden (Soll 0), z. B. Switches: Clicky Blue (0101)';

alter table shopify_inventory_state
  add column if not exists shop_verkaufbar boolean,
  add column if not exists shop_tracked boolean,
  add column if not exists shop_policy text,
  add column if not exists shop_status text;

comment on column shopify_inventory_state.shop_verkaufbar is
  'Shop-Stand (gelesen, 0101): availableForSale der Variante';

-- Für den Shop nutzbarer freier Bestand eines Artikels/Teils: zurückgehalten
-- = 0; mit Schwelle N nur, was über N − 1 liegt (unter N ausverkauft).
create or replace function shop_frei(p_variant uuid) returns numeric
language sql stable
set search_path = public, pg_temp as $$
  select case
           when pv.shop_zurueckhalten then 0
           when pv.shop_oos_unter is not null then
             case when f.frei < pv.shop_oos_unter then 0 else f.frei - pv.shop_oos_unter + 1 end
           else f.frei
         end
  from product_variants pv
  cross join lateral (select free_to_use(pv.id) as frei) f
  where pv.id = p_variant;
$$;

-- baubar() bekommt den Shop-Schalter: mit p_shop zählen die Regeln der
-- Teile (Schwelle, zurückhalten). Die alte Signatur muss weichen, sonst wäre
-- der Aufruf baubar(x) mehrdeutig.
-- DESTRUKTIV: baubar(uuid, int) aus 0100 wird durch baubar(uuid, int, boolean) mit Standardwerten ersetzt; alle Aufrufe (baubar(x), baubar(x, n)) lösen auf die neue Funktion auf, shopify_soll_menge wird hier mit ersetzt.
drop function if exists baubar(uuid, int);

create or replace function baubar(p_variant uuid, p_tiefe int default 0, p_shop boolean default false)
returns table (menge numeric, engpass uuid)
language plpgsql stable
set search_path = public, pg_temp as $$
declare
  v_bom boms%rowtype;
  v_produkt_uom uuid;
  v_bom_menge numeric;
  c record;
  v_je numeric;
  v_frei numeric;
  v_unter numeric;
  v_reicht numeric;
  v_min numeric;
  v_engpass uuid;
begin
  select * into v_bom from boms where id = resolve_bom(p_variant);
  if v_bom.id is null then
    return query select 0::numeric, null::uuid;
    return;
  end if;
  select pt.uom_id into v_produkt_uom
  from product_variants pv join product_templates pt on pt.id = pv.template_id where pv.id = p_variant;
  v_bom_menge := uom_convert(v_bom.qty, v_bom.uom_id, v_produkt_uom);
  if coalesce(v_bom_menge, 0) <= 0 then
    return query select 0::numeric, null::uuid;
    return;
  end if;

  for c in
    select k.component_variant_id, k.qty, k.uom_id, pt.uom_id as komp_uom
    from bom_components_for_variant(v_bom.id, p_variant) k
    join product_variants pv on pv.id = k.component_variant_id
    join product_templates pt on pt.id = pv.template_id
    where pt.type = 'goods' and k.qty > 0
  loop
    v_je := uom_convert(c.qty, c.uom_id, c.komp_uom) / v_bom_menge;
    continue when coalesce(v_je, 0) <= 0;
    v_frei := greatest(case when p_shop then shop_frei(c.component_variant_id)
                            else free_to_use(c.component_variant_id) end, 0);
    if p_tiefe < 3 and resolve_bom(c.component_variant_id) is not null then
      select b.menge into v_unter from baubar(c.component_variant_id, p_tiefe + 1, p_shop) b;
      v_frei := v_frei + coalesce(v_unter, 0);
    end if;
    v_reicht := floor(v_frei / v_je);
    if v_min is null or v_reicht < v_min then
      v_min := v_reicht;
      v_engpass := c.component_variant_id;
    end if;
  end loop;

  return query select coalesce(v_min, 0), v_engpass;
end $$;

comment on function baubar(uuid, int, boolean) is
  'Baubare Menge einer Variante laut gefilterter Stückliste und Engpass-Teil (0100); p_shop: mit Shop-Regeln der Teile (0101)';

-- Steuerung einer Variante: Variante vor Artikel, sonst auto.
create or replace function shop_modus_von(p_variant uuid) returns text
language sql stable
set search_path = public, pg_temp as $$
  select coalesce(pv.shop_modus, pt.shop_modus, 'auto')
  from product_variants pv join product_templates pt on pt.id = pv.template_id
  where pv.id = p_variant;
$$;

-- Die Menge, die Shopify bekommt (0100, Regeln seit 0101):
--   aus → 0; immer → Deckel; gesperrter Optionswert → 0;
--   Made-to-Order → baubar mit Shop-Regeln + nutzbarer eigener Bestand,
--     minus Puffer, höchstens Deckel (Modus „fest": Deckel oder 0);
--   sonst → nutzbarer freier Bestand (Schwelle/zurückhalten), abgerundet.
create or replace function shopify_soll_menge(p_variant uuid) returns int
language plpgsql stable
set search_path = public, pg_temp as $$
declare
  v_modus text;
  v_cfg jsonb;
  v_menge numeric;
  v_puffer int;
  v_deckel int;
begin
  v_modus := shop_modus_von(p_variant);
  if v_modus = 'aus' then
    return 0;
  end if;
  select value -> 'mto' into v_cfg from settings where key = 'shopify';
  v_puffer := coalesce((v_cfg ->> 'puffer')::int, 2);
  v_deckel := coalesce((v_cfg ->> 'deckel')::int, 99);
  if v_modus = 'immer' then
    return v_deckel;
  end if;
  if exists (select 1 from shop_option_sperren s
             join product_variants pv on pv.template_id = s.template_id
             join product_variant_attribute_values a on a.variant_id = pv.id and a.ptav_id = s.ptav_id
             where pv.id = p_variant) then
    return 0;
  end if;
  if not ist_made_to_order(p_variant) then
    return floor(shop_frei(p_variant))::int;
  end if;
  select floor(b.menge + greatest(shop_frei(p_variant), 0)) into v_menge from baubar(p_variant, 0, true) b;
  if coalesce(v_cfg ->> 'modus', 'baubar') = 'fest' then
    return case when v_menge > v_puffer then v_deckel else 0 end;
  end if;
  return least(greatest(v_menge - v_puffer, 0), v_deckel)::int;
end $$;

comment on function shopify_soll_menge(uuid) is
  'An Shopify zu meldende Menge (0100/0101): Regeln aus/immer/Option, Made-to-Order aus baubar(…, true), sonst shop_frei';
