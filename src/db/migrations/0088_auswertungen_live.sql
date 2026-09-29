-- ============================================================================
-- 0088  Auswertungen in Echtzeit — und der Einkaufspreis bewertet neu
-- ----------------------------------------------------------------------------
-- Gefunden im Parallelbetrieb (2026-09-29): Nach einer Inventur und nach dem
-- Pflegen von Einkaufspreisen bewegten sich die Auswertungen nicht.
--
--   1. Die Kennzahlen lasen materialisierte Sichten (0023), die auf Vercel
--      kein Cron neu berechnet — sie standen still. Jetzt sind es normale
--      Sichten gleichen Namens: jede Abfrage rechnet aus dem, was in der
--      Datenbank steht. (Die Namen mv_* bleiben, damit Seiten, KI-Schema und
--      gespeicherte Abfragen weiter passen; sie sind historisch.)
--   2. Ein geänderter Einkaufspreis bewertete den Bestand nicht neu — der
--      gleitende Durchschnitt hatte Vorrang und blieb stehen, und was mit
--      0 € eingebucht war (Shopify-Artikel ohne Preis, danach Inventur),
--      blieb für immer bei 0 €. Jetzt ist der Einkaufspreis führend: seine
--      Änderung bucht eine Neubewertungsschicht (Revision der AVCO-
--      Entscheidung vom 2026-08-07, Entscheidungslog 2026-09-29).
--   3. Deckungsbeitrag und Umschlag rechnen „zu heutigen Einstandspreisen"
--      (einstandspreis_aktuell) und zählen auch Aufträge ohne Lieferschein
--      (historisch übernommen) — realisiert am Auftragsdatum.
-- ============================================================================

-- --- 1. Aktueller Einstandspreis ---------------------------------------------
-- Gleitender Durchschnitt, sonst Einkaufspreis, sonst Stücklistenkosten
-- (Komponenten zu IHREM aktuellen Einstandspreis, mehrstufig, mit Bremse).
create or replace function einstandspreis_aktuell(p_variant uuid, p_tiefe int default 0)
returns numeric
language plpgsql stable
set search_path = public, pg_temp as $$
declare
  v_mac numeric;
  v_std numeric;
  v_bom uuid;
  v_summe numeric;
begin
  select pv.moving_avg_cost, pt.standard_cost into v_mac, v_std
  from product_variants pv
  join product_templates pt on pt.id = pv.template_id
  where pv.id = p_variant;

  if coalesce(v_mac, 0) > 0 then return v_mac; end if;
  if coalesce(v_std, 0) > 0 then return v_std; end if;
  if p_tiefe >= 5 then return 0; end if;

  v_bom := resolve_bom(p_variant);
  if v_bom is null then return 0; end if;

  select sum(c.qty * einstandspreis_aktuell(c.component_variant_id, p_tiefe + 1))
    into v_summe
  from bom_explode(v_bom, p_variant, 1) c;
  return round(coalesce(v_summe, 0), 6);
end $$;

comment on function einstandspreis_aktuell is
  'Einstandspreis je Stück heute: gleitender Durchschnitt, sonst Einkaufspreis, sonst Stücklistenkosten.';

-- --- 2. Einkaufspreis ist führend: Neubewertung bei Änderung -----------------
create or replace function einstandspreis_neubewerten(p_template uuid, p_actor text default 'system')
returns int
language plpgsql
set search_path = public, pg_temp as $$
declare
  v_preis numeric;
  v record;
  v_diff numeric;
  v_menge numeric;
  v_anzahl int := 0;
