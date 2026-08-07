-- ===========================================================================
-- Kennzahlen: Bestandswert, Deckungsbeitrag, Umschlag, Lieferantentreue,
--             RMA-Quote und Arbeitszeit
-- ===========================================================================
-- Die bisherigen Auswertungen zählen Mengen. Was fehlt, sind die Zahlen, an
-- denen sich das Geschäft messen lässt — und die sind teuer zu rechnen: sie
-- gehen über das gesamte Bewegungs- und Wertschichten-Ledger.
--
-- Deshalb materialisierte Sichten, die der Cron nachts (und auf Knopfdruck)
-- neu berechnet. Grundsatz wie überall: keine zweite Wahrheit — jede Zahl
-- leitet sich aus stock_moves und stock_valuation_layers ab.

-- Für eine verlässliche Reihenfolge in der Wertschicht: gleiche Zeitstempel
-- kommen bei Sammelbuchungen vor, die Einfügereihenfolge ist die Wahrheit.
alter table stock_valuation_layers add column seq bigserial;
create index stock_valuation_layers_seq_idx on stock_valuation_layers (variant_id, seq desc);

comment on column stock_valuation_layers.seq is
  'Laufende Nummer der Wertschicht — entscheidet bei gleichem Zeitstempel.';


-- ---------------------------------------------------------------------------
-- 1. Bestandswert im Zeitverlauf
-- ---------------------------------------------------------------------------
-- Der Wert am Monatsende ergibt sich aus der jüngsten Wertschicht bis dahin.
-- Das ist der einzige Weg, ohne Bestandsschnappschüsse auszukommen — und er
-- ist exakt, weil die Schichten unveränderlich sind.
create materialized view mv_stock_value_history as
with monate as (
  select generate_series(
           date_trunc('month', coalesce(
             (select min(created_at) from stock_valuation_layers), now())),
           date_trunc('month', now()),
           interval '1 month')::date as monat
),
varianten as (
  select distinct variant_id from stock_valuation_layers
)
select m.monat,
       v.variant_id,
       coalesce(letzte.qty_after, 0) as qty_end,
       coalesce(letzte.value_after, 0) as value_end
from monate m
cross join varianten v
left join lateral (
  select l.qty_after, l.value_after
  from stock_valuation_layers l
  where l.variant_id = v.variant_id
    and l.created_at < (m.monat + interval '1 month')
  order by l.seq desc
  limit 1
) letzte on true;

create unique index mv_stock_value_history_idx
  on mv_stock_value_history (monat, variant_id);

comment on materialized view mv_stock_value_history is
  'Bestandsmenge und -wert je Variante zum Monatsende, aus den Wertschichten.';


-- ---------------------------------------------------------------------------
-- 2. Deckungsbeitrag
-- ---------------------------------------------------------------------------
-- Die Marge entsteht bei der Auslieferung, nicht bei der Bestellung: dort
-- steht der Verkaufspreis der Auftragszeile dem tatsächlichen Wert der
-- ausgebuchten Ware gegenüber (gleitender Durchschnitt, Migration 0018).
--
-- Retouren laufen in die Gegenrichtung und werden mit umgekehrtem Vorzeichen
-- gerechnet — sonst stünde ein zurückgenommener Artikel als Gewinn im Buch.
create materialized view mv_contribution_margin as
select date_trunc('month', m.date_done)::date as monat,
       m.variant_id,
       sum(bewegung.vorzeichen * m.qty_done) as qty,
       sum(round(bewegung.vorzeichen * m.qty_done
                 * coalesce(zeile.price_unit, 0)
                 * (1 - coalesce(zeile.discount, 0) / 100.0), 4)) as revenue,
       sum(coalesce(-wert.value, 0)) as cost
from stock_moves m
join stock_pickings p on p.id = m.picking_id and p.origin_model = 'sales_order'
join lateral (
  select case
           when (select type from stock_locations where id = m.dest_location_id) = 'customer' then 1
           when (select type from stock_locations where id = m.src_location_id) = 'customer' then -1
         end as vorzeichen
) bewegung on bewegung.vorzeichen is not null
left join lateral (
  select l.price_unit, l.discount
  from sales_order_lines l
  where l.order_id = p.origin_id and l.variant_id = m.variant_id
  order by l.sequence
  limit 1
) zeile on true
left join lateral (
  select sum(v.value) as value
  from stock_valuation_layers v where v.move_id = m.id
) wert on true
where m.state = 'done' and m.date_done is not null
group by 1, 2;

create unique index mv_contribution_margin_idx
  on mv_contribution_margin (monat, variant_id);

