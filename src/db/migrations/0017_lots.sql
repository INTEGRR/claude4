-- ===========================================================================
-- Odoo-Vervollständigung V: Los- und Seriennummern (stock.lot)
-- ===========================================================================
-- Architektur: stock_quants bleibt die aggregierte Wahrheit je Ort+Variante
-- (Ledger-Invariante unverändert). Lose sind eine zusätzliche Verteilungs-
-- ebene: move_lot_assignments sagt, welche Lose eine Bewegung trägt;
-- stock_lot_quants führt den Bestand je Los fort. Eigene Invariante:
-- Los-Bestand == Summe der Zuordnungen erledigter Bewegungen.
--
-- Zuteilungsregeln (move_done):
--  - Zuordnung vorhanden → muss exakt der gebuchten Menge entsprechen;
--    Seriennummern immer Menge 1.
--  - Keine Zuordnung, Quelle intern (Auslieferung/Verbrauch/Transfer)
--    → automatisch FIFO nach Los-Alter; Altbestand ohne Loszuordnung
--    läuft über das Sonderlos 'ALTBESTAND'.
--  - Keine Zuordnung, Quelle extern (Wareneingang/Fertigmeldung)
--    → Lose werden automatisch angelegt (LOT-Sequenz; je Stück bei Serie).

alter table product_templates
  add column tracking text not null default 'none'
    check (tracking in ('none', 'lot', 'serial'));   -- product.template.tracking

insert into sequences (code, prefix, padding) values ('lot', 'LOT', 6);

create table stock_lots (
  id         uuid primary key default gen_random_uuid(),
  variant_id uuid not null references product_variants on delete cascade,
  name       text not null,
  ref        text,                                   -- stock.lot.ref
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  unique (variant_id, name)
);
select attach_touch_trigger('stock_lots');

create table move_lot_assignments (
  id      uuid primary key default gen_random_uuid(),
  move_id uuid not null references stock_moves on delete cascade,
  lot_id  uuid not null references stock_lots on delete restrict,
  qty     numeric(16,4) not null check (qty > 0),
  unique (move_id, lot_id)
);
create index move_lot_assignments_lot_idx on move_lot_assignments (lot_id);

create table stock_lot_quants (
  location_id uuid not null references stock_locations on delete restrict,
  variant_id  uuid not null references product_variants on delete restrict,
  lot_id      uuid not null references stock_lots on delete cascade,
  on_hand     numeric(16,4) not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (location_id, variant_id, lot_id)
);

alter table operation_types
  add column use_create_lots boolean not null default true,
  add column use_existing_lots boolean not null default true;
alter table manufacturing_orders
  add column lot_producing_id uuid references stock_lots on delete set null;
alter table repair_orders
  add column lot_id uuid references stock_lots on delete set null;  -- RMA: welche Seriennummer

-- --- Helfer ----------------------------------------------------------------
create or replace function product_tracking(p_variant uuid) returns text
language sql stable as $$
  select pt.tracking from product_variants pv
  join product_templates pt on pt.id = pv.template_id
  where pv.id = p_variant;
$$;

create or replace function lot_quant_apply(
  p_location uuid, p_variant uuid, p_lot uuid, p_delta numeric
) returns void
language plpgsql as $$
begin
  insert into stock_lot_quants (location_id, variant_id, lot_id, on_hand)
  values (p_location, p_variant, p_lot, p_delta)
  on conflict (location_id, variant_id, lot_id) do update
    set on_hand = stock_lot_quants.on_hand + excluded.on_hand,
        updated_at = now();
end $$;

-- Findet oder erzeugt ein Los; ohne Namen zieht die LOT-Sequenz.
create or replace function ensure_lot(p_variant uuid, p_name text default null)
returns uuid
language plpgsql as $$
declare
  v_id uuid;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
begin
  if v_name is null then v_name := next_sequence('lot'); end if;
  select id into v_id from stock_lots where variant_id = p_variant and name = v_name;
  if v_id is null then
    insert into stock_lots (variant_id, name) values (p_variant, v_name) returning id into v_id;
  end if;
  return v_id;
end $$;

-- Setzt die Loszuordnung einer Bewegung (aus UI/Scanner): [{name, qty}].
create or replace function set_move_lots(p_move uuid, p_lots jsonb)
returns void
language plpgsql as $$
declare
  m stock_moves%rowtype;
  v_tracking text;
  e record;
begin
  select * into m from stock_moves where id = p_move;
  if m.id is null then raise exception 'Bewegung nicht gefunden'; end if;
  if m.state in ('done', 'cancel') then
    raise exception 'Loszuordnung ist nur vor der Buchung möglich';
  end if;
  v_tracking := product_tracking(m.variant_id);
  if v_tracking = 'none' then
    raise exception 'Für % ist keine Los-/Serienverfolgung aktiv',
      variant_display_name(m.variant_id);
  end if;

  delete from move_lot_assignments where move_id = p_move;
  for e in select * from jsonb_to_recordset(p_lots) as x(name text, qty numeric) loop
    if v_tracking = 'serial' and coalesce(e.qty, 1) <> 1 then
      raise exception 'Seriennummern haben immer Menge 1 (%: %)', e.name, e.qty;
    end if;
    insert into move_lot_assignments (move_id, lot_id, qty)
    values (p_move, ensure_lot(m.variant_id, e.name), coalesce(e.qty, 1))
    on conflict (move_id, lot_id) do update set qty = move_lot_assignments.qty + excluded.qty;
  end loop;
