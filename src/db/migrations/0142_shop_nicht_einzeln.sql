-- ===========================================================================
-- 0142  Shop-Regeln eines Teils: zwei getrennte Schalter statt „zurückhalten"
-- ===========================================================================
-- „Zurückhalten" (0101) ließ ein Teil für den Shop als 0 zählen — auch in
-- jeder Tastatur, die es braucht. Der Betreiber hat es am 27.11. an allen
-- sechs NATIVE-75-Gehäusen gesetzt, um sie nicht EINZELN zu verkaufen; damit
-- waren 344 von 345 Tastatur-Varianten ausverkauft. Ein Wort, zwei
-- Bedeutungen. Jetzt zwei Schalter mit klarem Namen (Entscheidungslog
-- 2026-11-27):
--
--   shop_nicht_einzeln   „Nicht einzeln verkaufen": der eigene Shop-Eintrag
--                        des Teils bekommt 0; Tastaturen mit dem Teil
--                        rechnen mit dem vollen Bestand.            (NEU)
--   shop_zurueckhalten   „Für den Shop sperren": das Teil zählt als 0 —
--                        auch in jeder Tastatur, die es braucht.   (wie bisher)

alter table product_variants
  add column shop_nicht_einzeln boolean not null default false;

comment on column product_variants.shop_nicht_einzeln is
  'Nicht einzeln verkaufen: der eigene Shop-Eintrag bekommt 0, Tastaturen mit dem Teil sind nicht betroffen — 0142';
comment on column product_variants.shop_zurueckhalten is
  'Für den Shop sperren: zählt als 0 — auch in jeder Tastatur, die das Teil braucht (0101; Name der Spalte historisch) — 0142';

-- Die bisher gesetzten Häkchen waren als „nicht einzeln verkaufen" gemeint
-- (Entscheidung des Betreibers): sie ziehen in den neuen Schalter um, die
-- Sperre wird aufgehoben. Wer wirklich sperren will, setzt den Schalter neu.
update product_variants
   set shop_nicht_einzeln = true, shop_zurueckhalten = false
 where shop_zurueckhalten;

-- Einzelverkauf eines Lagerartikels: mit „nicht einzeln verkaufen" 0, sonst
-- wie bisher shop_frei − Rückhalt, höchstens die Höchstmenge (0133).
create or replace function shop_einzelverkauf(p_variant uuid) returns int
language sql stable
set search_path = public, pg_temp as $$
  select case
           when pv.shop_nicht_einzeln then 0
           else least(
                  floor(greatest(shop_frei(pv.id) - coalesce(pv.shop_rueckhalt, 0), 0)),
                  coalesce(pv.shop_hoechstmenge, 2147483647)
                )::int
         end
  from product_variants pv
  where pv.id = p_variant;
$$;

comment on function shop_einzelverkauf(uuid) is
  'Einzelverkauf eines Lagerartikels: 0 bei „nicht einzeln verkaufen", sonst shop_frei − Rückhalt, höchstens die Höchstmenge (0133, 0142)';
