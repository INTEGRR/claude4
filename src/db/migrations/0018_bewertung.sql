-- ===========================================================================
-- Bestandsbewertung: gleitender Durchschnittspreis (AVCO), Wertschichten,
-- Einstandsnebenkosten (Landed Costs) und Fremdwährungs-Einkauf
-- ===========================================================================
-- Aufbau nach dem bewährten Muster: Menge und Wert getrennt führen. Die
-- Mengenwahrheit bleibt das Bewegungs-Ledger (stock_moves + stock_quants),
-- der Wert bekommt eine eigene, ausschließlich anhängende Schichtentabelle
-- (stock_valuation_layers). Eine Wertschicht wird nie geändert — Korrekturen
-- entstehen als zusätzliche Schicht (Nebenkosten, Neubewertung).

-- --- Währungen -------------------------------------------------------------
create table currencies (
  code       text primary key check (char_length(code) = 3),   -- ISO 4217
  name       text not null,
  minor_unit int not null default 2,
  active     boolean not null default true
);
insert into currencies (code, name) values
  ('EUR', 'Euro'), ('USD', 'US-Dollar'), ('CNY', 'Renminbi Yuan'),
  ('GBP', 'Britisches Pfund'), ('CHF', 'Schweizer Franken');

-- Kurse gegen die Hauswährung (EUR): 1 Einheit Fremdwährung = rate EUR.
create table exchange_rates (
  id         uuid primary key default gen_random_uuid(),
  currency   text not null references currencies on delete restrict,
  rate       numeric(18,8) not null check (rate > 0),
  valid_from date not null,
  source     text,
  created_at timestamptz not null default now(),
  unique (currency, valid_from)
);
create index exchange_rates_lookup_idx on exchange_rates (currency, valid_from desc);

/**
 * Kurs zu einem Stichtag: der zuletzt vor dem Tag erfasste Kurs gilt weiter.
 * Die Hauswährung hat immer den Kurs 1.
 */
create or replace function exchange_rate_at(p_currency text, p_date date default current_date)
returns numeric
language sql stable as $$
  select case
    when p_currency is null or p_currency = 'EUR' then 1::numeric
    else coalesce(
      (select rate from exchange_rates
       where currency = p_currency and valid_from <= p_date
       order by valid_from desc limit 1),
      1)
  end;
$$;

-- --- Wertschichten ---------------------------------------------------------
create type valuation_layer_type as enum
  ('receipt', 'issue', 'landed_cost', 'revaluation', 'production');

create table stock_valuation_layers (
  id          uuid primary key default gen_random_uuid(),
  variant_id  uuid not null references product_variants on delete restrict,
  move_id     uuid references stock_moves on delete set null,
  layer_type  valuation_layer_type not null,
  quantity    numeric(16,4) not null,          -- + Zugang, − Abgang, 0 bei reiner Wertbuchung
  unit_cost   numeric(18,6) not null default 0,
  value       numeric(18,4) not null,          -- Wertänderung in Hauswährung
  -- Bestand und Wert NACH dieser Schicht (macht die Historie prüfbar)
  qty_after   numeric(16,4) not null default 0,
  value_after numeric(18,4) not null default 0,
  note        text,
  created_at  timestamptz not null default now()
);
create index stock_valuation_layers_variant_idx
  on stock_valuation_layers (variant_id, created_at);
create index stock_valuation_layers_move_idx on stock_valuation_layers (move_id);

-- Wertschichten sind unveränderlich: Korrekturen laufen als neue Schicht.
create or replace function trg_valuation_layer_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'Wertschichten sind unveränderlich — bitte eine Korrekturschicht buchen';
end $$;
create trigger valuation_layer_immutable
  before update or delete on stock_valuation_layers
  for each row execute function trg_valuation_layer_immutable();

-- Gleitender Durchschnittspreis je Variante (Ergebnis der Schichten).
alter table product_variants
  add column moving_avg_cost numeric(18,6) not null default 0,
  add column valued_qty numeric(16,4) not null default 0,      -- bewertete Menge
  add column valuation_total numeric(18,4) not null default 0; -- Bestandswert