begin
  select standard_cost into v_preis from product_templates
  where id = p_template and type = 'goods';
  -- Ein leerer Preis heißt „unbekannt", nicht „wertlos" — nichts abwerten.
  if coalesce(v_preis, 0) <= 0 then return 0; end if;

  for v in
    select pv.id, pv.valued_qty, pv.valuation_total
    from product_variants pv where pv.template_id = p_template
    for update
  loop
    -- Bewerteter Bestand: Wert auf Menge × neuer Preis bringen.
    if v.valued_qty > 0 then
      v_diff := round(v.valued_qty * v_preis - v.valuation_total, 4);
      if abs(v_diff) >= 0.0001 then
        perform valuation_apply(v.id, null, 'revaluation', 0, null, v_diff,
          'Neubewertung: Einkaufspreis ' || v_preis::text);
        v_anzahl := v_anzahl + 1;
      end if;
    else
      update product_variants set moving_avg_cost = v_preis where id = v.id;
    end if;

    -- Bisher unbewertete Menge (Bestand ohne Wertschicht) gleich mitbewerten.
    v_menge := on_hand_qty(v.id) - (select valued_qty from product_variants where id = v.id);
    if v_menge > 0.0001 then
      perform valuation_apply(v.id, null, 'revaluation', v_menge, v_preis, null,
        'Bewertung bisher unbewerteter Menge');
      v_anzahl := v_anzahl + 1;
    end if;
  end loop;

  if v_anzahl > 0 then
    perform log_event('product_template', p_template, 'note',
      'Bestand zum Einkaufspreis ' || v_preis::text || ' neu bewertet', p_actor);
  end if;
  return v_anzahl;
end $$;

comment on function einstandspreis_neubewerten is
  'Bewertet den Bestand aller Varianten einer Vorlage zum aktuellen Einkaufspreis (Neubewertungsschicht).';

create or replace function trg_einstandspreis_neubewerten() returns trigger
language plpgsql
set search_path = public, pg_temp as $$
begin
  perform einstandspreis_neubewerten(new.id, 'einkaufspreis');
  return null;
end $$;

create trigger product_templates_einstandspreis
  after update of standard_cost on product_templates
  for each row
  when (new.standard_cost is distinct from old.standard_cost)
  execute function trg_einstandspreis_neubewerten();

-- Einmalig nachholen: Bestand, der bei gepflegtem Preis noch bei 0 € steht.
select einstandspreis_neubewerten(pt.id, 'migration 0088')
from product_templates pt
where pt.type = 'goods' and pt.standard_cost > 0
  and exists (
    select 1 from product_variants pv
    where pv.template_id = pt.id
      and (pv.valued_qty > 0 and pv.valuation_total = 0
           or on_hand_qty(pv.id) > pv.valued_qty));

-- --- 3. Kennzahlen als normale Sichten ---------------------------------------
-- DESTRUKTIV: nur berechnete Sichten fallen (materialized view → view gleichen Namens, direkt darunter neu angelegt); keine Daten gehen verloren.
drop materialized view mv_rma_analysis;
drop materialized view mv_inventory_turnover;
drop materialized view mv_contribution_margin;
drop materialized view mv_stock_value_history;
drop materialized view mv_supplier_otd;
drop materialized view mv_labor_hours;

-- Bestandswert am Monatsende aus den Wertschichten (Neubewertungen zählen).
create view mv_stock_value_history as
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

comment on view mv_stock_value_history is
  'Bestandsmenge und -wert je Variante zum Monatsende, live aus den Wertschichten.';

-- Deckungsbeitrag zu heutigen Einstandspreisen: Auslieferungen (Retouren
-- gegengerechnet) plus Aufträge ohne Lieferschein am Auftragsdatum.
create view mv_contribution_margin as
with geliefert as (
  select date_trunc('month', m.date_done)::date as monat,
         m.variant_id,
         bewegung.vorzeichen * m.qty_done as qty,
         round(bewegung.vorzeichen * m.qty_done
               * coalesce(zeile.price_unit, 0)
               * (1 - coalesce(zeile.discount, 0) / 100.0), 4) as revenue
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
  where m.state = 'done' and m.date_done is not null
),
ohne_lieferschein as (
  select date_trunc('month', so.order_date)::date as monat,
         l.variant_id,
         l.qty,
         round(l.qty * l.price_unit * (1 - l.discount / 100.0), 4) as revenue
  from sales_orders so
  join sales_order_lines l on l.order_id = so.id
  where so.state = 'sale' and so.delivery_status = 'full' and l.variant_id is not null
    and not exists (
      select 1 from stock_pickings p
      where p.origin_model = 'sales_order' and p.origin_id = so.id)
),
summe as (
  select monat, variant_id, sum(qty) as qty, sum(revenue) as revenue
  from (select * from geliefert union all select * from ohne_lieferschein) alle
  group by 1, 2
),
preise as (
  select variant_id, einstandspreis_aktuell(variant_id) as preis
  from (select distinct variant_id from summe) v
)
select s.monat, s.variant_id, s.qty, s.revenue,
       round(s.qty * p.preis, 4) as cost
