-- ===========================================================================
-- Auftragsstorno räumt die Fertigung mit auf
-- ===========================================================================
--
-- Bisher stornierte cancel_sales_order() nur die offenen Lieferungen und
-- ließ Fertigungsaufträge mit einer „manuell prüfen"-Notiz stehen. In der
-- Praxis heißt Storno bzw. Erstattung aber: die Arbeit entfällt.
--
-- Regel (je Fertigungsauftrag zum Auftrag):
--   nicht begonnen (kein Material entnommen)  → stornieren; die Bewegungs-
--     stornos geben die Reservierungen frei, der Bestand ist sofort wieder
--     verfügbar — es wurde ja nie etwas gebucht.
--   angebrochen (Material bereits entnommen)  → stehen lassen + deutliche
--     Notiz. Ein automatischer Storno würde Verbrauch ohne Ergebnis
--     hinterlassen; ob fertig gebaut oder demontiert wird, ist eine
--     menschliche Entscheidung.
--   erledigt                                   → bleibt; die Fertigware liegt
--     im Bestand und ist über die stornierte Lieferung wieder frei.
--
-- Erledigte Lieferungen bleiben unverändert Sache der Retoure.

create or replace function cancel_sales_order(p_order uuid, p_actor text default 'system')
returns void
language plpgsql as $$
declare
  o sales_orders%rowtype;
  p record;
  m record;
  v_fertig int;
begin
  select * into o from sales_orders where id = p_order for update;
  if o.id is null then raise exception 'Verkaufsauftrag nicht gefunden'; end if;
  if o.state = 'cancel' then return; end if;

  -- Offene Lieferungen stornieren (erledigte bleiben — Korrektur per Retoure).
  for p in
    select id from stock_pickings
    where origin_model = 'sales_order' and origin_id = p_order and state not in ('done', 'cancel')
  loop
    perform picking_cancel(p.id);
  end loop;

  for m in
    select id, number from manufacturing_orders
    where sales_order_id = p_order and state not in ('done', 'cancel')
  loop
    if exists (select 1 from stock_moves
               where production_id = m.id and state = 'done') then
      perform log_event('sales_order', p_order, 'note',
        format('Fertigungsauftrag %s ist angebrochen (Material bereits entnommen) und bleibt bestehen — fertig bauen oder demontieren.', m.number),
        p_actor);
    else
      perform mo_cancel(m.id, p_actor);
      perform log_event('sales_order', p_order, 'note',
        format('Fertigungsauftrag %s storniert, Materialreservierungen freigegeben.', m.number),
        p_actor);
    end if;
  end loop;

  select count(*) into v_fertig from manufacturing_orders
  where sales_order_id = p_order and state = 'done';
  if v_fertig > 0 then
    perform log_event('sales_order', p_order, 'note',
      'Die fertige Ware aus der bereits erledigten Fertigung liegt im Bestand und ist wieder frei verfügbar.',
      p_actor);
  end if;

  update sales_orders set state = 'cancel', locked = false where id = p_order;
  perform log_event('sales_order', p_order, 'state', 'Auftrag storniert', p_actor);
end $$;