-- Zugangspreis je Bewegung (Odoo: stock.move.price_unit) — in Hauswährung.
-- Wird beim Anlegen aus der Bestellzeile gesetzt; NULL heißt "aus dem
-- gleitenden Durchschnitt bzw. den Einstandskosten ableiten".
alter table stock_moves add column unit_cost numeric(18,6);

-- Kurs-Schnappschuss auf der Bestellung (Kurs zum Zeitpunkt der Bestätigung).
alter table purchase_orders
  add column exchange_rate numeric(18,8) not null default 1;

-- ===========================================================================
-- Bewertungslogik
-- ===========================================================================

/**
 * Schreibt eine Wertschicht und schreibt den gleitenden Durchschnitt fort.
 *
 * Zugang    (p_qty > 0): neuer Durchschnitt = (Wert + Zugangswert) / (Menge + Zugangsmenge)
 * Abgang    (p_qty < 0): bewertet zum aktuellen Durchschnitt, Durchschnitt bleibt
 * Wertbuchung (p_qty = 0): nur der Wert ändert sich (Nebenkosten, Neubewertung)
 *
 * Der Durchschnitt wird nie negativ und bleibt bei leerem Bestand stehen —
 * so springt er nicht, wenn nach einem Nullbestand wieder zugebucht wird.
 */
create or replace function valuation_apply(
  p_variant uuid,
  p_move uuid,
  p_type valuation_layer_type,
  p_qty numeric,
  p_unit_cost numeric default null,
  p_value numeric default null,
  p_note text default null
) returns uuid
language plpgsql as $$
declare
  v_qty_before numeric;
  v_value_before numeric;
  v_mac numeric;
  v_unit numeric;
  v_value numeric;
  v_qty_after numeric;
  v_value_after numeric;
  v_layer uuid;
begin
  select valued_qty, valuation_total, moving_avg_cost
    into v_qty_before, v_value_before, v_mac
  from product_variants where id = p_variant for update;

  if p_qty > 0 then
    -- Zugang: Preis aus Parameter, sonst bisheriger Durchschnitt, sonst Einstand.
    v_unit := coalesce(p_unit_cost, nullif(v_mac, 0),
      (select standard_cost from product_templates pt
       join product_variants pv on pv.template_id = pt.id where pv.id = p_variant), 0);
    v_value := coalesce(p_value, round(p_qty * v_unit, 4));
  elsif p_qty < 0 then
    -- Abgang: immer zum aktuellen Durchschnitt (AVCO).
    v_unit := coalesce(p_unit_cost, v_mac);
    v_value := coalesce(p_value, round(p_qty * v_unit, 4));
  else
    -- Reine Wertbuchung (Nebenkosten/Neubewertung).
    v_value := coalesce(p_value, 0);
    v_unit := 0;
  end if;

  v_qty_after := v_qty_before + p_qty;
  v_value_after := v_value_before + v_value;

  -- Bei leerem Bestand keinen Restwert stehen lassen (Rundungsreste).
  if abs(v_qty_after) < 0.0001 then
    v_qty_after := 0;
    v_value_after := 0;
  end if;

  insert into stock_valuation_layers (
    variant_id, move_id, layer_type, quantity, unit_cost, value,
    qty_after, value_after, note)
  values (
    p_variant, p_move, p_type, p_qty, abs(v_unit), v_value,
    v_qty_after, v_value_after, p_note)
  returning id into v_layer;

  update product_variants set
    valued_qty = v_qty_after,
    valuation_total = v_value_after,
    -- Durchschnitt nur bei vorhandenem Bestand neu rechnen, sonst halten.
    moving_avg_cost = case
      when v_qty_after > 0 then round(v_value_after / v_qty_after, 6)
      else moving_avg_cost
    end
  where id = p_variant;

  return v_layer;
end $$;

/** Einstandspreis einer Zugangsbewegung: Bestellpreis × Kurs, sonst Vorgabe. */
create or replace function move_receipt_cost(p_move uuid) returns numeric
language plpgsql stable as $$
declare
  m stock_moves%rowtype;
  v_cost numeric;