from summe s
join preise p on p.variant_id = s.variant_id;

comment on view mv_contribution_margin is
  'Umsatz, Wareneinsatz (zu heutigen Einstandspreisen) und Menge je Variante und Monat — '
  'Auslieferungen mit Retouren, dazu Aufträge ohne Lieferschein am Auftragsdatum. Live.';

create view mv_inventory_turnover as
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
  select m.variant_id, sum(m.qty_done) as qty_90d
  from stock_moves m
  join stock_locations src on src.id = m.src_location_id and src.type = 'internal'
  join stock_locations dst on dst.id = m.dest_location_id and dst.type <> 'internal'
  where m.state = 'done' and m.date_done >= current_date - 90
  group by 1
),
bestand as (
  select q.variant_id, sum(q.on_hand) as on_hand
  from stock_quants q
  join stock_locations l on l.id = q.location_id and l.type = 'internal'
  group by 1
)
select pv.id as variant_id,
       coalesce(pv.display_name, pt.name) as product,
       pv.sku,
       coalesce(b.on_hand, 0) as on_hand,
       case when coalesce(b.on_hand, 0) <> 0
            then round(b.on_hand * einstandspreis_aktuell(pv.id), 4) else 0 end as value_now,
       coalesce(mw.avg_value, 0) as avg_value_12m,
       coalesce(e.cogs, 0) as cogs_12m,
       coalesce(e.revenue, 0) as revenue_12m,
       coalesce(e.revenue, 0) - coalesce(e.cogs, 0) as margin_12m,
       case when coalesce(mw.avg_value, 0) > 0
            then round(coalesce(e.cogs, 0) / mw.avg_value, 2) end as turnover,
       coalesce(v.qty_90d, 0) / 90.0 as daily_use,
       case when coalesce(v.qty_90d, 0) > 0
            then round(coalesce(b.on_hand, 0) / (v.qty_90d / 90.0), 1) end as days_of_supply
from product_variants pv
join product_templates pt on pt.id = pv.template_id
left join einsatz e on e.variant_id = pv.id
left join mittelwert mw on mw.variant_id = pv.id
left join verbrauch v on v.variant_id = pv.id
left join bestand b on b.variant_id = pv.id
where pv.active and pt.type = 'goods';

comment on view mv_inventory_turnover is
  'Umschlagshäufigkeit (12 Monate), Bestandswert zu heutigem Einstandspreis und Reichweite je Variante. Live.';

create view mv_supplier_otd as
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

comment on view mv_supplier_otd is
  'Liefertreue je Lieferant und Monat: Termin- und Mengentreue aus Bestellzeilen gegen die Wareneingänge. Live.';

create view mv_rma_analysis as
with rma as (
  select date_trunc('month', r.created_at)::date as monat,
         r.variant_id,
         count(*)::int as rma_count,
         count(*) filter (where r.state in ('repaired', 'shipped'))::int as repaired,
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

comment on view mv_rma_analysis is
  'Reparaturaufträge je Monat und Variante gegen die verkaufte Menge (repariert = repaired + shipped). Live.';

create view mv_labor_hours as
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

comment on view mv_labor_hours is
  'Erfasste Minuten und Lohnkosten je Monat, Mitarbeiter, Art und Arbeitsplatz. Live.';

-- --- 4. refresh_analytics bleibt als leere Hülle -----------------------------
-- Altaufrufer (Betriebsdaten löschen, Werkszustand, Demo-Historie, Odoo-
-- Import) rufen sie weiter; es gibt nichts mehr nachzurechnen.
create or replace function refresh_analytics(p_actor text default 'system')
returns interval
language plpgsql
set search_path = public, pg_temp as $$
begin
  return interval '0';
end $$;

comment on function refresh_analytics is
  'Seit 0088 ohne Wirkung — die Kennzahlen sind normale Sichten und immer aktuell.';
