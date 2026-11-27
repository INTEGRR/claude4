-- 0144: Nummerierte Auflage (Entscheidungslog 2026-11-27).
--
-- Eine limitierte Auflage (z. B. „Founders Edition", Nr. 1 bis 96) hängt an
-- einem oder mehreren Produkten — egal in welcher Variante gekauft wird, jedes
-- verkaufte Stück bekommt die nächste Nummer, in der Reihenfolge der
-- Bestellungen. Die Nummer hängt an der Auftragsposition: sie wandert mit in
-- Fertigung und Versand und wird wieder frei, wenn der Auftrag storniert wird.

create table auflagen (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  von int not null default 1 check (von >= 1),
  bis int not null,
  created_at timestamptz not null default now(),
  check (bis >= von)
);

alter table product_templates
  add column auflage_id uuid references auflagen(id) on delete set null;
create index product_templates_auflage_idx on product_templates (auflage_id) where auflage_id is not null;

create table auflage_nummern (
  auflage_id uuid not null references auflagen(id) on delete cascade,
  nummer int not null,
  sales_order_line_id uuid not null references sales_order_lines(id) on delete cascade,
  vergeben_am timestamptz not null default now(),
  primary key (auflage_id, nummer)
);
create index auflage_nummern_zeile_idx on auflage_nummern (sales_order_line_id);

-- Vergibt die Nummern. Reihenfolge ist die Bestellzeit (order_date), bei
-- Gleichstand Bestellnummer und Position. p_ruhe: so alt muss eine Bestellung
-- sein, bevor sie eine Nummer bekommt — Bestellungen derselben Sekunden
-- treffen nicht immer in ihrer Reihenfolge ein; die kurze Ruhezeit lässt sie
-- sich sortieren, bevor eine Nummer fest wird. Eine einmal vergebene Nummer
-- ändert sich nie; sie wird nur frei (Storno, Position entfernt, Menge
-- gesenkt) und geht dann an das nächste Stück ohne Nummer.
create or replace function auflage_nummern_vergeben(p_ruhe interval default interval '60 seconds')
returns table (vergeben int, frei_geworden int)
language plpgsql
set search_path = public, pg_temp as $$
declare
  r record;
  v_frei int := 0;
  v_neu int := 0;
  v_nummer int;
  v_fehlt int;
begin
  if not exists (select 1 from product_templates where auflage_id is not null)
     and not exists (select 1 from auflage_nummern) then
    return query select 0, 0;
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('auflage_nummern', 0));

  -- 1. Frei werden: Auftrag nicht (mehr) bestätigt, Produkt gehört nicht
  --    mehr zur Auflage, oder mehr Nummern als Stück (höchste zuerst).
  for r in
    select n.auflage_id, n.nummer, sol.order_id, a.name
    from auflage_nummern n
    join auflagen a on a.id = n.auflage_id
    join sales_order_lines sol on sol.id = n.sales_order_line_id
    join sales_orders so on so.id = sol.order_id
    left join product_variants pv on pv.id = sol.variant_id
    left join product_templates pt on pt.id = pv.template_id
    where so.state <> 'sale'
       or pt.auflage_id is distinct from n.auflage_id
       or (select count(*) from auflage_nummern x
            where x.sales_order_line_id = n.sales_order_line_id
              and x.auflage_id = n.auflage_id and x.nummer <= n.nummer) > ceil(sol.qty)
  loop
    delete from auflage_nummern where auflage_id = r.auflage_id and nummer = r.nummer;
    perform log_event('sales_order', r.order_id, 'note',
      format('%s: Nr. %s wieder frei.', r.name, r.nummer), 'system');
    v_frei := v_frei + 1;
  end loop;

  -- 2. Vergeben: Stück für Stück in Bestellreihenfolge die kleinste freie Nummer.
  for r in
    select sol.id as zeile, sol.order_id, a.id as auflage_id, a.name, a.von, a.bis,
           ceil(sol.qty)::int
             - (select count(*)::int from auflage_nummern n
                 where n.sales_order_line_id = sol.id and n.auflage_id = a.id) as fehlt
    from sales_order_lines sol
    join sales_orders so on so.id = sol.order_id
    join product_variants pv on pv.id = sol.variant_id
    join product_templates pt on pt.id = pv.template_id
    join auflagen a on a.id = pt.auflage_id
    where so.state = 'sale'
      and so.order_date <= now() - p_ruhe
    order by so.order_date, so.shopify_order_name nulls last, so.number, sol.sequence, sol.id
  loop
    v_fehlt := r.fehlt;
    while v_fehlt > 0 loop
      select g into v_nummer
      from generate_series(r.von, r.bis) g
      where not exists (select 1 from auflage_nummern n where n.auflage_id = r.auflage_id and n.nummer = g)
      order by g limit 1;
      exit when v_nummer is null; -- Auflage ist voll: das Stück bleibt ohne Nummer.
      insert into auflage_nummern (auflage_id, nummer, sales_order_line_id)
      values (r.auflage_id, v_nummer, r.zeile);
      perform log_event('sales_order', r.order_id, 'note',
        format('%s: Nr. %s vergeben.', r.name, v_nummer), 'system');
      v_neu := v_neu + 1;
      v_fehlt := v_fehlt - 1;
    end loop;
  end loop;

  return query select v_neu, v_frei;
end;
$$;

-- Stück einer Auflage, die (noch) keine Nummer haben: wartet noch auf die
-- Ruhezeit oder die Auflage ist voll.
create or replace function auflage_ohne_nummer(p_auflage uuid) returns int
language sql stable
set search_path = public, pg_temp as $$
  select coalesce(sum(greatest(ceil(sol.qty)::int
           - (select count(*)::int from auflage_nummern n
               where n.sales_order_line_id = sol.id and n.auflage_id = p_auflage), 0)), 0)::int
  from sales_order_lines sol
  join sales_orders so on so.id = sol.order_id and so.state = 'sale'
  join product_variants pv on pv.id = sol.variant_id
  join product_templates pt on pt.id = pv.template_id
  where pt.auflage_id = p_auflage;
$$;

-- Anzeige: „Founders Edition Nr. 17, 18" für eine Auftragsposition
-- (null = keine Auflage oder noch keine Nummer).
create or replace function auflage_nummern_text(p_zeile uuid) returns text
language sql stable
set search_path = public, pg_temp as $$
  select a.name || ' Nr. ' || string_agg(n.nummer::text, ', ' order by n.nummer)
  from auflage_nummern n
  join auflagen a on a.id = n.auflage_id
  where n.sales_order_line_id = p_zeile
  group by a.name
  limit 1;
$$;

-- Dasselbe für einen Fertigungsauftrag: die Nummern der Positionen seines
-- Verkaufsauftrags mit derselben Variante — die Montage sieht, welches
-- nummerierte Stück sie baut.
create or replace function auflage_nummern_fertigung(p_mo uuid) returns text
language sql stable
set search_path = public, pg_temp as $$
  select a.name || ' Nr. ' || string_agg(n.nummer::text, ', ' order by n.nummer)
  from manufacturing_orders mo
  join sales_order_lines sol on sol.order_id = mo.sales_order_id and sol.variant_id = mo.variant_id
  join auflage_nummern n on n.sales_order_line_id = sol.id
  join auflagen a on a.id = n.auflage_id
  where mo.id = p_mo
  group by a.name
  limit 1;
$$;
