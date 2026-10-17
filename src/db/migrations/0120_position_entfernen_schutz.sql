-- ============================================================================
-- 0120 — Gelieferte/fakturierte Auftragspositionen nicht löschbar (UX-Audit)
--
-- verkauf.position_entfernen prüfte nur „gesperrt/storniert" — eine schon
-- gelieferte oder abgerechnete Zeile wurde hart gelöscht; Rechnungs- und
-- Retourenzeilen verloren ihren Bezug (on delete set null). Das ist nie
-- richtig, egal wie Auftragsänderungen nach der Bestätigung künftig geregelt
-- werden (Entscheidung offen, Vorlage docs/vorlagen/auftragsaenderung.md).
-- Alles andere am Positionsverhalten bleibt bis dahin unverändert.
-- ============================================================================

create or replace function sales_order_line_entfernbar(p_line uuid) returns text
language sql stable as $$
  select case
    when l.qty_delivered > 0 then 'Position ist schon (teilweise) geliefert'
    when l.qty_invoiced > 0
      or exists (select 1 from kundenrechnung_positionen kp where kp.sales_order_line_id = l.id)
      then 'Position steht auf einer Rechnung'
    when exists (select 1 from retoure_positionen rp where rp.sales_order_line_id = l.id)
      then 'Position steckt in einer Retoure'
  end
  from sales_order_lines l where l.id = p_line
$$;

comment on function sales_order_line_entfernbar(uuid) is
  'NULL = Position darf entfernt werden, sonst der Grund, warum nicht (0120).';

create or replace function sales_order_line_guard_entfernen(p_line uuid) returns void
language plpgsql as $$
declare
  v_grund text := sales_order_line_entfernbar(p_line);
begin
  if v_grund is not null then
    raise exception '% — sie kann nicht mehr entfernt werden (Korrektur über Retoure bzw. Gutschrift)', v_grund;
  end if;
end $$;
