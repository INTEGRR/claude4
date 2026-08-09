-- ===========================================================================
-- Bestandsmeldung an Shopify sofort statt viertelstündlich
-- ===========================================================================
--
-- Gegen Überverkäufe zählt jede Minute: verkauft der Shop weiter, was hier
-- gerade ausgebucht wurde, ist der Ärger programmiert. Deshalb reiht ab
-- jetzt JEDE Bestandsbuchung den Abgleich-Job ein — als Statement-Trigger
-- auf stock_quants, also einmal je Buchung, nicht je Zeile. Der
-- Dedupe-Schlüssel bündelt beliebig viele Buchungen zu einem Durchlauf,
-- und der Push überträgt ohnehin nur Varianten, deren Menge sich seit der
-- letzten Meldung geändert hat.
--
-- Ist Shopify nicht angebunden (keine gekoppelte Variante), entsteht gar
-- kein Job. Der viertelstündliche Abgleich bleibt als Sicherheitsnetz.

create or replace function trg_quants_inventar_push() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from product_variants where shopify_variant_id is not null) then
    perform enqueue_job('shopify_inventory_push', '{}'::jsonb, 'inventar-abgleich');
  end if;
  return null;
end $$;

drop trigger if exists quants_inventar_push on stock_quants;
create trigger quants_inventar_push
  after insert or update on stock_quants
  for each statement execute function trg_quants_inventar_push();
