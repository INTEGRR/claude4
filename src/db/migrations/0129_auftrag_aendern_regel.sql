-- ============================================================================
-- 0129 — Auftragsänderung nach Option (c) (Entscheidungslog 2026-10-17)
--
-- Shopify führt bei Shop-Aufträgen: Positionen ändert der Shop, KRNL zieht per
-- Webhook nach (bestellaenderungNachziehen, 0115). Aufträge in KRNL (B2B)
-- bleiben änderbar, solange nichts geliefert ist — danach Korrektur über
-- Retoure oder neuen Auftrag. Der Shop-Import schreibt Positionen direkt und
-- ist von dieser Regel nicht betroffen.
-- ============================================================================

create or replace function sales_order_positionen_aenderbar(p_order uuid) returns text
language sql stable as $$
  select case
    when o.source = 'shopify'
      then 'Shop-Bestellungen ändert Shopify: bitte im Shopify-Admin bearbeiten — KRNL übernimmt Positionen, Lieferung und Fertigung automatisch'
    when exists (select 1 from sales_order_lines l where l.order_id = o.id and l.qty_delivered > 0)
      then 'Auftrag ' || o.number || ' ist schon geliefert oder teilgeliefert — Positionen lassen sich nicht mehr ändern (Korrektur über Retoure oder neuen Auftrag)'
  end
  from sales_orders o where o.id = p_order
$$;

comment on function sales_order_positionen_aenderbar(uuid) is
  'NULL = Positionen dürfen hinzugefügt/entfernt werden, sonst der Grund (0129, Option c).';

create or replace function sales_order_guard_positionen(p_order uuid) returns void
language plpgsql as $$
declare
  v_grund text;
begin
  perform sales_order_guard_editable(p_order);
  v_grund := sales_order_positionen_aenderbar(p_order);
  if v_grund is not null then
    raise exception '%', v_grund;
  end if;
end $$;