begin
  select * into m from stock_moves where id = p_move;
  if m.unit_cost is not null then return m.unit_cost; end if;

  -- Wareneingang: Preis der Bestellzeile in Hauswährung, je Lagereinheit.
  select round(
           pol.price_unit * (1 - pol.discount / 100.0) * po.exchange_rate
           / nullif(uom_convert(1, pol.uom_id, pt.uom_id), 0), 6)
    into v_cost
  from stock_pickings p
  join purchase_orders po on po.id = p.origin_id and p.origin_model = 'purchase_order'
  join purchase_order_lines pol on pol.order_id = po.id and pol.variant_id = m.variant_id
  join product_variants pv on pv.id = m.variant_id
  join product_templates pt on pt.id = pv.template_id
  where p.id = m.picking_id
  order by pol.sequence
  limit 1;

  return v_cost;   -- NULL => valuation_apply nimmt Durchschnitt/Einstand
end $$;

/**
 * Bewertet eine erledigte Bewegung. Aufgerufen aus move_done.
 *   extern → intern : Zugang  (Wareneingang, Retoure, Inventurplus)
 *   intern → extern : Abgang  (Lieferung, Verbrauch, Ausschuss, Inventurminus)
 *   intern → intern : keine Wertänderung (reine Umlagerung)
 */
create or replace function move_value(p_move uuid, p_qty numeric) returns void
language plpgsql as $$
declare
  m stock_moves%rowtype;
  v_src location_type;
  v_dst location_type;
  v_type valuation_layer_type;
begin
  select * into m from stock_moves where id = p_move;
  select type into v_src from stock_locations where id = m.src_location_id;
  select type into v_dst from stock_locations where id = m.dest_location_id;

  if v_src = 'internal' and v_dst = 'internal' then
    return;                                   -- Umlagerung: Wert unverändert
  end if;

  if v_dst = 'internal' then
    v_type := case when v_src = 'production' then 'production' else 'receipt' end;
    perform valuation_apply(m.variant_id, p_move, v_type, p_qty,
                            move_receipt_cost(p_move), null, m.reference);
  elsif v_src = 'internal' then
    v_type := case when v_dst = 'production' then 'production' else 'issue' end;
    perform valuation_apply(m.variant_id, p_move, v_type, -p_qty, null, null, m.reference);
  end if;
end $$;

-- move_done um die Wertbuchung erweitern (Mengenlogik unverändert).
create or replace function move_done(p_move uuid, p_qty_done numeric default null)
returns void
language plpgsql as $$
declare
  m stock_moves%rowtype;
  v_qty numeric;
  v_tracking text;
  a record;
begin
  select * into m from stock_moves where id = p_move for update;
  if m.id is null then raise exception 'Bewegung % nicht gefunden', p_move; end if;
  if m.state = 'done' then return; end if;
  if m.state = 'cancel' then
    raise exception 'Stornierte Bewegungen können nicht gebucht werden';
  end if;

  v_qty := coalesce(p_qty_done, nullif(m.qty_done, 0), m.qty);
  if v_qty <= 0 then
    -- Nichts geliefert/verbraucht: Bewegung stornieren statt buchen.
    perform move_unreserve(p_move);
    update stock_moves set state = 'cancel', qty_done = 0 where id = p_move;
    return;
  end if;

  v_tracking := product_tracking(m.variant_id);
  if v_tracking <> 'none' then
    perform move_ensure_lot_assignments(p_move, v_qty, v_tracking);
  end if;

  -- Reservierung auflösen, soweit vorhanden.
  if m.reserved_qty > 0 then
    perform quant_apply(m.src_location_id, m.variant_id, 0, -m.reserved_qty);
  end if;

  perform quant_apply(m.src_location_id, m.variant_id, -v_qty, 0);
  perform quant_apply(m.dest_location_id, m.variant_id, v_qty, 0);

  if v_tracking <> 'none' then
    for a in select lot_id, qty from move_lot_assignments where move_id = p_move loop
      perform lot_quant_apply(m.src_location_id, m.variant_id, a.lot_id, -a.qty);
      perform lot_quant_apply(m.dest_location_id, m.variant_id, a.lot_id, a.qty);
    end loop;
  end if;

  update stock_moves
    set state = 'done', qty_done = v_qty, reserved_qty = 0, date_done = now()
  where id = p_move;

  -- Wert nachziehen (nach dem Mengen-Update, damit der Kontext vollständig ist).
  perform move_value(p_move, v_qty);
