-- ============================================================================
-- 0100  Made-to-Order an Shopify: baubare Menge statt Lagerbestand
-- ----------------------------------------------------------------------------
-- Tastaturen werden auf Auftrag gefertigt (Route Fertigen + Auf Auftrag):
-- ihr Lagerbestand ist immer 0, verkauft werden sie trotzdem. Shopify bekommt
-- für sie die BAUBARE Menge — was das freie Material laut Stückliste noch
-- hergibt —, damit eine Variante ausverkauft ist, sobald ein Teil fehlt.
-- Alle anderen Artikel melden weiter den freien Bestand.
-- Entscheidungslog 2026-10-01, „Made-to-Order: baubare Menge an Shopify".
-- ============================================================================

-- Baubare Menge einer Variante über die gefilterte Stückliste: je Teil
-- freier Bestand ÷ Menge je Stück, das Minimum gewinnt (Engpass).
-- Halbfabrikate mit eigener Stückliste zählen ihren freien Bestand plus
-- das, was aus ihren Teilen baubar ist (bis Tiefe 3). Offene Aufträge sind
-- enthalten: ihre Fertigungsaufträge reservieren die Teile (free_to_use).
create or replace function baubar(p_variant uuid, p_tiefe int default 0)
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
    v_frei := greatest(free_to_use(c.component_variant_id), 0);
    if p_tiefe < 3 and resolve_bom(c.component_variant_id) is not null then
      select b.menge into v_unter from baubar(c.component_variant_id, p_tiefe + 1) b;
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

comment on function baubar(uuid, int) is
  'Baubare Menge einer Variante aus freiem Material laut gefilterter Stückliste (0100) und das Engpass-Teil';

-- Made-to-Order = Route Fertigen + Auf Auftrag mit aktiver Fertigungs-Stückliste.
create or replace function ist_made_to_order(p_variant uuid) returns boolean
language sql stable
set search_path = public, pg_temp as $$
  select coalesce(bool_and(pt.route_manufacture and pt.route_mto), false) and resolve_bom(p_variant) is not null
  from product_variants pv join product_templates pt on pt.id = pv.template_id
  where pv.id = p_variant;
$$;

-- Die Menge, die Shopify für eine Variante bekommen soll.
--   Made-to-Order: baubare Menge + freier Bestand des Fertigprodukts selbst
--   (Retouren, Muster), abzüglich Puffer, gedeckelt — oder im Modus „fest"
--   der Deckel, solange mehr als der Puffer baubar ist, sonst 0.
--   Sonst: freier Bestand, abgerundet (wie bisher).
-- Einstellung settings.shopify.mto = {modus: 'baubar'|'fest', puffer, deckel};
-- ohne Eintrag baubar / 2 / 99.
create or replace function shopify_soll_menge(p_variant uuid) returns int
language plpgsql stable
set search_path = public, pg_temp as $$
declare
  v_cfg jsonb;
  v_menge numeric;
  v_puffer int;
  v_deckel int;
begin
  if not ist_made_to_order(p_variant) then
    return floor(free_to_use(p_variant))::int;
  end if;
  select value -> 'mto' into v_cfg from settings where key = 'shopify';
  v_puffer := coalesce((v_cfg ->> 'puffer')::int, 2);
  v_deckel := coalesce((v_cfg ->> 'deckel')::int, 99);
  select floor(b.menge + greatest(free_to_use(p_variant), 0)) into v_menge from baubar(p_variant) b;
  if coalesce(v_cfg ->> 'modus', 'baubar') = 'fest' then
    return case when v_menge > v_puffer then v_deckel else 0 end;
  end if;
  return least(greatest(v_menge - v_puffer, 0), v_deckel)::int;
end $$;

comment on function shopify_soll_menge(uuid) is
  'An Shopify zu meldende Menge (0100): Made-to-Order aus baubar() mit Puffer/Deckel, sonst freier Bestand';

-- Anstoß für den Bestandsabgleich: Job einreihen (gebündelt) UND einen
-- Zähler erhöhen. Läuft gerade ein Abgleich, verpufft das Einreihen (der
-- Schlüssel ist belegt) — der laufende Abgleich sieht am Zähler, dass sich
-- etwas geändert hat, und rechnet sofort eine weitere Runde.
create or replace function inventar_abgleich_anstossen() returns void
language plpgsql
set search_path = public, pg_temp as $$
begin
  insert into shopify_sync_state (key, value)
  values ('inventar_anstoss', jsonb_build_object('n', 1))
  on conflict (key) do update
    set value = jsonb_build_object('n', coalesce((shopify_sync_state.value ->> 'n')::bigint, 0) + 1),
        updated_at = now();
  perform enqueue_job('shopify_inventory_push', '{}'::jsonb, 'inventar-abgleich');
end $$;

-- Made-to-Order-Varianten werden in Shopify einmal eingerichtet: Menge
-- verfolgen an, „weiterverkaufen bei 0" aus — sonst wäre 0 nicht ausverkauft.
alter table shopify_inventory_state add column if not exists mto_eingerichtet_at timestamptz;

comment on column shopify_inventory_state.mto_eingerichtet_at is
  'Made-to-Order-Variante in Shopify eingerichtet (tracked, inventoryPolicy DENY) — 0100';

-- Die Abweichungs-Sicht vergleicht mit dem, was gemeldet werden SOLL — für
-- Tastaturen die baubare Menge, nicht der (immer leere) Lagerbestand.
-- Spalten bleiben gleich (Name erp_menge), nur die Quelle wechselt.
create or replace view shopify_inventory_drift as
  select
    s.variant_id,
    v.sku,
    shopify_soll_menge(s.variant_id)::numeric as erp_menge,
    s.shop_qty                as shop_menge,
    s.shop_seen_at,
    s.pushed_at
  from shopify_inventory_state s
  join product_variants v on v.id = s.variant_id
  where s.shop_qty is not null
    and s.shop_qty <> shopify_soll_menge(s.variant_id);