end $$;

-- Prüft bzw. erzeugt die Loszuordnung beim Buchen (siehe Kopfkommentar).
create or replace function move_ensure_lot_assignments(
  p_move uuid, p_qty numeric, p_tracking text
) returns void
language plpgsql as $$
declare
  m stock_moves%rowtype;
  v_sum numeric;
  v_src_type location_type;
  v_need numeric;
  v_take numeric;
  lq record;
  i int;
begin
  select * into m from stock_moves where id = p_move;
  select coalesce(sum(qty), 0) into v_sum from move_lot_assignments where move_id = p_move;

  if v_sum > 0 then
    if v_sum <> p_qty then
      raise exception 'Loszuordnung (%) entspricht nicht der gebuchten Menge (%) bei %',
        v_sum, p_qty, variant_display_name(m.variant_id);
    end if;
    if p_tracking = 'serial' and exists (
      select 1 from move_lot_assignments a
      join stock_lots sl on sl.id = a.lot_id
      where a.move_id = p_move and a.qty <> 1 and sl.name <> 'ALTBESTAND') then
      raise exception 'Seriennummern haben immer Menge 1 (%)',
        variant_display_name(m.variant_id);
    end if;
    return;
  end if;

  if p_tracking = 'serial' and p_qty <> floor(p_qty) then
    raise exception 'Serienverfolgte Produkte brauchen ganzzahlige Mengen (%)', p_qty;
  end if;

  select type into v_src_type from stock_locations where id = m.src_location_id;

  if v_src_type = 'internal' then
    -- Abgang: FIFO über die Los-Bestände am Quellort.
    v_need := p_qty;
    for lq in
      select q.lot_id, q.on_hand
      from stock_lot_quants q
      join stock_lots sl on sl.id = q.lot_id
      where q.location_id = m.src_location_id
        and q.variant_id = m.variant_id and q.on_hand > 0
      order by sl.created_at, sl.name
    loop
      exit when v_need <= 0;
      v_take := least(v_need, lq.on_hand);
      insert into move_lot_assignments (move_id, lot_id, qty)
      values (p_move, lq.lot_id, v_take);
      v_need := v_need - v_take;
    end loop;
    -- Altbestand, der nie einem Los zugeordnet wurde.
    if v_need > 0 then
      insert into move_lot_assignments (move_id, lot_id, qty)
      values (p_move, ensure_lot(m.variant_id, 'ALTBESTAND'), v_need)
      on conflict (move_id, lot_id) do update
        set qty = move_lot_assignments.qty + excluded.qty;
    end if;
  else
    -- Zugang von außen: Lose automatisch anlegen.
    if p_tracking = 'serial' then
      for i in 1..p_qty::int loop
        insert into move_lot_assignments (move_id, lot_id, qty)
        values (p_move, ensure_lot(m.variant_id, null), 1);
      end loop;
    else
      insert into move_lot_assignments (move_id, lot_id, qty)
      values (p_move, ensure_lot(m.variant_id, null), p_qty);
    end if;
  end if;
end $$;

-- --- move_done: Los-Dimension mitbuchen ------------------------------------
create or replace function move_done(p_move uuid, p_qty_done numeric default null)
returns void
language plpgsql as $$
declare
  m stock_moves%rowtype;
  v_qty numeric;
  v_release numeric;
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
  v_release := least(m.reserved_qty, v_qty);
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
end $$;

-- --- mo_produce: Losnummer für das Fertigprodukt ---------------------------
drop function if exists mo_produce(uuid, numeric, jsonb, boolean, text);

create or replace function mo_produce(
  p_mo uuid,
  p_qty numeric default null,
  p_consumed jsonb default '{}'::jsonb,
  p_create_backorder boolean default true,
  p_actor text default 'system',
  p_lot text default null
) returns uuid
language plpgsql as $$
declare
  mo manufacturing_orders%rowtype;
  v_bom boms%rowtype;
  v_qty numeric;
  v_factor numeric;
  v_expected numeric;
  v_actual numeric;
  m stock_moves%rowtype;
  v_stock uuid;
  v_production uuid;
  v_finished uuid;
  v_backorder uuid;
  v_remaining numeric;
  v_tracking text;
  v_lot uuid;
