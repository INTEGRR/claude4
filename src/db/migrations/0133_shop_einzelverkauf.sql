-- ===========================================================================
-- 0133  Einzelverkauf steuern: Rückhalt für die Fertigung und Höchstmenge
-- ===========================================================================
-- Ein Teil ist EIN Artikel mit EINEM Bestand — auch wenn es im Shop einzeln
-- verkauft wird (Ersatzgehäuse, Mounting Plate) und zugleich in Tastaturen
-- steckt (Entscheidungslog 2026-11-23). Die Menge am Shop-Eintrag ist
-- deshalb eine Regel über diesem Bestand, kein zweiter Bestand:
--
--   shop_rueckhalt     so viele Stück gehören der Fertigung — einzeln
--                      verkaufbar ist nur, was darüber liegt
--   shop_hoechstmenge  nie mehr als so viele gleichzeitig einzeln anbieten
--
-- Beides gilt NUR für den Einzelverkauf des Artikels selbst. Tastaturen,
-- die das Teil brauchen, rechnen weiter mit dem vollen freien Bestand
-- (baubar/shop_frei bleiben unverändert) — anders als die Schwelle
-- shop_oos_unter, die als Notreserve für alles wirkt.

alter table product_variants
  add column shop_rueckhalt numeric(16,4)
    constraint product_variants_shop_rueckhalt_check check (shop_rueckhalt is null or shop_rueckhalt >= 0),
  add column shop_hoechstmenge int
    constraint product_variants_shop_hoechstmenge_check check (shop_hoechstmenge is null or shop_hoechstmenge >= 0);

comment on column product_variants.shop_rueckhalt is
  'Einzelverkauf: so viele Stück bleiben der Fertigung vorbehalten (null = kein Rückhalt) — 0133';
comment on column product_variants.shop_hoechstmenge is
  'Einzelverkauf: höchstens so viele gleichzeitig im Shop anbieten (null = keine Grenze) — 0133';

-- Menge, die der Shop-Eintrag eines Lagerartikels zeigen darf.
create or replace function shop_einzelverkauf(p_variant uuid) returns int
language sql stable
set search_path = public, pg_temp as $$
  select least(
           floor(greatest(shop_frei(pv.id) - coalesce(pv.shop_rueckhalt, 0), 0)),
           coalesce(pv.shop_hoechstmenge, 2147483647)
         )::int
  from product_variants pv
  where pv.id = p_variant;
$$;

comment on function shop_einzelverkauf(uuid) is
  'Einzelverkauf eines Lagerartikels: shop_frei − Rückhalt, höchstens die Höchstmenge (0133)';

-- shopify_soll_menge: unverändert bis auf den Zweig „nicht Made-to-Order".
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
    -- Lagerware: Rückhalt für die Fertigung und Höchstmenge (0133).
    return shop_einzelverkauf(p_variant);
  end if;
  select floor(b.menge + greatest(shop_frei(p_variant), 0)) into v_menge from baubar(p_variant, 0, true) b;
  if coalesce(v_cfg ->> 'modus', 'baubar') = 'fest' then
    return case when v_menge > v_puffer then v_deckel else 0 end;
  end if;
  return least(greatest(v_menge - v_puffer, 0), v_deckel)::int;
end $$;
