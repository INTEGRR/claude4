-- ===========================================================================
-- Reparatur: Reparaturaufträge mit Teileverbrauch
-- ===========================================================================

create type repair_state as enum ('new', 'confirmed', 'under_repair', 'repaired', 'cancel');
create type repair_part_type as enum ('add', 'remove', 'recycle');

create table repair_orders (
  id                uuid primary key default gen_random_uuid(),
  number            text unique not null,
  partner_id        uuid not null references partners on delete restrict,
  variant_id        uuid not null references product_variants on delete restrict,
  qty               numeric(16,4) not null default 1 check (qty > 0),
  under_warranty    boolean not null default false,
  state             repair_state not null default 'new',
  scheduled_date    timestamptz not null default now(),
  responsible       text,
  return_picking_id uuid references stock_pickings on delete set null,
  sales_order_id    uuid references sales_orders on delete set null,
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz
);
select attach_touch_trigger('repair_orders');
create index repair_orders_state_idx on repair_orders (state);

alter table stock_moves
  add constraint stock_moves_repair_fk
  foreign key (repair_id) references repair_orders on delete cascade;

alter table return_labels
  add constraint return_labels_repair_fk
  foreign key (repair_order_id) references repair_orders on delete set null;

create table repair_parts (
  id         uuid primary key default gen_random_uuid(),
  repair_id  uuid not null references repair_orders on delete cascade,
  sequence   int not null default 10,
  part_type  repair_part_type not null,
  variant_id uuid not null references product_variants on delete restrict,
  qty        numeric(16,4) not null check (qty > 0),
  qty_done   numeric(16,4) not null default 0,
  uom_id     uuid not null references uoms on delete restrict,
  price_unit numeric(16,2) not null default 0,
  move_id    uuid references stock_moves on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
select attach_touch_trigger('repair_parts');
create index repair_parts_repair_idx on repair_parts (repair_id, sequence);

/*
 * Bestätigen: legt für alle Teile die Bewegungen an und reserviert die
 * einzubauenden Teile (Typ "add").
 *
 * Buchungsrichtungen:
 *   add     Lager -> Produktion   (Teil wird verbaut, verlässt den Bestand)
 *   remove  Produktion -> Ausschuss (ausgebautes Teil wird entsorgt)
 *   recycle Produktion -> Lager   (ausgebautes Teil ist wiederverwendbar)
 */
create or replace function repair_confirm(p_repair uuid, p_actor text default 'system')
returns void
language plpgsql as $$
declare
  r repair_orders%rowtype;
  part record;
  v_stock uuid;
  v_production uuid;
  v_scrap uuid;
  v_src uuid;
  v_dest uuid;
  v_move uuid;
begin
  select * into r from repair_orders where id = p_repair for update;
  if r.id is null then raise exception 'Reparaturauftrag nicht gefunden'; end if;
  if r.state <> 'new' then return; end if;

  select id into v_stock from stock_locations where full_path = 'WH/Stock';
  select id into v_production from stock_locations where type = 'production' limit 1;
  select id into v_scrap from stock_locations where is_scrap limit 1;

  for part in select * from repair_parts where repair_id = p_repair and move_id is null loop
    if part.part_type = 'add' then
      v_src := v_stock; v_dest := v_production;
    elsif part.part_type = 'remove' then
      v_src := v_production; v_dest := v_scrap;
    else
      v_src := v_production; v_dest := v_stock;
    end if;

    insert into stock_moves (repair_id, variant_id, uom_id, qty,
                             src_location_id, dest_location_id, state, reference)
    values (p_repair, part.variant_id, part.uom_id, part.qty, v_src, v_dest,
            'confirmed', 'Reparatur ' || r.number)
    returning id into v_move;

    update repair_parts set move_id = v_move where id = part.id;

    if part.part_type = 'add' then
      perform move_reserve(v_move);
    end if;
  end loop;

  update repair_orders set state = 'confirmed' where id = p_repair;
  perform log_event('repair_order', p_repair, 'state', 'Reparatur bestätigt', p_actor);
end $$;

create or replace function repair_start(p_repair uuid, p_actor text default 'system')
returns void language plpgsql as $$
begin
  update repair_orders set state = 'under_repair'
  where id = p_repair and state = 'confirmed';
  perform log_event('repair_order', p_repair, 'state', 'Reparatur gestartet', p_actor);
end $$;

/*
 * Beenden: bucht alle Teilebewegungen. p_done erlaubt abweichende Ist-Mengen
 * ({repair_part_id: menge}); nicht verbaute Teile werden storniert.
 */
create or replace function repair_end(
  p_repair uuid, p_done jsonb default '{}'::jsonb, p_actor text default 'system'
) returns void
language plpgsql as $$
declare
  r repair_orders%rowtype;
  part record;
  v_qty numeric;
begin
  select * into r from repair_orders where id = p_repair for update;
  if r.id is null then raise exception 'Reparaturauftrag nicht gefunden'; end if;
  if r.state not in ('confirmed', 'under_repair') then
    raise exception 'Reparaturauftrag % kann nicht abgeschlossen werden (Status %)', r.number, r.state;
  end if;

  for part in select * from repair_parts where repair_id = p_repair loop
    v_qty := coalesce((p_done ->> part.id::text)::numeric, part.qty);
    if part.move_id is not null then
      if v_qty > 0 then
        perform move_done(part.move_id, v_qty);
      else
        perform move_cancel(part.move_id);
      end if;
    end if;
    update repair_parts set qty_done = v_qty where id = part.id;
  end loop;

  update repair_orders set state = 'repaired' where id = p_repair;
  perform log_event('repair_order', p_repair, 'state', 'Reparatur abgeschlossen', p_actor);
end $$;

create or replace function repair_cancel(p_repair uuid, p_actor text default 'system')
returns void
language plpgsql as $$
declare part record;
begin
  if exists (select 1 from repair_orders where id = p_repair and state = 'repaired') then
    raise exception 'Abgeschlossene Reparaturen können nicht storniert werden';
  end if;
  for part in select move_id from repair_parts where repair_id = p_repair and move_id is not null loop
    perform move_cancel(part.move_id);
  end loop;
  update repair_orders set state = 'cancel' where id = p_repair;
  perform log_event('repair_order', p_repair, 'state', 'Reparatur storniert', p_actor);
end $$;

/*
 * Kostenpflichtige Reparatur: erzeugt ein Angebot mit den verbauten Teilen.
 * Bei Garantie wird nichts berechnet.
 */
create or replace function repair_create_quotation(p_repair uuid, p_actor text default 'system')
returns uuid
language plpgsql as $$
declare
  r repair_orders%rowtype;
  v_order uuid;
  part record;
  v_seq int := 10;
begin
  select * into r from repair_orders where id = p_repair;
  if r.id is null then raise exception 'Reparaturauftrag nicht gefunden'; end if;
  if r.under_warranty then
    raise exception 'Garantiereparaturen werden nicht berechnet';
  end if;
  if r.sales_order_id is not null then return r.sales_order_id; end if;

  insert into sales_orders (number, partner_id, note)
  values (next_sequence('sale'), r.partner_id, 'Reparatur ' || r.number)
  returning id into v_order;

  for part in
    select rp.*, pt.list_price
    from repair_parts rp
    join product_variants pv on pv.id = rp.variant_id
    join product_templates pt on pt.id = pv.template_id
    where rp.repair_id = p_repair and rp.part_type = 'add'
  loop
    insert into sales_order_lines (order_id, sequence, variant_id, name, qty, uom_id, price_unit)
    values (v_order, v_seq, part.variant_id, variant_display_name(part.variant_id),
            coalesce(nullif(part.qty_done, 0), part.qty), part.uom_id,
            coalesce(nullif(part.price_unit, 0), part.list_price));
    v_seq := v_seq + 10;
  end loop;

  update repair_orders set sales_order_id = v_order where id = p_repair;
  perform log_event('repair_order', p_repair, 'note',
    'Angebot erstellt: ' || (select number from sales_orders where id = v_order), p_actor);
  return v_order;
end $$;