begin
  select * into mo from manufacturing_orders where id = p_mo for update;
  if mo.id is null then raise exception 'Fertigungsauftrag nicht gefunden'; end if;
  if mo.state in ('done', 'cancel') then
    raise exception 'Fertigungsauftrag % ist bereits abgeschlossen oder storniert', mo.number;
  end if;

  v_qty := coalesce(p_qty, mo.qty_to_produce - mo.qty_produced);
  if v_qty <= 0 then raise exception 'Produzierte Menge muss größer als 0 sein'; end if;
  if v_qty > mo.qty_to_produce - mo.qty_produced then
    raise exception 'Produzierte Menge (%) übersteigt die offene Menge (%)',
      v_qty, mo.qty_to_produce - mo.qty_produced;
  end if;

  v_tracking := product_tracking(mo.variant_id);
  if p_lot is not null and v_tracking = 'serial' and v_qty <> 1 then
    raise exception 'Eine Seriennummer gilt für genau 1 Stück — bitte einzeln fertig melden';
  end if;

  select * into v_bom from boms where id = mo.bom_id;
  select id into v_stock from stock_locations where full_path = 'WH/Stock';
  select id into v_production from stock_locations where type = 'production' limit 1;

  -- Anteil dieser Teilproduktion an der Gesamtmenge des Auftrags
  v_factor := v_qty / mo.qty_to_produce;
  v_remaining := mo.qty_to_produce - mo.qty_produced - v_qty;

  -- Komponenten verbrauchen
  for m in select * from stock_moves where production_id = p_mo and state not in ('done', 'cancel') loop
    v_expected := round(m.qty * v_factor, 4);
    v_actual := coalesce((p_consumed ->> m.id::text)::numeric, v_expected);

    if v_actual <> v_expected then
      if v_bom.consumption = 'blocked' then
        raise exception 'Abweichender Verbrauch ist für diese Stückliste gesperrt (Soll %, Ist %)',
          v_expected, v_actual;
      elsif v_bom.consumption = 'warning' then
        perform log_event('manufacturing_order', p_mo, 'note',
          format('Abweichender Verbrauch bei %s: Soll %s, Ist %s',
                 variant_display_name(m.variant_id), v_expected, v_actual), p_actor);
      end if;
    end if;

    if v_remaining > 0 and p_create_backorder then
      -- Restbedarf bleibt für den Rückstands-Auftrag stehen: aktuelle Bewegung
      -- auf die Ist-Menge kürzen und den Rest in eine neue Bewegung übernehmen.
      update stock_moves set qty = v_actual where id = m.id;
    end if;

    if v_actual > 0 then
      perform move_done(m.id, v_actual);
    else
      perform move_cancel(m.id);
    end if;
  end loop;

  -- Fertigprodukt zubuchen
  insert into stock_moves (
    production_id, variant_id, uom_id, qty, src_location_id, dest_location_id,
    state, reference)
  values (p_mo, mo.variant_id, mo.uom_id, v_qty, v_production, v_stock, 'confirmed', 'Fertigmeldung')
  returning id into v_finished;

  -- Gewünschte Losnummer setzen (sonst legt move_done automatisch an).
  if p_lot is not null and v_tracking <> 'none' then
    v_lot := ensure_lot(mo.variant_id, p_lot);
    insert into move_lot_assignments (move_id, lot_id, qty)
    values (v_finished, v_lot, v_qty)
    on conflict (move_id, lot_id) do update set qty = excluded.qty;
  end if;

  perform move_done(v_finished, v_qty);

  if v_tracking <> 'none' and v_lot is null then
    select lot_id into v_lot from move_lot_assignments
    where move_id = v_finished order by qty desc limit 1;
  end if;

  update manufacturing_orders
    set qty_produced = qty_produced + v_qty,
        state = 'done',
        date_done = now(),
        finished_move_id = v_finished,
        lot_producing_id = coalesce(v_lot, lot_producing_id)
  where id = p_mo;

  -- Rückstand für die Restmenge
  if v_remaining > 0 and p_create_backorder then
    v_backorder := create_manufacturing_order(
      mo.variant_id, v_remaining, mo.sales_order_id, mo.scheduled_date, p_actor);
    update manufacturing_orders set backorder_of_id = p_mo where id = v_backorder;
    perform mo_confirm(v_backorder, p_actor);
    perform log_event('manufacturing_order', p_mo, 'state',
      'Teilmenge gefertigt, Rückstand: ' ||
      (select number from manufacturing_orders where id = v_backorder), p_actor);
  else
    perform log_event('manufacturing_order', p_mo, 'state',
      format('Fertig gemeldet: %s', v_qty), p_actor);
  end if;

  -- Sind alle Fertigungsaufträge des Verkaufsauftrags erledigt, ist die
  -- Lieferung versandbereit -> reservieren.
  if mo.sales_order_id is not null then
    if not exists (
      select 1 from manufacturing_orders
      where sales_order_id = mo.sales_order_id and state not in ('done', 'cancel')
    ) then
      perform picking_check_availability(p.id)
      from stock_pickings p
      where p.origin_model = 'sales_order' and p.origin_id = mo.sales_order_id
        and p.state not in ('done', 'cancel');
      perform log_event('sales_order', mo.sales_order_id, 'state',
        'Alle Fertigungsaufträge erledigt - Lieferung ist versandbereit', p_actor);
      perform sales_order_recompute_status(mo.sales_order_id);
    end if;
  end if;

  return v_backorder;
end $$;
