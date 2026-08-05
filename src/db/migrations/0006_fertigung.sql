-- ===========================================================================
-- Fertigung: Stücklisten, Fertigungsaufträge, Demontage
--
-- Kernfeature "Auf Varianten anwenden" (Odoo: Apply on Variants):
-- Eine Stückliste bedient alle Varianten eines Produkts. Komponentenzeilen
-- ohne Filter gelten für alle Varianten; Zeilen mit Filter nur für Varianten,
-- die mindestens einen der hinterlegten Attributwerte tragen.
-- ===========================================================================

create type bom_type as enum ('manufacture', 'kit');
create type consumption_rule as enum ('blocked', 'allowed', 'warning');

create table boms (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references product_templates on delete cascade,
  variant_id  uuid references product_variants on delete cascade,  -- nur für variantenexklusive Stücklisten
  code        text,
  qty         numeric(16,4) not null default 1 check (qty > 0),
  uom_id      uuid not null references uoms on delete restrict,
  bom_type    bom_type not null default 'manufacture',
  consumption consumption_rule not null default 'warning',
  active      boolean not null default true,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);
select attach_touch_trigger('boms');
create index boms_template_idx on boms (template_id) where active;

create table bom_lines (
  id                   uuid primary key default gen_random_uuid(),
  bom_id               uuid not null references boms on delete cascade,
  sequence             int not null default 10,
  component_variant_id uuid not null references product_variants on delete restrict,
  qty                  numeric(16,4) not null check (qty > 0),
  uom_id               uuid not null references uoms on delete restrict,
  manual_consumption   boolean not null default false,
  note                 text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz
);
select attach_touch_trigger('bom_lines');
create index bom_lines_bom_idx on bom_lines (bom_id, sequence);

-- ★ "Auf Varianten anwenden": leer = gilt für alle Varianten
create table bom_line_variant_filters (
  bom_line_id uuid not null references bom_lines on delete cascade,
  ptav_id     uuid not null references product_template_attribute_values on delete cascade,
  primary key (bom_line_id, ptav_id)
);

comment on table bom_line_variant_filters is
  'Schränkt eine Stücklistenposition auf bestimmte Attributwerte ein. '
  'Ohne Eintrag gilt die Position für alle Varianten des Produkts.';


-- --- Stücklistenauflösung --------------------------------------------------
-- Wählt die passende Stückliste: variantenexklusiv geht vor Vorlagen-Stückliste.
create or replace function resolve_bom(p_variant uuid) returns uuid
language sql stable as $$
  select b.id
  from boms b
  join product_variants pv on pv.template_id = b.template_id
  where pv.id = p_variant and b.active and b.bom_type = 'manufacture'
  order by (b.variant_id = p_variant) desc nulls last, b.variant_id nulls last, b.created_at
  limit 1;
$$;

/*
 * Liefert die für eine konkrete Variante gültigen Stücklistenpositionen.
 * Das ist die Stelle, an der "Auf Varianten anwenden" wirkt.
 */
create or replace function bom_components_for_variant(p_bom uuid, p_variant uuid)
returns table (
  bom_line_id uuid,
  sequence int,
  component_variant_id uuid,
  qty numeric,
  uom_id uuid,
  manual_consumption boolean
)
language sql stable as $$
  select bl.id, bl.sequence, bl.component_variant_id, bl.qty, bl.uom_id, bl.manual_consumption
  from bom_lines bl
  where bl.bom_id = p_bom
    and (
      -- kein Filter => gilt für alle Varianten
      not exists (select 1 from bom_line_variant_filters f where f.bom_line_id = bl.id)
      -- Filter => Variante muss mindestens einen der Werte tragen
      or exists (
        select 1
        from bom_line_variant_filters f
        join product_variant_attribute_values pvav
          on pvav.ptav_id = f.ptav_id and pvav.variant_id = p_variant
        where f.bom_line_id = bl.id)
    )
  order by bl.sequence, bl.id;
$$;


-- --- Fertigungsaufträge ----------------------------------------------------
create type mo_state as enum ('draft', 'confirmed', 'progress', 'to_close', 'done', 'cancel');

