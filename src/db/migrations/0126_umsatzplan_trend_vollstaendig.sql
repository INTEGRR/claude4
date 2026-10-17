-- ============================================================================
-- 0126 — Umsatzplan-Trend nur aus vollständigem Vorjahresfenster (UX-Audit,
-- Entscheidungslog 2026-10-17)
--
-- Der Trend teilte die Summe der letzten drei Monate durch die Summe
-- derselben Monate im Vorjahr — fehlten dort Monate (Geschäft erst begonnen,
-- Lücke in der Historie), standen drei Monate gegen einen: Faktor bis zur
-- Kappung 4, Vorschläge vervielfacht. Jetzt gilt der Trend nur, wenn alle
-- drei Vorjahresmonate Umsatz haben; sonst ist er 1 (Vorjahresmonat
-- unverändert).
--
--  * umsatzplan_vorschlag (voller Körper aus 0061), nur der Trend geändert
-- ============================================================================

create or replace function umsatzplan_vorschlag(p_monat date)
returns numeric
language sql stable as $$
  with fenster as (
    select (date_trunc('month', current_date) - interval '3 months')::date as von,
           date_trunc('month', current_date)::date as bis   -- exklusiv
  ),
  hist as (
    select date_trunc('month', so.order_date)::date as monat, sum(t.net) as netto
    from sales_orders so
    cross join lateral sales_order_total(so.id) t
    where so.state = 'sale'
    group by 1
  ),
  aktuell as (
    select coalesce(sum(h.netto), 0) as summe, count(h.monat) as monate
    from fenster f
    left join hist h on h.monat >= f.von and h.monat < f.bis
  ),
  vorjahr_fenster as (
    select coalesce(sum(h.netto), 0) as summe,
           count(h.monat) filter (where h.netto > 0) as monate
    from fenster f
    left join hist h on h.monat >= (f.von - interval '12 months')::date
                    and h.monat < (f.bis - interval '12 months')::date
  ),
  trend as (
    select case when v.monate = 3 and v.summe > 0 and a.summe > 0
                then least(4, greatest(0.25, a.summe / v.summe))
                else 1 end as faktor
    from aktuell a, vorjahr_fenster v
  )
  select round(coalesce(
    (select h.netto from hist h
      where h.monat = (date_trunc('month', p_monat) - interval '12 months')::date)
      * (select faktor from trend),
    (select case when monate > 0 then summe / monate end from aktuell),
    0
  ), 2);
$$;
