-- ===========================================================================
-- 0063  Nutzungsbericht light: drei Kerngrößen je Monat
-- ===========================================================================
-- Grundlage für Preisgespräche mit Pilotkunden (Entscheidung 2026-08:
-- Nutzungs-Reporting light statt Lizenzmodul): Wie viele Menschen arbeiten
-- mit der Instanz, wie viele Belege entstehen, wie stark wird die KI
-- genutzt? Die Zahlen bleiben in der Instanz — es gibt kein Phone-Home,
-- gezogen wird monatlich von Hand auf /einstellungen/nutzung.
--
-- Quellen (alles Bestandsdaten, rein additiv):
--   aktive_nutzer  = Konten, die im Monat im Audit-Log gehandelt haben
--                    (log_event schreibt actor = Anzeigename) oder eine
--                    Sprachsitzung hatten. System-Akteure ('system', 'demo',
--                    'seed', Cron) fallen durch den Join auf users heraus.
--   belege         = neu angelegte Kernbelege: Verkauf, Einkauf, Fertigung,
--                    Reparatur, Lieferantenrechnung.
--   ki_fragen      = Audit-Einträge model='ki' (jede Chat-Runde und jede
--                    ausgeführte KI-Aktion; die Chat-Zählung schreibt
--                    /api/ki seit diesem Release).
--   sprachsitzungen = Realtime-Sitzungen (sprachprotokolle).

create or replace function nutzungsbericht(p_monate int default 6)
returns table (
  monat           date,
  aktive_nutzer   integer,
  belege          integer,
  ki_fragen       integer,
  sprachsitzungen integer
)
language sql
stable
as $$
  with monate as (
    select generate_series(
      date_trunc('month', now()) - make_interval(months => greatest(p_monate, 1) - 1),
      date_trunc('month', now()),
      interval '1 month'
    )::date as monat
  ),
  nutzer as (
    select date_trunc('month', a.created_at)::date as monat, u.id as user_id
    from audit_log a
    join users u on u.name = a.actor
    union
    select date_trunc('month', s.begonnen_am)::date, s.user_id
    from sprachprotokolle s
  ),
  beleg as (
    select date_trunc('month', created_at)::date as monat from sales_orders
    union all
    select date_trunc('month', created_at)::date from purchase_orders
    union all
    select date_trunc('month', created_at)::date from manufacturing_orders
    union all
    select date_trunc('month', created_at)::date from repair_orders
    union all
    select date_trunc('month', created_at)::date from vendor_bills
  )
  select
    m.monat,
    (select count(distinct n.user_id)::int from nutzer n where n.monat = m.monat),
    (select count(*)::int from beleg b where b.monat = m.monat),
    (select count(*)::int from audit_log a
      where a.model = 'ki' and date_trunc('month', a.created_at)::date = m.monat),
    (select count(*)::int from sprachprotokolle s
      where date_trunc('month', s.begonnen_am)::date = m.monat)
  from monate m
  order by m.monat
$$;