end $$;

-- ===========================================================================
-- Einstandsnebenkosten (Landed Costs)
-- ===========================================================================
-- Fracht, Zoll, Versicherung und Handling gehören zum Einstand. Sie treffen
-- typischerweise Wochen nach der Ware ein, deshalb: geschätzte Kosten sofort
-- buchen, die echte Rechnung später als Korrektur nachschieben.

-- Kleiner Helfer für Meldungstexte (Beträge in Hauswährung).
create or replace function money_text(p_value numeric) returns text
language sql immutable as $$
  select to_char(coalesce(p_value, 0), 'FM999G999G990D00') || ' EUR';
$$;

create type landed_cost_type as enum
  ('freight', 'customs_duty', 'insurance', 'handling', 'other');
create type landed_cost_basis as enum ('value', 'weight', 'quantity');

create table landed_costs (
  id          uuid primary key default gen_random_uuid(),
  number      text unique not null,
  picking_id  uuid not null references stock_pickings on delete restrict,  -- Wareneingang
  cost_type   landed_cost_type not null default 'freight',
  basis       landed_cost_basis not null default 'weight',
  amount      numeric(18,4) not null check (amount >= 0),
  currency    text not null default 'EUR' references currencies on delete restrict,
  exchange_rate numeric(18,8) not null default 1,
  is_estimate boolean not null default false,          -- geschätzt, Rechnung folgt
  corrects_id uuid references landed_costs on delete set null,  -- Korrektur einer Schätzung
  state       text not null default 'draft' check (state in ('draft', 'posted', 'cancel')),
  vendor_id   uuid references partners on delete set null,
  note        text,
  posted_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);
select attach_touch_trigger('landed_costs');
create index landed_costs_picking_idx on landed_costs (picking_id);

insert into sequences (code, prefix, padding) values ('landed', 'LC/', 5);

create table landed_cost_allocations (
  id             uuid primary key default gen_random_uuid(),
  landed_cost_id uuid not null references landed_costs on delete cascade,
  move_id        uuid not null references stock_moves on delete restrict,
  variant_id     uuid not null references product_variants on delete restrict,
  basis_value    numeric(18,4) not null,               -- Wert/Gewicht/Menge der Zeile
  amount         numeric(18,4) not null,               -- zugeteilter Betrag
  layer_id       uuid references stock_valuation_layers on delete set null,
  unique (landed_cost_id, move_id)
);

/**
 * Verteilt die Nebenkosten auf die Zeilen des Wareneingangs und bucht je
 * Zeile eine reine Wertschicht. Die Verteilbasis folgt der Kostenart:
 * Fracht nach Gewicht (der Frachtführer rechnet nach Raum, nicht nach Wert),
 * Zoll und Versicherung nach Wert, Handling nach Menge.
 */
create or replace function landed_cost_post(p_cost uuid, p_actor text default 'system')
returns void
language plpgsql as $$
declare
  lc landed_costs%rowtype;
  v_total_basis numeric;
  v_amount_eur numeric;
  z record;
  v_share numeric;
  v_layer uuid;
