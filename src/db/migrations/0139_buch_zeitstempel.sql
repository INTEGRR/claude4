-- ===========================================================================
-- 0139  Buch: bis wann Bestellungen gezählt sind — verspätete Meldungen erkennen
-- ===========================================================================
-- Lasttest 2026-11-27: Bestands-Webhooks des Shops kommen verspätet und in
-- vertauschter Reihenfolge. Eine Meldung „Shop zeigt 4" von 12:00:01 sah
-- nach „mehr als das Buch (3)" aus, obwohl das Buch nur schon die
-- Bestellung von 12:00:02 abgezogen hatte — das Buch übernahm den alten
-- Stand, lag danach zu hoch und hielt Teile fest, die niemand mehr kaufen
-- konnte (12 von 92 Gehäusen blieben liegen).
--
-- buch_bestellt_bis merkt je Angebot den Zeitpunkt der jüngsten gezählten
-- Bestellung. Eine Shop-Meldung zählt als „mehr" nur, wenn sie JÜNGER ist.
--
-- Zweitens die Frist nach einer absoluten Meldung: sie steckt jetzt in
-- buch_ab selbst (eigene Uhr: jetzt + 5 s; Zeitpunkt aus dem Shop: genau),
-- nicht mehr pauschal im Vergleich — nach einer Übernahme des Shop-Stands
-- gingen sonst fünf Sekunden Bestellungen am Buch vorbei.

alter table shopify_inventory_state add column buch_bestellt_bis timestamptz;
alter table shopify_zweitangebote add column buch_bestellt_bis timestamptz;
comment on column shopify_inventory_state.buch_bestellt_bis is
  'Anlagezeit der jüngsten gegen das Buch gezählten Bestellung — ältere Shop-Meldungen gelten als überholt (0139)';

create or replace function shop_buch_bestellung(p_variant_gid text, p_menge numeric, p_zeit timestamptz)
returns void language plpgsql set search_path to 'public', 'pg_temp' as $$
begin
  if p_variant_gid is null or coalesce(p_menge, 0) = 0 then return; end if;
  update shopify_inventory_state s
     set pushed_qty = s.pushed_qty - p_menge,
         buch_bestellt_bis = greatest(s.buch_bestellt_bis, p_zeit)
    from product_variants v
   where v.id = s.variant_id and v.shopify_variant_id = p_variant_gid
     and s.pushed_qty is not null and s.buch_ab is not null
     and p_zeit > s.buch_ab;
  update shopify_zweitangebote z
     set pushed_qty = z.pushed_qty - p_menge,
         buch_bestellt_bis = greatest(z.buch_bestellt_bis, p_zeit)
   where z.shopify_variant_id = p_variant_gid
     and z.pushed_qty is not null and z.buch_ab is not null
     and p_zeit > z.buch_ab
     and not exists (select 1 from product_variants x where x.shopify_variant_id = z.shopify_variant_id);
end $$;