comment on materialized view mv_contribution_margin is
  'Umsatz, Wareneinsatz und Menge je Variante und Monat — realisiert bei der '
  'Auslieferung, Retouren gegengerechnet.';


-- ---------------------------------------------------------------------------
-- 3. Lagerumschlag und Reichweite
-- ---------------------------------------------------------------------------
-- Umschlag = Wareneinsatz der letzten 12 Monate ÷ durchschnittlicher
-- Bestandswert. Reichweite = Bestand ÷ Tagesverbrauch der letzten 90 Tage.
create materialized view mv_inventory_turnover as
with einsatz as (
  select variant_id, sum(cost) as cogs, sum(revenue) as revenue
  from mv_contribution_margin
  where monat >= date_trunc('month', current_date) - interval '12 months'
  group by 1
),
mittelwert as (
  select variant_id, avg(value_end) as avg_value
  from mv_stock_value_history
  where monat >= date_trunc('month', current_date) - interval '12 months'
  group by 1
),
verbrauch as (
  -- Alles, was das Lager in Richtung Kunde oder Produktion verlassen hat
  select m.variant_id, sum(m.qty_done) as qty_90d
  from stock_moves m
  join stock_locations src on src.id = m.src_location_id and src.type = 'internal'
  join stock_locations dst on dst.id = m.dest_location_id and dst.type <> 'internal'
  where m.state = 'done' and m.date_done >= current_date - 90
  group by 1
)
select pv.id as variant_id,
       coalesce(pv.display_name, pt.name) as product,
       pv.sku,
       on_hand_qty(pv.id) as on_hand,
       pv.valuation_total as value_now,
       coalesce(mw.avg_value, 0) as avg_value_12m,
       coalesce(e.cogs, 0) as cogs_12m,
       coalesce(e.revenue, 0) as revenue_12m,
       coalesce(e.revenue, 0) - coalesce(e.cogs, 0) as margin_12m,
       case when coalesce(mw.avg_value, 0) > 0
            then round(coalesce(e.cogs, 0) / mw.avg_value, 2) end as turnover,
       coalesce(v.qty_90d, 0) / 90.0 as daily_use,
       case when coalesce(v.qty_90d, 0) > 0
            then round(on_hand_qty(pv.id) / (v.qty_90d / 90.0), 1) end as days_of_supply
from product_variants pv
join product_templates pt on pt.id = pv.template_id
left join einsatz e on e.variant_id = pv.id
left join mittelwert mw on mw.variant_id = pv.id
left join verbrauch v on v.variant_id = pv.id
where pv.active and pt.type = 'goods';

create unique index mv_inventory_turnover_idx on mv_inventory_turnover (variant_id);

comment on materialized view mv_inventory_turnover is
  'Umschlagshäufigkeit (12 Monate) und Reichweite in Tagen je Variante.';


-- ---------------------------------------------------------------------------
-- 4. Lieferantentreue
-- ---------------------------------------------------------------------------
-- Zwei Fragen an jeden Lieferanten: kommt er pünktlich, und liefert er die
-- bestellte Menge? Als Ist-Termin gilt der Tag des Wareneingangs.
create materialized view mv_supplier_otd as
with zeilen as (
  select po.vendor_id,
         date_trunc('month', coalesce(po.confirmed_at, po.created_at))::date as monat,
         pol.id as line_id,
         pol.qty,
         pol.qty_received,
         pol.date_planned::date as soll,
         (select min(m.date_done)::date
          from stock_moves m
          join stock_pickings p on p.id = m.picking_id
          where p.origin_model = 'purchase_order' and p.origin_id = po.id
            and m.variant_id = pol.variant_id and m.state = 'done') as ist
  from purchase_order_lines pol
  join purchase_orders po on po.id = pol.order_id
  where po.state in ('purchase', 'done') and pol.variant_id is not null
)
select z.vendor_id,
       pa.name as vendor,
       z.monat,
       count(*)::int as lines,
       count(*) filter (where z.ist is not null)::int as delivered,
       count(*) filter (where z.ist is not null and z.soll is not null and z.ist <= z.soll)::int as on_time,
       count(*) filter (where z.ist is null and z.soll < current_date)::int as overdue,
       round(avg(z.ist - z.soll) filter (where z.ist is not null and z.soll is not null), 1) as avg_delay_days,
       sum(z.qty) as qty_ordered,
       sum(z.qty_received) as qty_received
from zeilen z
join partners pa on pa.id = z.vendor_id
group by 1, 2, 3;

create unique index mv_supplier_otd_idx on mv_supplier_otd (vendor_id, monat);