create table manufacturing_orders (
  id              uuid primary key default gen_random_uuid(),
  number          text unique not null,
  variant_id      uuid not null references product_variants on delete restrict,
  bom_id          uuid references boms on delete restrict,
  qty_to_produce  numeric(16,4) not null check (qty_to_produce > 0),
  qty_produced    numeric(16,4) not null default 0,
  uom_id          uuid not null references uoms on delete restrict,
  state           mo_state not null default 'draft',
  scheduled_date  timestamptz not null default now(),
  date_start      timestamptz,
  date_done       timestamptz,
  sales_order_id  uuid references sales_orders on delete set null,
  backorder_of_id uuid references manufacturing_orders on delete set null,
  finished_move_id uuid references stock_moves on delete set null,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz
);
select attach_touch_trigger('manufacturing_orders');
create index mo_state_idx on manufacturing_orders (state);
create index mo_sales_order_idx on manufacturing_orders (sales_order_id);

alter table stock_moves
  add constraint stock_moves_production_fk
  foreign key (production_id) references manufacturing_orders on delete cascade;

/*
 * Legt einen Fertigungsauftrag an und friert den Komponentenbedarf als
 * Bewegungen ein (gefilterte Stückliste, proportional zur Menge).
 */
create or replace function create_manufacturing_order(
  p_variant uuid,
  p_qty numeric,
  p_sales_order uuid default null,
  p_scheduled timestamptz default null,
  p_actor text default 'system'
) returns uuid
language plpgsql as $$
declare
  v_bom boms%rowtype;
  v_mo uuid;
  v_stock uuid;
  v_production uuid;
  v_uom uuid;
  c record;
  v_factor numeric;
begin
  if p_qty <= 0 then raise exception 'Fertigungsmenge muss größer als 0 sein'; end if;

  select * into v_bom from boms where id = resolve_bom(p_variant);
  if v_bom.id is null then
    raise exception 'Für % existiert keine aktive Stückliste', variant_display_name(p_variant);
  end if;

  select pt.uom_id into v_uom
  from product_variants pv join product_templates pt on pt.id = pv.template_id
  where pv.id = p_variant;

  select id into v_stock from stock_locations where full_path = 'WH/Stock';
  select id into v_production from stock_locations where type = 'production' limit 1;

  insert into manufacturing_orders (
    number, variant_id, bom_id, qty_to_produce, uom_id, sales_order_id, scheduled_date)
  values (
    next_sequence('mo'), p_variant, v_bom.id, p_qty, v_uom, p_sales_order,
    coalesce(p_scheduled, now()))
  returning id into v_mo;

  -- Komponentenbedarf einfrieren
  v_factor := p_qty / v_bom.qty;
  for c in select * from bom_components_for_variant(v_bom.id, p_variant) loop
    insert into stock_moves (
      production_id, variant_id, uom_id, qty, src_location_id, dest_location_id,
      state, reference)
    values (
      v_mo, c.component_variant_id, c.uom_id, c.qty * v_factor,
      v_stock, v_production, 'draft', 'Komponentenverbrauch');
  end loop;

  perform log_event('manufacturing_order', v_mo, 'state',
    'Fertigungsauftrag angelegt für ' || variant_display_name(p_variant), p_actor);
  return v_mo;
end $$;

create or replace function mo_confirm(p_mo uuid, p_actor text default 'system')
returns void
language plpgsql as $$
declare
  mo manufacturing_orders%rowtype;
  m record;
begin
  select * into mo from manufacturing_orders where id = p_mo for update;
  if mo.id is null then raise exception 'Fertigungsauftrag nicht gefunden'; end if;
  if mo.state <> 'draft' then return; end if;

  update stock_moves set state = 'confirmed' where production_id = p_mo and state = 'draft';
  for m in select id from stock_moves where production_id = p_mo and state = 'confirmed' loop
    perform move_reserve(m.id);
  end loop;

  update manufacturing_orders set state = 'confirmed' where id = p_mo;
  perform log_event('manufacturing_order', p_mo, 'state', 'Bestätigt', p_actor);
end $$;

create or replace function mo_check_availability(p_mo uuid) returns void
language plpgsql as $$
declare m record;
begin
  for m in select id from stock_moves
           where production_id = p_mo and state in ('confirmed', 'waiting', 'assigned') loop
    perform move_reserve(m.id);
  end loop;
end $$;

create or replace function mo_start(p_mo uuid, p_actor text default 'system') returns void
language plpgsql as $$
begin
  update manufacturing_orders
    set state = 'progress', date_start = coalesce(date_start, now())
  where id = p_mo and state in ('confirmed', 'draft');
  perform log_event('manufacturing_order', p_mo, 'state', 'Fertigung gestartet', p_actor);
end $$;

