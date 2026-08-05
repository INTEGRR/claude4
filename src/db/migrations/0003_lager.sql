-- ===========================================================================
-- Lager: Orte, Vorgangsarten, Transfers, Bewegungs-Ledger, Bestände
--
-- Grundregel: JEDE Bestandsänderung ist eine Bewegung von Ort A nach Ort B.
-- stock_quants wird ausschließlich durch die Funktionen in dieser Datei
-- fortgeschrieben - nie durch direkte UPDATEs aus der Anwendung.
-- ===========================================================================

create type location_type as enum
  ('internal', 'vendor', 'customer', 'view', 'inventory_loss', 'production', 'transit');

create table warehouses (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  code       text unique not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
select attach_touch_trigger('warehouses');

create table stock_locations (
  id           uuid primary key default gen_random_uuid(),
  warehouse_id uuid references warehouses on delete restrict,
  parent_id    uuid references stock_locations on delete restrict,
  name         text not null,
  full_path    text not null,
  type         location_type not null,
  is_scrap     boolean not null default false,
  barcode      text unique,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz
);
select attach_touch_trigger('stock_locations');
create index stock_locations_parent_idx on stock_locations (parent_id);

-- full_path aus der Hierarchie pflegen ("WH/Stock/Regal A").
create or replace function trg_location_path() returns trigger
language plpgsql as $$
declare
  parent_path text;
begin
  if new.parent_id is null then
    new.full_path := new.name;
  else
    select full_path into parent_path from stock_locations where id = new.parent_id;
    new.full_path := parent_path || '/' || new.name;
  end if;
  return new;
end $$;

create trigger stock_locations_path
  before insert or update of name, parent_id on stock_locations
  for each row execute function trg_location_path();


-- --- Vorgangsarten ---------------------------------------------------------
create type picking_kind as enum ('receipt', 'delivery', 'internal', 'repair');
create type backorder_policy as enum ('ask', 'always', 'never');
create type reservation_method as enum ('at_confirm', 'manual');

create table operation_types (
  id               uuid primary key default gen_random_uuid(),
  kind             picking_kind not null,
  name             text not null,
  sequence_code    text not null references sequences (code),
  default_src_id   uuid references stock_locations on delete restrict,
  default_dest_id  uuid references stock_locations on delete restrict,
  backorder_policy backorder_policy not null default 'ask',
  reservation      reservation_method not null default 'at_confirm',
  return_type_id   uuid references operation_types on delete set null,
  barcode          text unique,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz
);
select attach_touch_trigger('operation_types');


-- --- Transfers und Bewegungen ---------------------------------------------
create type picking_state as enum ('draft', 'waiting', 'confirmed', 'assigned', 'done', 'cancel');
create type move_state    as enum ('draft', 'waiting', 'confirmed', 'assigned', 'done', 'cancel');

create table stock_pickings (
  id                uuid primary key default gen_random_uuid(),
  number            text unique not null,
  operation_type_id uuid not null references operation_types on delete restrict,
  state             picking_state not null default 'draft',
  partner_id        uuid references partners on delete restrict,
  scheduled_date    timestamptz not null default now(),
  date_done         timestamptz,
  origin_model      text,     -- 'sales_order' | 'purchase_order' | 'repair_order'
  origin_id         uuid,
  origin_label      text,     -- Belegnummer im Klartext für Listen/Drucke
  backorder_of_id   uuid references stock_pickings on delete set null,
  return_of_id      uuid references stock_pickings on delete set null,
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz
);
select attach_touch_trigger('stock_pickings');
create index stock_pickings_origin_idx on stock_pickings (origin_model, origin_id);
create index stock_pickings_state_idx on stock_pickings (state);

create table stock_moves (
  id               uuid primary key default gen_random_uuid(),
  picking_id       uuid references stock_pickings on delete cascade,
  production_id    uuid,   -- FK wird in 0005 ergänzt (Fertigung)
  unbuild_id       uuid,
  repair_id        uuid,   -- FK wird in 0009 ergänzt (Reparatur)
  inventory_id     uuid,
  variant_id       uuid not null references product_variants on delete restrict,
  uom_id           uuid not null references uoms on delete restrict,
  qty              numeric(16,4) not null check (qty >= 0),
  qty_done         numeric(16,4) not null default 0 check (qty_done >= 0),
  reserved_qty     numeric(16,4) not null default 0 check (reserved_qty >= 0),
  src_location_id  uuid not null references stock_locations on delete restrict,
  dest_location_id uuid not null references stock_locations on delete restrict,
  state            move_state not null default 'draft',
  reference        text,          -- freier Verwendungszweck, z. B. 'Inventur'
  date_done        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz
);
select attach_touch_trigger('stock_moves');
create index stock_moves_picking_idx on stock_moves (picking_id);
create index stock_moves_variant_idx on stock_moves (variant_id, state);
create index stock_moves_production_idx on stock_moves (production_id);
create index stock_moves_repair_idx on stock_moves (repair_id);


-- --- Bestände (materialisiert aus erledigten Bewegungen) -------------------
create table stock_quants (
  location_id uuid not null references stock_locations on delete restrict,
  variant_id  uuid not null references product_variants on delete restrict,
  on_hand     numeric(16,4) not null default 0,
  reserved    numeric(16,4) not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (location_id, variant_id)
);
create index stock_quants_variant_idx on stock_quants (variant_id);

-- Interne Hilfsfunktion: Bestand an einem Ort verändern (nur aus den
-- Buchungsfunktionen unten aufgerufen).
create or replace function quant_apply(
  p_location uuid, p_variant uuid, p_on_hand_delta numeric, p_reserved_delta numeric
) returns void
language plpgsql as $$
begin
  insert into stock_quants (location_id, variant_id, on_hand, reserved)
  values (p_location, p_variant, p_on_hand_delta, p_reserved_delta)
  on conflict (location_id, variant_id) do update
    set on_hand  = stock_quants.on_hand + excluded.on_hand,
        reserved = stock_quants.reserved + excluded.reserved,
        updated_at = now();
end $$;


-- --- Verfügbarkeit ---------------------------------------------------------
-- Frei verfügbar an internen Orten = Bestand minus Reservierungen.
create or replace function free_to_use(p_variant uuid, p_location uuid default null)
returns numeric
language sql stable as $$
  select coalesce(sum(q.on_hand - q.reserved), 0)
  from stock_quants q
  join stock_locations l on l.id = q.location_id
  where q.variant_id = p_variant
    and l.type = 'internal'
    and (p_location is null or q.location_id = p_location);
$$;

create or replace function on_hand_qty(p_variant uuid, p_location uuid default null)
returns numeric
language sql stable as $$
  select coalesce(sum(q.on_hand), 0)
  from stock_quants q
  join stock_locations l on l.id = q.location_id
  where q.variant_id = p_variant
    and l.type = 'internal'
    and (p_location is null or q.location_id = p_location);
$$;

-- Erwartete Zu-/Abgänge aus offenen Bewegungen (bestätigt, noch nicht gebucht).
create or replace function incoming_qty(p_variant uuid) returns numeric
language sql stable as $$
  select coalesce(sum(uom_convert(m.qty - m.qty_done, m.uom_id, pt.uom_id)), 0)
  from stock_moves m
  join stock_locations src on src.id = m.src_location_id
  join stock_locations dst on dst.id = m.dest_location_id
  join product_variants pv on pv.id = m.variant_id
  join product_templates pt on pt.id = pv.template_id
  where m.variant_id = p_variant
    and m.state in ('waiting', 'confirmed', 'assigned')
    and dst.type = 'internal' and src.type <> 'internal';
$$;

create or replace function outgoing_qty(p_variant uuid) returns numeric
language sql stable as $$
  select coalesce(sum(uom_convert(m.qty - m.qty_done, m.uom_id, pt.uom_id)), 0)
  from stock_moves m
  join stock_locations src on src.id = m.src_location_id
  join stock_locations dst on dst.id = m.dest_location_id
  join product_variants pv on pv.id = m.variant_id
  join product_templates pt on pt.id = pv.template_id
  where m.variant_id = p_variant
    and m.state in ('waiting', 'confirmed', 'assigned')
    and src.type = 'internal' and dst.type <> 'internal';
$$;

create or replace function forecasted_qty(p_variant uuid) returns numeric
language sql stable as $$
  select on_hand_qty(p_variant) + incoming_qty(p_variant) - outgoing_qty(p_variant);
$$;


-- ===========================================================================
-- Buchungsfunktionen
-- ===========================================================================

-- Reserviert für eine einzelne Bewegung so viel wie möglich und setzt den
-- Status auf 'assigned' (voll reserviert) bzw. 'confirmed' (teilweise/gar nicht).
create or replace function move_reserve(p_move uuid) returns numeric
language plpgsql as $$
declare
  m stock_moves%rowtype;
  src_type location_type;
  v_needed numeric;
  v_available numeric;
  v_take numeric;
begin
  select * into m from stock_moves where id = p_move for update;
  if m.id is null then raise exception 'Bewegung % nicht gefunden', p_move; end if;
  if m.state in ('done', 'cancel', 'draft') then return m.reserved_qty; end if;

  select type into src_type from stock_locations where id = m.src_location_id;

  -- Aus virtuellen Quellen (Lieferant, Produktion, Inventurdifferenz) muss
  -- nichts reserviert werden - dort ist immer "genug" vorhanden.
  if src_type <> 'internal' then
    update stock_moves set state = 'assigned' where id = p_move;
    return m.qty;
  end if;

  v_needed := m.qty - m.reserved_qty;
  if v_needed <= 0 then
    update stock_moves set state = 'assigned' where id = p_move;
    return m.reserved_qty;
  end if;

  select greatest(coalesce(on_hand - reserved, 0), 0) into v_available
  from stock_quants where location_id = m.src_location_id and variant_id = m.variant_id;
  v_available := coalesce(v_available, 0);

  v_take := least(v_needed, v_available);
  if v_take > 0 then
    perform quant_apply(m.src_location_id, m.variant_id, 0, v_take);
    update stock_moves set reserved_qty = reserved_qty + v_take where id = p_move;
  end if;

  update stock_moves
    set state = case when reserved_qty >= qty then 'assigned'::move_state
                     else 'confirmed'::move_state end
  where id = p_move;

  return m.reserved_qty + v_take;
end $$;

-- Gibt die Reservierung einer Bewegung wieder frei.
create or replace function move_unreserve(p_move uuid) returns void
language plpgsql as $$
declare
  m stock_moves%rowtype;
begin
  select * into m from stock_moves where id = p_move for update;
  if m.id is null or m.reserved_qty = 0 then return; end if;

  perform quant_apply(m.src_location_id, m.variant_id, 0, -m.reserved_qty);
  update stock_moves set reserved_qty = 0 where id = p_move;
end $$;

-- Bucht eine Bewegung endgültig: Quelle -, Ziel +. Das ist der einzige Weg,
-- auf dem sich on_hand jemals ändert.
create or replace function move_done(p_move uuid, p_qty_done numeric default null)
returns void
language plpgsql as $$
declare
  m stock_moves%rowtype;
  v_qty numeric;
  v_release numeric;
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

  -- Reservierung auflösen, soweit vorhanden.
  v_release := least(m.reserved_qty, v_qty);
  if m.reserved_qty > 0 then
    perform quant_apply(m.src_location_id, m.variant_id, 0, -m.reserved_qty);
  end if;

  perform quant_apply(m.src_location_id, m.variant_id, -v_qty, 0);
  perform quant_apply(m.dest_location_id, m.variant_id, v_qty, 0);

  update stock_moves
    set state = 'done', qty_done = v_qty, reserved_qty = 0, date_done = now()
  where id = p_move;
end $$;

create or replace function move_cancel(p_move uuid) returns void
language plpgsql as $$
declare
  m stock_moves%rowtype;
begin
  select * into m from stock_moves where id = p_move for update;
  if m.id is null or m.state in ('done', 'cancel') then return; end if;
  perform move_unreserve(p_move);
  update stock_moves set state = 'cancel' where id = p_move;
end $$;


-- --- Transfer-Ebene --------------------------------------------------------
-- Leitet den Transferstatus aus seinen Bewegungen ab.
create or replace function picking_recompute_state(p_picking uuid) returns void
language plpgsql as $$
declare
  v_total int; v_done int; v_cancel int; v_assigned int; v_draft int;
begin
  select count(*),
         count(*) filter (where state = 'done'),
         count(*) filter (where state = 'cancel'),
         count(*) filter (where state = 'assigned'),
         count(*) filter (where state = 'draft')
    into v_total, v_done, v_cancel, v_assigned, v_draft
  from stock_moves where picking_id = p_picking;

  if v_total = 0 then return; end if;

  update stock_pickings p set
    state = case
      when v_cancel = v_total then 'cancel'::picking_state
      when v_done + v_cancel = v_total then 'done'::picking_state
      when v_draft = v_total then 'draft'::picking_state
      when v_assigned + v_done + v_cancel = v_total then 'assigned'::picking_state
      else 'confirmed'::picking_state
    end,
    date_done = case when v_done + v_cancel = v_total and v_done > 0 then coalesce(p.date_done, now()) else p.date_done end
  where p.id = p_picking;
end $$;

-- Bestätigt einen Transfer: Bewegungen aktivieren und (je Vorgangsart) reservieren.
create or replace function picking_confirm(p_picking uuid) returns void
language plpgsql as $$
declare
  v_reservation reservation_method;
  m record;
begin
  select ot.reservation into v_reservation
  from stock_pickings p join operation_types ot on ot.id = p.operation_type_id
  where p.id = p_picking;

  update stock_moves set state = 'confirmed'
  where picking_id = p_picking and state = 'draft';

  if v_reservation = 'at_confirm' then
    for m in select id from stock_moves where picking_id = p_picking and state in ('confirmed', 'waiting') loop
      perform move_reserve(m.id);
    end loop;
  end if;

  perform picking_recompute_state(p_picking);
end $$;

-- Versucht erneut zu reservieren ("Verfügbarkeit prüfen").
create or replace function picking_check_availability(p_picking uuid) returns void
language plpgsql as $$
declare m record;
begin
  for m in select id from stock_moves
           where picking_id = p_picking and state in ('confirmed', 'waiting', 'assigned') loop
    perform move_reserve(m.id);
  end loop;
  perform picking_recompute_state(p_picking);
end $$;

/*
 * Validiert einen Transfer.
 *
 *   p_done  jsonb-Objekt {move_id: menge}. Fehlt eine Bewegung, gilt ihre
 *           Bedarfsmenge als erledigt.
 *   p_create_backorder  true  => Restmengen wandern in einen neuen Transfer
 *                       false => Restmengen werden aufgegeben
 *
 * Rückgabe: id des Rückstands-Transfers oder null.
 */
create or replace function picking_validate(
  p_picking uuid,
  p_done jsonb default '{}'::jsonb,
  p_create_backorder boolean default true
) returns uuid
language plpgsql as $$
declare
  p stock_pickings%rowtype;
  m stock_moves%rowtype;
  v_qty numeric;
  v_backorder uuid;
  v_remaining numeric;
  v_has_remainder boolean := false;
begin
  select * into p from stock_pickings where id = p_picking for update;
  if p.id is null then raise exception 'Transfer % nicht gefunden', p_picking; end if;
  if p.state = 'done' then raise exception 'Transfer % ist bereits erledigt', p.number; end if;
  if p.state = 'cancel' then raise exception 'Transfer % ist storniert', p.number; end if;

  -- Gibt es überhaupt Restmengen?
  for m in select * from stock_moves where picking_id = p_picking and state not in ('done', 'cancel') loop
    v_qty := coalesce((p_done ->> m.id::text)::numeric, m.qty);
    if v_qty < m.qty then v_has_remainder := true; end if;
  end loop;

  if v_has_remainder and p_create_backorder then
    insert into stock_pickings (
      number, operation_type_id, state, partner_id, scheduled_date,
      origin_model, origin_id, origin_label, backorder_of_id, note)
    values (
      next_sequence((select sequence_code from operation_types where id = p.operation_type_id)),
      p.operation_type_id, 'confirmed', p.partner_id, p.scheduled_date,
      p.origin_model, p.origin_id, p.origin_label, p.id, p.note)
    returning id into v_backorder;
  end if;

  for m in select * from stock_moves where picking_id = p_picking and state not in ('done', 'cancel') loop
    v_qty := coalesce((p_done ->> m.id::text)::numeric, m.qty);
    if v_qty > m.qty then
      raise exception 'Erledigte Menge (%) darf die Bedarfsmenge (%) nicht überschreiten', v_qty, m.qty;
    end if;

    v_remaining := m.qty - v_qty;

    if v_qty > 0 then
      perform move_done(m.id, v_qty);
    else
      perform move_cancel(m.id);
    end if;

    if v_remaining > 0 and v_backorder is not null then
      insert into stock_moves (
        picking_id, variant_id, uom_id, qty, src_location_id, dest_location_id, state, reference)
      values (
        v_backorder, m.variant_id, m.uom_id, v_remaining,
        m.src_location_id, m.dest_location_id, 'confirmed', m.reference);
    end if;
  end loop;

  perform picking_recompute_state(p_picking);
  update stock_pickings set date_done = now() where id = p_picking and date_done is null;

  if v_backorder is not null then
    perform picking_check_availability(v_backorder);
    perform log_event('stock_picking', p_picking, 'state',
      'Teilmenge validiert, Rückstand angelegt: ' ||
      (select number from stock_pickings where id = v_backorder));
  else
    perform log_event('stock_picking', p_picking, 'state', 'Transfer validiert');
  end if;

  return v_backorder;
end $$;

create or replace function picking_cancel(p_picking uuid) returns void
language plpgsql as $$
declare
  p stock_pickings%rowtype;
  m record;
begin
  select * into p from stock_pickings where id = p_picking for update;
  if p.id is null then raise exception 'Transfer % nicht gefunden', p_picking; end if;
  if p.state = 'done' then
    raise exception 'Erledigte Transfers können nicht storniert werden - bitte eine Retoure anlegen';
  end if;

  for m in select id from stock_moves where picking_id = p_picking loop
    perform move_cancel(m.id);
  end loop;

  update stock_pickings set state = 'cancel' where id = p_picking;
  perform log_event('stock_picking', p_picking, 'state', 'Transfer storniert');
end $$;

-- Retoure zu einem erledigten Transfer: gleicher Inhalt, Orte getauscht.
create or replace function picking_return(p_picking uuid, p_lines jsonb default '{}'::jsonb)
returns uuid
language plpgsql as $$
declare
  p stock_pickings%rowtype;
  v_type operation_types%rowtype;
  v_return_type uuid;
  v_new uuid;
  m stock_moves%rowtype;
  v_qty numeric;
begin
  select * into p from stock_pickings where id = p_picking;
  if p.id is null then raise exception 'Transfer % nicht gefunden', p_picking; end if;
  if p.state <> 'done' then
    raise exception 'Nur erledigte Transfers können retourniert werden';
  end if;

  select * into v_type from operation_types where id = p.operation_type_id;
  v_return_type := coalesce(v_type.return_type_id, v_type.id);

  insert into stock_pickings (
    number, operation_type_id, state, partner_id, scheduled_date,
    origin_model, origin_id, origin_label, return_of_id, note)
  values (
    next_sequence((select sequence_code from operation_types where id = v_return_type)),
    v_return_type, 'draft', p.partner_id, now(),
    p.origin_model, p.origin_id, p.origin_label, p.id,
    'Retoure zu ' || p.number)
  returning id into v_new;

  for m in select * from stock_moves where picking_id = p_picking and state = 'done' loop
    v_qty := coalesce((p_lines ->> m.id::text)::numeric, m.qty_done);
    if v_qty > 0 then
      insert into stock_moves (
        picking_id, variant_id, uom_id, qty, src_location_id, dest_location_id, state)
      values (
        v_new, m.variant_id, m.uom_id, v_qty,
        m.dest_location_id, m.src_location_id, 'draft');
    end if;
  end loop;

  perform picking_confirm(v_new);
  perform log_event('stock_picking', p_picking, 'state',
    'Retoure angelegt: ' || (select number from stock_pickings where id = v_new));
  return v_new;
end $$;


-- --- Inventur --------------------------------------------------------------
create table inventory_counts (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null references stock_locations on delete restrict,
  variant_id  uuid not null references product_variants on delete restrict,
  counted_qty numeric(16,4) not null,
  book_qty    numeric(16,4) not null default 0,   -- Buchbestand bei Erfassung
  applied_at  timestamptz,
  applied_by  text,
  move_id     uuid references stock_moves on delete set null,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);
select attach_touch_trigger('inventory_counts');

-- Bucht die Differenz gegen den virtuellen Inventurdifferenz-Ort.
create or replace function inventory_apply(p_count uuid, p_actor text default 'system')
returns uuid
language plpgsql as $$
declare
  c inventory_counts%rowtype;
  v_current numeric;
  v_diff numeric;
  v_loss uuid;
  v_uom uuid;
  v_move uuid;
begin
  select * into c from inventory_counts where id = p_count for update;
  if c.id is null then raise exception 'Zählung % nicht gefunden', p_count; end if;
  if c.applied_at is not null then raise exception 'Zählung wurde bereits gebucht'; end if;

  select coalesce(on_hand, 0) into v_current
  from stock_quants where location_id = c.location_id and variant_id = c.variant_id;
  v_current := coalesce(v_current, 0);

  if v_current <> c.book_qty then
    raise exception 'Der Bestand hat sich seit der Zählung geändert (jetzt %, bei Zählung %). Bitte erneut zählen.',
      v_current, c.book_qty;
  end if;

  v_diff := c.counted_qty - v_current;

  select id into v_loss from stock_locations
  where type = 'inventory_loss' and not is_scrap and active order by full_path limit 1;
  if v_loss is null then raise exception 'Kein Lagerort für Inventurdifferenzen konfiguriert'; end if;

  select pt.uom_id into v_uom
  from product_variants pv join product_templates pt on pt.id = pv.template_id
  where pv.id = c.variant_id;

  if v_diff = 0 then
    update inventory_counts set applied_at = now(), applied_by = p_actor where id = p_count;
    return null;
  end if;

  insert into stock_moves (variant_id, uom_id, qty, src_location_id, dest_location_id,
                           state, reference, inventory_id)
  values (
    c.variant_id, v_uom, abs(v_diff),
    case when v_diff > 0 then v_loss else c.location_id end,
    case when v_diff > 0 then c.location_id else v_loss end,
    'confirmed', 'Inventurkorrektur', c.id)
  returning id into v_move;

  perform move_done(v_move);
  update inventory_counts
    set applied_at = now(), applied_by = p_actor, move_id = v_move
  where id = p_count;

  return v_move;
end $$;


-- --- Ausschuss -------------------------------------------------------------
create or replace function scrap(
  p_variant uuid, p_qty numeric, p_src uuid, p_reason text default null
) returns uuid
language plpgsql as $$
declare
  v_scrap uuid;
  v_uom uuid;
  v_move uuid;
begin
  if p_qty <= 0 then raise exception 'Ausschussmenge muss größer als 0 sein'; end if;

  select id into v_scrap from stock_locations where is_scrap and active limit 1;
  if v_scrap is null then raise exception 'Kein Ausschuss-Lagerort konfiguriert'; end if;

  select pt.uom_id into v_uom
  from product_variants pv join product_templates pt on pt.id = pv.template_id
  where pv.id = p_variant;

  insert into stock_moves (variant_id, uom_id, qty, src_location_id, dest_location_id,
                           state, reference)
  values (p_variant, v_uom, p_qty, p_src, v_scrap, 'confirmed',
          coalesce(p_reason, 'Ausschuss'))
  returning id into v_move;

  perform move_done(v_move);
  return v_move;
end $$;


-- --- Grunddaten ------------------------------------------------------------
insert into warehouses (name, code) values ('Hauptlager', 'WH');

insert into stock_locations (warehouse_id, name, type)
select id, 'WH', 'view' from warehouses where code = 'WH';

insert into stock_locations (warehouse_id, parent_id, name, type, barcode)
select w.id, l.id, 'Stock', 'internal', 'LOC-WH-STOCK'
from warehouses w, stock_locations l where w.code = 'WH' and l.name = 'WH';

insert into stock_locations (name, type) values ('Partner', 'view');
insert into stock_locations (parent_id, name, type)
select id, 'Lieferanten', 'vendor' from stock_locations where name = 'Partner';
insert into stock_locations (parent_id, name, type)
select id, 'Kunden', 'customer' from stock_locations where name = 'Partner';

insert into stock_locations (name, type) values ('Virtuell', 'view');
insert into stock_locations (parent_id, name, type)
select id, 'Produktion', 'production' from stock_locations where name = 'Virtuell';
insert into stock_locations (parent_id, name, type)
select id, 'Inventurdifferenz', 'inventory_loss' from stock_locations where name = 'Virtuell';
insert into stock_locations (parent_id, name, type, is_scrap)
select id, 'Ausschuss', 'inventory_loss', true from stock_locations where name = 'Virtuell';

-- Vorgangsarten
insert into operation_types (kind, name, sequence_code, default_src_id, default_dest_id, barcode)
values (
  'receipt', 'Wareneingang', 'receipt',
  (select id from stock_locations where full_path = 'Partner/Lieferanten'),
  (select id from stock_locations where full_path = 'WH/Stock'),
  'OP-IN');

insert into operation_types (kind, name, sequence_code, default_src_id, default_dest_id, barcode)
values (
  'delivery', 'Warenausgang', 'delivery',
  (select id from stock_locations where full_path = 'WH/Stock'),
  (select id from stock_locations where full_path = 'Partner/Kunden'),
  'OP-OUT');

insert into operation_types (kind, name, sequence_code, default_src_id, default_dest_id, barcode)
values (
  'internal', 'Interner Transfer', 'internal',
  (select id from stock_locations where full_path = 'WH/Stock'),
  (select id from stock_locations where full_path = 'WH/Stock'),
  'OP-INT');

insert into operation_types (kind, name, sequence_code, default_src_id, default_dest_id, backorder_policy, barcode)
values (
  'repair', 'Reparatur', 'repair_op',
  (select id from stock_locations where full_path = 'WH/Stock'),
  (select id from stock_locations where full_path = 'WH/Stock'),
  'never', 'OP-REP');

-- Wareneingang und Warenausgang sind wechselseitig die Retouren-Vorgangsart.
update operation_types o set return_type_id = (
  select id from operation_types where kind = 'receipt') where o.kind = 'delivery';
update operation_types o set return_type_id = (
  select id from operation_types where kind = 'delivery') where o.kind = 'receipt';