comment on materialized view mv_supplier_otd is
  'Liefertreue je Lieferant und Monat: Termin- und Mengentreue aus '
  'Bestellzeilen gegen die tatsächlichen Wareneingänge.';


-- ---------------------------------------------------------------------------
-- 5. RMA-Quote
-- ---------------------------------------------------------------------------
-- Reparaturaufträge je Monat und Variante, gegen die ausgelieferte Menge
-- desselben Monats. Die Quote ist eine Näherung — ein Gerät kann Monate nach
-- dem Kauf zurückkommen —, taugt aber als Trend.
create materialized view mv_rma_analysis as
with rma as (
  select date_trunc('month', r.created_at)::date as monat,
         r.variant_id,
         count(*)::int as rma_count,
         count(*) filter (where r.state = 'repaired')::int as repaired,
         count(*) filter (where r.state = 'cancel')::int as cancelled,
         coalesce(sum((select sum(rp.qty) from repair_parts rp
                       where rp.repair_id = r.id and rp.part_type = 'add')), 0) as parts_used
  from repair_orders r
  where r.variant_id is not null
  group by 1, 2
),
geliefert as (
  select monat, variant_id, sum(qty) as qty_delivered
  from mv_contribution_margin
  group by 1, 2
)
select coalesce(rma.monat, g.monat) as monat,
       coalesce(rma.variant_id, g.variant_id) as variant_id,
       coalesce(rma.rma_count, 0) as rma_count,
       coalesce(rma.repaired, 0) as repaired,
       coalesce(rma.cancelled, 0) as cancelled,
       coalesce(rma.parts_used, 0) as parts_used,
       coalesce(g.qty_delivered, 0) as qty_delivered,
       case when coalesce(g.qty_delivered, 0) > 0
            then round(coalesce(rma.rma_count, 0)::numeric / g.qty_delivered * 100, 2) end as rma_rate
from rma
full outer join geliefert g on g.monat = rma.monat and g.variant_id = rma.variant_id
where coalesce(rma.rma_count, 0) > 0 or coalesce(g.qty_delivered, 0) > 0;

create unique index mv_rma_analysis_idx on mv_rma_analysis (monat, variant_id);

comment on materialized view mv_rma_analysis is
  'Reparaturaufträge je Monat und Variante gegen die ausgelieferte Menge.';


-- ---------------------------------------------------------------------------
-- 6. Arbeitszeit und Lohnkosten
-- ---------------------------------------------------------------------------
create materialized view mv_labor_hours as
select date_trunc('month', t.started_at at time zone 'Europe/Berlin')::date as monat,
       t.employee_id,
       e.name as employee,
       e.department,
       t.kind::text as kind,
       o.work_center_id,
       w.code as work_center,
       sum(t.minutes) as minutes,
       sum(round(t.minutes / 60.0 * t.hourly_cost, 4)) as cost
from time_entries t
join employees e on e.id = t.employee_id
left join mo_operations o on o.id = t.mo_operation_id
left join work_centers w on w.id = o.work_center_id
where t.ended_at is not null
group by 1, 2, 3, 4, 5, 6, 7;

create unique index mv_labor_hours_idx
  on mv_labor_hours (monat, employee_id, kind, coalesce(work_center_id, '00000000-0000-0000-0000-000000000000'::uuid));

comment on materialized view mv_labor_hours is
  'Erfasste Minuten und Lohnkosten je Monat, Mitarbeiter, Art und Arbeitsplatz.';


-- ---------------------------------------------------------------------------
-- 7. Neuberechnung
-- ---------------------------------------------------------------------------
/*
 * Rechnet alle Kennzahlen neu. Reihenfolge zählt: Umschlag und RMA-Quote
 * bauen auf Deckungsbeitrag und Wertverlauf auf.
 */
create or replace function refresh_analytics(p_actor text default 'system')
returns interval
language plpgsql as $$
declare v_start timestamptz := clock_timestamp();
begin
  refresh materialized view mv_stock_value_history;
  refresh materialized view mv_contribution_margin;
  refresh materialized view mv_inventory_turnover;
  refresh materialized view mv_supplier_otd;
  refresh materialized view mv_rma_analysis;
  refresh materialized view mv_labor_hours;

  insert into settings (key, value)
  values ('analytics', jsonb_build_object('refreshed_at', now()))
  on conflict (key) do update set value = excluded.value;

  return clock_timestamp() - v_start;
end $$;

comment on function refresh_analytics is
  'Berechnet alle materialisierten Kennzahlen neu (Cron: task=analytics).';

insert into settings (key, value)
values ('analytics', jsonb_build_object('refreshed_at', now()))
on conflict (key) do nothing;