begin
  select * into lc from landed_costs where id = p_cost for update;
  if lc.id is null then raise exception 'Nebenkostenbeleg nicht gefunden'; end if;
  if lc.state <> 'draft' then raise exception 'Nur Entwürfe können gebucht werden'; end if;

  if not exists (select 1 from stock_pickings where id = lc.picking_id and state = 'done') then
    raise exception 'Der Wareneingang muss zuerst gebucht sein';
  end if;

  v_amount_eur := round(lc.amount * lc.exchange_rate, 4);

  -- Verteilbasis je Eingangszeile. Fehlt die Basis ganz (z. B. kein Gewicht
  -- gepflegt), wird gleichmäßig verteilt statt die Buchung zu verweigern.
  select coalesce(sum(
           case lc.basis
             when 'value'    then greatest(m.qty_done * coalesce(move_receipt_cost(m.id), 0), 0)
             when 'weight'   then greatest(m.qty_done * coalesce(pt.weight_g, 0), 0)
             when 'quantity' then m.qty_done
           end), 0)
    into v_total_basis
  from stock_moves m
  join product_variants pv on pv.id = m.variant_id
  join product_templates pt on pt.id = pv.template_id
  where m.picking_id = lc.picking_id and m.state = 'done';

  if not exists (select 1 from stock_moves
                 where picking_id = lc.picking_id and state = 'done') then
    raise exception 'Der Wareneingang hat keine gebuchten Positionen';
  end if;

  for z in
    select m.id as move_id, m.variant_id,
           case
             when v_total_basis <= 0 then 1     -- gleichmäßig
             when lc.basis = 'value' then greatest(m.qty_done * coalesce(move_receipt_cost(m.id), 0), 0)
             when lc.basis = 'weight' then greatest(m.qty_done * coalesce(pt.weight_g, 0), 0)
             else m.qty_done
           end as basis_value
    from stock_moves m
    join product_variants pv on pv.id = m.variant_id
    join product_templates pt on pt.id = pv.template_id
    where m.picking_id = lc.picking_id and m.state = 'done'
  loop
    if v_total_basis <= 0 then
      -- Gleichverteilung: Basis 1 je Zeile
      select count(*) into v_total_basis from stock_moves
      where picking_id = lc.picking_id and state = 'done';
    end if;
    v_share := round(v_amount_eur * z.basis_value / v_total_basis, 4);
    if v_share = 0 then continue; end if;

    v_layer := valuation_apply(
      z.variant_id, z.move_id, 'landed_cost', 0, null, v_share,
      lc.number || ' · ' || lc.cost_type);

    insert into landed_cost_allocations
      (landed_cost_id, move_id, variant_id, basis_value, amount, layer_id)
    values (p_cost, z.move_id, z.variant_id, z.basis_value, v_share, v_layer);
  end loop;

  update landed_costs set state = 'posted', posted_at = now() where id = p_cost;
  perform log_event('stock_picking', lc.picking_id, 'note',
    format('Nebenkosten gebucht: %s (%s)', lc.number, money_text(v_amount_eur)), p_actor);
  perform log_event('landed_cost', p_cost, 'state', 'Gebucht', p_actor);
end $$;

/** Storniert einen gebuchten Nebenkostenbeleg durch Gegenschichten. */
create or replace function landed_cost_cancel(p_cost uuid, p_actor text default 'system')
returns void
language plpgsql as $$
declare
  lc landed_costs%rowtype;
  a record;
begin
  select * into lc from landed_costs where id = p_cost for update;
  if lc.id is null then raise exception 'Nebenkostenbeleg nicht gefunden'; end if;

  if lc.state = 'posted' then
    for a in select * from landed_cost_allocations where landed_cost_id = p_cost loop
      perform valuation_apply(a.variant_id, a.move_id, 'revaluation', 0, null, -a.amount,
                              'Storno ' || lc.number);
    end loop;
  end if;

  update landed_costs set state = 'cancel' where id = p_cost;
  perform log_event('landed_cost', p_cost, 'state', 'Storniert', p_actor);
end $$;

-- ===========================================================================
-- Bestandswert-Sicht
-- ===========================================================================
create or replace view stock_value as
select pv.id as variant_id,
       pv.template_id,
       coalesce(pv.display_name, pt.name) as product,
       pv.sku,
       on_hand_qty(pv.id) as on_hand,
       pv.valued_qty,
       pv.moving_avg_cost,
       pv.valuation_total,
       -- Abweichung zwischen physischem und bewertetem Bestand sichtbar machen
       on_hand_qty(pv.id) - pv.valued_qty as qty_difference
from product_variants pv
join product_templates pt on pt.id = pv.template_id
where pv.active and pt.type = 'goods';

-- ===========================================================================
-- Einkauf: Kurs-Schnappschuss und Zugangspreis an der Bewegung
-- ===========================================================================
-- confirm_purchase_order friert den Tageskurs ein und schreibt den
-- Einstandspreis je Lagereinheit direkt an die Eingangsbewegung.
create or replace function purchase_snapshot_rate(p_order uuid) returns void
language plpgsql as $$
declare
  o purchase_orders%rowtype;
begin
  select * into o from purchase_orders where id = p_order;
  update purchase_orders
    set exchange_rate = exchange_rate_at(o.currency, current_date)
  where id = p_order and exchange_rate = 1;
end $$;