/*
 * Schließt einen Fertigungsauftrag ab:
 *   - verbraucht die Komponenten (Lager -> Virtuell/Produktion)
 *   - bucht das Fertigprodukt zu (Virtuell/Produktion -> Lager)
 *   - erzeugt bei Teilmengen optional einen Rückstands-Auftrag
 *
 * p_consumed: jsonb {move_id: menge} für abweichenden Ist-Verbrauch.
 */
create or replace function mo_produce(
  p_mo uuid,
  p_qty numeric default null,
  p_consumed jsonb default '{}'::jsonb,
  p_create_backorder boolean default true,
  p_actor text default 'system'
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
  perform move_done(v_finished, v_qty);

  update manufacturing_orders
    set qty_produced = qty_produced + v_qty,
        state = 'done',
        date_done = now(),
        finished_move_id = v_finished
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
    end if;
  end if;

  return v_backorder;
end $$;

create or replace function mo_cancel(p_mo uuid, p_actor text default 'system') returns void
language plpgsql as $$
declare m record;
begin
  if exists (select 1 from manufacturing_orders where id = p_mo and state = 'done') then
    raise exception 'Erledigte Fertigungsaufträge können nicht storniert werden';
  end if;
  for m in select id from stock_moves where production_id = p_mo loop
    perform move_cancel(m.id);
  end loop;
  update manufacturing_orders set state = 'cancel' where id = p_mo;
  perform log_event('manufacturing_order', p_mo, 'state', 'Storniert', p_actor);
end $$;


-- --- Demontage -------------------------------------------------------------
create table unbuild_orders (
  id               uuid primary key default gen_random_uuid(),
  number           text unique not null,
  variant_id       uuid not null references product_variants on delete restrict,
  bom_id           uuid not null references boms on delete restrict,
  qty              numeric(16,4) not null check (qty > 0),
  mo_id            uuid references manufacturing_orders on delete set null,
  src_location_id  uuid not null references stock_locations on delete restrict,
  dest_location_id uuid not null references stock_locations on delete restrict,
  state            text not null default 'draft',
  note             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz
);
select attach_touch_trigger('unbuild_orders');

alter table stock_moves
  add constraint stock_moves_unbuild_fk
  foreign key (unbuild_id) references unbuild_orders on delete cascade;

/*
 * Demontiert ein Produkt: Fertigprodukt raus, Komponenten laut (gefilterter)
 * Stückliste zurück ins Lager. Warnt bei negativem Bestand, blockiert aber nicht
 * (Odoo-Verhalten) - p_force muss dann true sein.
 */
create or replace function unbuild_apply(p_unbuild uuid, p_force boolean default false, p_actor text default 'system')
returns void
language plpgsql as $$
declare
  u unbuild_orders%rowtype;
  b boms%rowtype;
  c record;
  v_production uuid;
  v_move uuid;
  v_factor numeric;
  v_available numeric;
begin
  select * into u from unbuild_orders where id = p_unbuild for update;
  if u.id is null then raise exception 'Demontageauftrag nicht gefunden'; end if;
  if u.state = 'done' then raise exception 'Demontageauftrag % ist bereits erledigt', u.number; end if;

  select * into b from boms where id = u.bom_id;
  select id into v_production from stock_locations where type = 'production' limit 1;

  v_available := on_hand_qty(u.variant_id, u.src_location_id);
  if v_available < u.qty and not p_force then
    raise exception 'Bestand reicht nicht (vorhanden %, benötigt %). Zum Fortfahren bestätigen.',
      v_available, u.qty;
  end if;

  -- Fertigprodukt ausbuchen
  insert into stock_moves (unbuild_id, variant_id, uom_id, qty,
                           src_location_id, dest_location_id, state, reference)
  values (u.id, u.variant_id, b.uom_id, u.qty, u.src_location_id, v_production,
          'confirmed', 'Demontage')
  returning id into v_move;
  perform move_done(v_move, u.qty);

  -- Komponenten zurückbuchen
  v_factor := u.qty / b.qty;
  for c in select * from bom_components_for_variant(b.id, u.variant_id) loop
    insert into stock_moves (unbuild_id, variant_id, uom_id, qty,
                             src_location_id, dest_location_id, state, reference)
    values (u.id, c.component_variant_id, c.uom_id, c.qty * v_factor,
            v_production, u.dest_location_id, 'confirmed', 'Demontage')
    returning id into v_move;
    perform move_done(v_move, c.qty * v_factor);
  end loop;

  update unbuild_orders set state = 'done' where id = p_unbuild;
  perform log_event('unbuild_order', p_unbuild, 'state', 'Demontiert', p_actor);
end $$;


-- ===========================================================================
-- Verkaufsauftrag-Bestätigung um die Fertigungsroute erweitern
-- ===========================================================================
create or replace function confirm_sales_order(p_order uuid, p_actor text default 'system')
returns uuid
language plpgsql as $$
declare
  o sales_orders%rowtype;
  v_op operation_types%rowtype;
  v_picking uuid;
  l record;
  v_count int := 0;
  v_mo uuid;
  v_mo_count int := 0;
begin
  select * into o from sales_orders where id = p_order for update;
  if o.id is null then raise exception 'Verkaufsauftrag nicht gefunden'; end if;
  if o.state = 'sale' then return null; end if;
  if o.state = 'cancel' then raise exception 'Stornierte Aufträge können nicht bestätigt werden'; end if;

  select * into v_op from operation_types where kind = 'delivery' and active limit 1;

  insert into stock_pickings (
    number, operation_type_id, state, partner_id, scheduled_date,
    origin_model, origin_id, origin_label)
  values (
    next_sequence(v_op.sequence_code), v_op.id, 'draft', o.partner_id, now(),
    'sales_order', o.id, o.number)
  returning id into v_picking;

  for l in
    select sol.*, pt.type as product_type, pt.route_manufacture, pt.route_mto
    from sales_order_lines sol
    join product_variants pv on pv.id = sol.variant_id
    join product_templates pt on pt.id = pv.template_id
    where sol.order_id = p_order and sol.display_type is null and sol.qty > 0
  loop
    if l.product_type = 'goods' then
      insert into stock_moves (
        picking_id, variant_id, uom_id, qty, src_location_id, dest_location_id, state)
      values (
        v_picking, l.variant_id, l.uom_id, l.qty,
        v_op.default_src_id, v_op.default_dest_id, 'draft');
      v_count := v_count + 1;
    end if;

    -- Route "Fertigen auf Bestellung": je Position ein Fertigungsauftrag.
    -- MTO beschafft auftragsbezogen, auch wenn Bestand vorhanden ist.
    if l.route_manufacture and l.route_mto and resolve_bom(l.variant_id) is not null then
      v_mo := create_manufacturing_order(l.variant_id, l.qty, p_order, null, p_actor);
      perform mo_confirm(v_mo, p_actor);
      v_mo_count := v_mo_count + 1;
    end if;
  end loop;

  if v_count = 0 then
    delete from stock_pickings where id = v_picking;
    v_picking := null;
  else
    perform picking_confirm(v_picking);
  end if;

  update sales_orders
    set state = 'sale', confirmed_at = now(),
        locked = coalesce((select (value ->> 'lock_confirmed')::boolean from settings where key = 'sales'), false)
  where id = p_order;

  perform sales_order_recompute_status(p_order);
  perform log_event('sales_order', p_order, 'state',
    format('Auftrag bestätigt (%s Lieferposition(en), %s Fertigungsauftrag/-aufträge)',
           v_count, v_mo_count), p_actor);
  return v_picking;
end $$;

-- Beim Stornieren eines Auftrags bleiben Fertigungsaufträge bestehen
-- (Odoo-Verhalten) - sie bekommen nur einen Warnhinweis.
create or replace function cancel_sales_order(p_order uuid, p_actor text default 'system')
returns void
language plpgsql as $$
declare
  o sales_orders%rowtype;
  p record;
  v_open int;
begin
  select * into o from sales_orders where id = p_order for update;
  if o.id is null then raise exception 'Verkaufsauftrag nicht gefunden'; end if;
  if o.state = 'cancel' then return; end if;

  for p in
    select id from stock_pickings
    where origin_model = 'sales_order' and origin_id = p_order and state not in ('done', 'cancel')
  loop
    perform picking_cancel(p.id);
  end loop;

  select count(*) into v_open from manufacturing_orders
  where sales_order_id = p_order and state not in ('done', 'cancel');

  if v_open > 0 then
    perform log_event('sales_order', p_order, 'note',
      format('Achtung: %s offene(r) Fertigungsauftrag/-aufträge bleiben bestehen und müssen manuell geprüft werden.',
             v_open), p_actor);
  end if;

  update sales_orders set state = 'cancel', locked = false where id = p_order;
  perform log_event('sales_order', p_order, 'state', 'Auftrag storniert', p_actor);
end $$;
