-- ===========================================================================
-- Fertigung II: Phantom-Baugruppen, Arbeitsplätze/Arbeitsgänge, Backflush
-- ===========================================================================
-- Drei Bausteine, die zusammengehören:
--
--   1. Phantom-Baugruppen — eine Zwischenbaugruppe (Odoo: bom_type='phantom',
--      bei uns 'kit') existiert nur auf dem Papier. Im Fertigungsauftrag
--      werden nicht sie, sondern ihre Bestandteile verbraucht. Die Auflösung
--      ist rekursiv, damit auch Baugruppen in Baugruppen funktionieren.
--
--   2. Arbeitsplätze und Arbeitsgänge — jeder Arbeitsgang hängt an einem
--      Arbeitsplatz mit Stundensatz. Die erfasste Zeit wird zu Lohnkosten und
--      fließt in den Wert des Fertigprodukts.
--
--   3. Backflush — billige Massenteile (Schrauben, Schaumstoff, Kleber)
--      werden bei der Fertigmeldung automatisch im Sollverhältnis verbraucht.
--      Teile mit Verbrauchsart "manuell" müssen dagegen erfasst werden;
--      ohne Eingabe verweigert die Fertigmeldung den Dienst.
--
-- Ergebnis: das Fertigprodukt wird nicht mehr mit dem gepflegten
-- Standardpreis bewertet, sondern mit dem, was es tatsächlich gekostet hat
-- (Materialwert der verbrauchten Komponenten + Lohnkosten der Arbeitsgänge).

-- ---------------------------------------------------------------------------
-- 1. Verbrauchsart je Stücklistenposition
-- ---------------------------------------------------------------------------
create type component_issue_method as enum ('backflush', 'manual');

comment on type component_issue_method is
  'backflush = wird bei der Fertigmeldung automatisch im Sollverhältnis '
  'verbraucht; manual = muss bei der Fertigmeldung erfasst werden.';

alter table bom_lines
  add column issue_method component_issue_method not null default 'backflush';

-- Das alte Kennzeichen manual_consumption trägt dieselbe Aussage — übernehmen.
update bom_lines set issue_method = 'manual' where manual_consumption;

comment on column bom_lines.manual_consumption is
  'Veraltet — ersetzt durch issue_method (0021).';

alter table stock_moves
  add column issue_method component_issue_method,
  add column phantom_path text;

comment on column stock_moves.issue_method is
  'Nur bei Komponentenbewegungen eines Fertigungsauftrags gesetzt.';
comment on column stock_moves.phantom_path is
  'Herkunft aus aufgelösten Phantom-Baugruppen, z. B. "Gehäuse-Set / Schraubensatz".';


-- ---------------------------------------------------------------------------
-- 2. Mehrstufige Stücklistenauflösung
-- ---------------------------------------------------------------------------
/*
 * Löst eine Stückliste für eine konkrete Variante und Menge auf. Positionen,
 * deren Komponente selbst eine Kit-/Phantom-Stückliste hat, werden durch
 * deren Bestandteile ersetzt — rekursiv, mit Variantenfilter auf jeder Stufe.
 *
 * p_qty ist die Menge des Endprodukts; die Referenzmenge der Stückliste
 * (boms.qty) wird intern herausgerechnet.
 */
create or replace function bom_explode(
  p_bom uuid,
  p_variant uuid,
  p_qty numeric default 1,
  p_depth int default 0
) returns table (
  component_variant_id uuid,
  qty numeric,
  uom_id uuid,
  issue_method component_issue_method,
  depth int,
  phantom_path text
)
language plpgsql stable as $$
declare
  b boms%rowtype;
  c record;
  s record;
  v_factor numeric;
  v_kit uuid;
begin
  select * into b from boms where id = p_bom;
  if b.id is null then return; end if;

  if p_depth > 8 then
    raise exception 'Stücklistenauflösung von % ist zu tief verschachtelt — '
                    'vermutlich verweist eine Baugruppe auf sich selbst',
      variant_display_name(p_variant);
  end if;

  v_factor := p_qty / b.qty;

  for c in
    select cv.component_variant_id as vid,
           cv.qty as line_qty,
           cv.uom_id as line_uom,
           bl.issue_method as line_issue
    from bom_components_for_variant(p_bom, p_variant) cv
    join bom_lines bl on bl.id = cv.bom_line_id
  loop
    v_kit := resolve_kit(c.vid);
    if v_kit is not null then
      -- Phantom: nicht die Baugruppe verbrauchen, sondern ihre Bestandteile.
      for s in select * from bom_explode(v_kit, c.vid, c.line_qty * v_factor, p_depth + 1) loop
        component_variant_id := s.component_variant_id;
        qty                  := s.qty;
        uom_id               := s.uom_id;
        issue_method         := s.issue_method;
        depth                := s.depth;
        phantom_path         := variant_display_name(c.vid)
                                || coalesce(' / ' || s.phantom_path, '');
        return next;
      end loop;
    else
      component_variant_id := c.vid;
      qty                  := round(c.line_qty * v_factor, 6);
      uom_id               := c.line_uom;
      issue_method         := c.line_issue;
      depth                := p_depth;
      phantom_path         := null;
      return next;
    end if;
  end loop;
end $$;

comment on function bom_explode is
  'Mehrstufige Stücklistenauflösung: Kit-/Phantom-Baugruppen werden durch '
  'ihre Bestandteile ersetzt, Variantenfilter gelten auf jeder Stufe.';


-- ---------------------------------------------------------------------------
-- 3. Arbeitsplätze (mrp.workcenter)
-- ---------------------------------------------------------------------------
create table work_centers (
  id              uuid primary key default gen_random_uuid(),
  code            text unique not null,
  name            text not null,
  cost_per_hour   numeric(16,4) not null default 0 check (cost_per_hour >= 0),
  capacity        numeric(16,4) not null default 1 check (capacity > 0),
  -- 100 = wie geplant, 80 = braucht 25 % länger, 120 = ist schneller
  time_efficiency numeric(6,2) not null default 100 check (time_efficiency > 0),
  active          boolean not null default true,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz
);
select attach_touch_trigger('work_centers');

comment on table work_centers is
  'Arbeitsplatz mit Stundensatz — die Grundlage der Lohnkosten je Arbeitsgang.';

/*
 * Arbeitsgänge der Stückliste (mrp.routing.workcenter). duration_minutes gilt
 * je Referenzmenge der Stückliste und skaliert mit der Auftragsmenge;
 * setup_minutes fällt einmal je Auftrag an (Rüstzeit).
 */
create table bom_operations (
  id               uuid primary key default gen_random_uuid(),
  bom_id           uuid not null references boms on delete cascade,
  sequence         int not null default 10,
  name             text not null,
  work_center_id   uuid not null references work_centers on delete restrict,
  duration_minutes numeric(10,2) not null default 0 check (duration_minutes >= 0),
  setup_minutes    numeric(10,2) not null default 0 check (setup_minutes >= 0),
  note             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz
);
select attach_touch_trigger('bom_operations');
create index bom_operations_bom_idx on bom_operations (bom_id, sequence);

-- Arbeitsgänge des konkreten Auftrags (mrp.workorder)
create type mo_operation_state as enum ('pending', 'progress', 'done', 'cancel');

create table mo_operations (
  id                uuid primary key default gen_random_uuid(),
  mo_id             uuid not null references manufacturing_orders on delete cascade,
  bom_operation_id  uuid references bom_operations on delete set null,
  sequence          int not null default 10,
  name              text not null,
  work_center_id    uuid not null references work_centers on delete restrict,
  -- Schnappschuss: ein späterer Tarifwechsel verändert alte Aufträge nicht
  cost_per_hour     numeric(16,4) not null default 0,
  duration_expected numeric(10,2) not null default 0,
  duration_real     numeric(10,2) not null default 0 check (duration_real >= 0),
  state             mo_operation_state not null default 'pending',
  date_start        timestamptz,
  date_done         timestamptz,
  user_id           uuid references users on delete set null,
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz
);
select attach_touch_trigger('mo_operations');
create index mo_operations_mo_idx on mo_operations (mo_id, sequence);
create index mo_operations_state_idx on mo_operations (state) where state <> 'done';

-- Kosten am Fertigungsauftrag
alter table manufacturing_orders
  add column material_cost numeric(16,4) not null default 0,
  add column labor_cost    numeric(16,4) not null default 0,
  add column unit_cost     numeric(16,6);

comment on column manufacturing_orders.unit_cost is
  'Tatsächliche Herstellkosten je Stück = (Material + Lohn) / gefertigte Menge.';


-- --- Zeiterfassung am Arbeitsgang ------------------------------------------
create or replace function mo_operation_start(p_op uuid, p_actor text default 'system')
returns void
language plpgsql as $$
declare op mo_operations%rowtype;
begin
  select * into op from mo_operations where id = p_op for update;
  if op.id is null then raise exception 'Arbeitsgang nicht gefunden'; end if;
  if op.state = 'done' then raise exception 'Arbeitsgang % ist bereits erledigt', op.name; end if;

  update mo_operations
    set state = 'progress', date_start = coalesce(date_start, now())
  where id = p_op;

  perform log_event('manufacturing_order', op.mo_id, 'state',
    format('Arbeitsgang "%s" gestartet', op.name), p_actor);
end $$;

/*
 * Beendet einen Arbeitsgang. Ohne Minutenangabe wird die Zeit seit dem Start
 * gerechnet; wurde nie gestartet, gilt die Vorgabezeit.
 */
create or replace function mo_operation_finish(
  p_op uuid,
  p_minutes numeric default null,
  p_actor text default 'system'
) returns numeric
language plpgsql as $$
declare
  op mo_operations%rowtype;
  v_minutes numeric;
begin
  select * into op from mo_operations where id = p_op for update;
  if op.id is null then raise exception 'Arbeitsgang nicht gefunden'; end if;
  if op.state = 'done' then raise exception 'Arbeitsgang % ist bereits erledigt', op.name; end if;
  if p_minutes is not null and p_minutes < 0 then
    raise exception 'Die Dauer darf nicht negativ sein';
  end if;

  v_minutes := coalesce(
    p_minutes,
    case when op.date_start is not null
         then round(extract(epoch from (now() - op.date_start)) / 60.0, 2) end,
    op.duration_expected);

  update mo_operations
    set duration_real = op.duration_real + v_minutes,
        state = 'done',
        date_start = coalesce(date_start, now() - make_interval(secs => v_minutes * 60)),
        date_done = now()
  where id = p_op;

  perform log_event('manufacturing_order', op.mo_id, 'state',
    format('Arbeitsgang "%s" erledigt (%s Min., %s)',
           op.name, v_minutes, money_text(round(v_minutes / 60.0 * op.cost_per_hour, 2))),
    p_actor);
  return v_minutes;
end $$;

/*
 * Schließt bei der Fertigmeldung alle noch offenen Arbeitsgänge ab. Wurde
 * keine Zeit erfasst, gilt die Vorgabezeit anteilig zur gemeldeten Menge —
 * so trägt auch eine Teilfertigung ihre Lohnkosten.
 */
create or replace function mo_operations_finalize(
  p_mo uuid,
  p_factor numeric default 1,
  p_actor text default 'system'
) returns void
language plpgsql as $$
begin
  update mo_operations
    set duration_real = case
          when duration_real > 0 then duration_real
          else round(duration_expected * p_factor, 2) end,
        state = 'done',
        date_done = now()
  where mo_id = p_mo and state <> 'done' and state <> 'cancel';
end $$;

/** Lohnkosten eines Auftrags aus den erledigten Arbeitsgängen. */
create or replace function mo_labor_cost(p_mo uuid) returns numeric
language sql stable as $$
  select coalesce(sum(round(duration_real / 60.0 * cost_per_hour, 4)), 0)
  from mo_operations where mo_id = p_mo and state = 'done';
$$;


-- ---------------------------------------------------------------------------
-- 4. Fertigungsauftrag anlegen: Phantom-Auflösung + Arbeitsgänge
-- ---------------------------------------------------------------------------
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
  o record;
  v_factor numeric;
  v_phantoms int := 0;
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

  -- Komponentenbedarf einfrieren — Phantom-Baugruppen werden dabei aufgelöst.
  for c in select * from bom_explode(v_bom.id, p_variant, p_qty) loop
    insert into stock_moves (
      production_id, variant_id, uom_id, qty, src_location_id, dest_location_id,
      state, reference, issue_method, phantom_path)
    values (
      v_mo, c.component_variant_id, c.uom_id, c.qty,
      v_stock, v_production, 'draft', 'Komponentenverbrauch',
      c.issue_method, c.phantom_path);
    if c.phantom_path is not null then v_phantoms := v_phantoms + 1; end if;
  end loop;

  -- Arbeitsgänge aus der Stückliste übernehmen (Stundensatz einfrieren).
  v_factor := p_qty / v_bom.qty;
  for o in select * from bom_operations where bom_id = v_bom.id order by sequence, id loop
    insert into mo_operations (
      mo_id, bom_operation_id, sequence, name, work_center_id,
      cost_per_hour, duration_expected)
    select v_mo, o.id, o.sequence, o.name, o.work_center_id, w.cost_per_hour,
           round((o.setup_minutes + o.duration_minutes * v_factor)
                 / (w.time_efficiency / 100.0), 2)
    from work_centers w where w.id = o.work_center_id;
  end loop;

  perform log_event('manufacturing_order', v_mo, 'state',
    'Fertigungsauftrag angelegt für ' || variant_display_name(p_variant)
    || case when v_phantoms > 0
            then format(' (%s Position(en) aus Baugruppen aufgelöst)', v_phantoms)
            else '' end, p_actor);
  return v_mo;
end $$;


-- ---------------------------------------------------------------------------
-- 5. Fertigmeldung: Backflush, manuelle Positionen, Kostenrollierung
-- ---------------------------------------------------------------------------
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
  v_material numeric;
  v_labor numeric;
  v_unit numeric;
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

    -- Manuelle Positionen brauchen eine Eingabe; Backflush-Positionen (billige
    -- Massenteile) werden im Sollverhältnis automatisch verbraucht.
    if m.issue_method = 'manual' and not (p_consumed ? m.id::text) then
      raise exception 'Für % muss der Verbrauch erfasst werden (Verbrauchsart „manuell")',
        variant_display_name(m.variant_id);
    end if;

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

  -- Arbeitsgänge abschließen und Kosten zusammenziehen.
  perform mo_operations_finalize(p_mo, v_factor, p_actor);
  v_labor := mo_labor_cost(p_mo);

  select coalesce(-sum(l.value), 0) into v_material
  from stock_valuation_layers l
  join stock_moves sm on sm.id = l.move_id
  where sm.production_id = p_mo and sm.reference = 'Komponentenverbrauch';

  -- Herstellkosten je Stück; ohne Material und Lohn bleibt die Bewertung beim
  -- hinterlegten Einstandspreis (NULL = valuation_apply entscheidet).
  v_unit := case when v_material + v_labor > 0
                 then round((v_material + v_labor) / v_qty, 6) end;

  -- Fertigprodukt zubuchen
  insert into stock_moves (
    production_id, variant_id, uom_id, qty, src_location_id, dest_location_id,
    state, reference, unit_cost)
  values (p_mo, mo.variant_id, mo.uom_id, v_qty, v_production, v_stock,
          'confirmed', 'Fertigmeldung', v_unit)
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
        lot_producing_id = coalesce(v_lot, lot_producing_id),
        material_cost = v_material,
        labor_cost = v_labor,
        unit_cost = v_unit
  where id = p_mo;

  if v_material + v_labor > 0 then
    perform log_event('manufacturing_order', p_mo, 'note',
      format('Herstellkosten: Material %s + Lohn %s = %s je Stück',
             money_text(round(v_material, 2)), money_text(round(v_labor, 2)),
             money_text(round(v_unit, 2))), p_actor);
  end if;

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

-- Beim Stornieren fallen auch die Arbeitsgänge weg.
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
  update mo_operations set state = 'cancel' where mo_id = p_mo and state <> 'done';
  update manufacturing_orders set state = 'cancel' where id = p_mo;
  perform log_event('manufacturing_order', p_mo, 'state', 'Storniert', p_actor);
end $$;


-- ---------------------------------------------------------------------------
-- 6. Demontage mit Phantom-Auflösung
-- ---------------------------------------------------------------------------
-- Eine Phantom-Baugruppe wurde nie eingelagert — bei der Demontage dürfen
-- deshalb nur ihre Bestandteile zurück ins Lager.
create or replace function unbuild_apply(
  p_unbuild uuid, p_force boolean default false, p_actor text default 'system')
returns void
language plpgsql as $$
declare
  u unbuild_orders%rowtype;
  b boms%rowtype;
  c record;
  v_production uuid;
  v_move uuid;
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

  -- Komponenten zurückbuchen (Baugruppen aufgelöst)
  for c in select * from bom_explode(b.id, u.variant_id, u.qty) loop
    insert into stock_moves (unbuild_id, variant_id, uom_id, qty,
                             src_location_id, dest_location_id, state, reference,
                             phantom_path)
    values (u.id, c.component_variant_id, c.uom_id, c.qty,
            v_production, u.dest_location_id, 'confirmed', 'Demontage', c.phantom_path)
    returning id into v_move;
    perform move_done(v_move, c.qty);
  end loop;

  update unbuild_orders set state = 'done' where id = p_unbuild;
  perform log_event('unbuild_order', p_unbuild, 'state', 'Demontiert', p_actor);
end $$;


-- ---------------------------------------------------------------------------
-- 7. Eröffnungsbewertung: Stücklistenwert mehrstufig ermitteln
-- ---------------------------------------------------------------------------
create or replace function valuation_initialize(
  p_variant uuid default null,
  p_actor text default 'system'
) returns table (variant_id uuid, product text, quantity numeric, unit_cost numeric, value numeric)
language plpgsql as $$
declare
  v record;
  v_diff numeric;
  v_cost numeric;
begin
  for v in
    select pv.id,
           coalesce(pv.display_name, pt.name) as product,
           on_hand_qty(pv.id) as on_hand,
           pv.valued_qty,
           case
             when pt.standard_cost > 0 then pt.standard_cost
             else coalesce((
               select sum(c.qty * cpt.standard_cost)
               from bom_explode(resolve_bom(pv.id), pv.id, 1) c
               join product_variants cpv on cpv.id = c.component_variant_id
               join product_templates cpt on cpt.id = cpv.template_id), 0)
           end as cost
    from product_variants pv
    join product_templates pt on pt.id = pv.template_id
    where pv.active and pt.type = 'goods'
      and (p_variant is null or pv.id = p_variant)
  loop
    v_diff := v.on_hand - v.valued_qty;
    if abs(v_diff) < 0.0001 then continue; end if;

    v_cost := case when v_diff > 0 then v.cost else null end;

    perform valuation_apply(
      v.id, null, 'revaluation', v_diff, v_cost, null,
      'Eröffnungsbewertung');

    variant_id := v.id;
    product := v.product;
    quantity := v_diff;
    unit_cost := coalesce(v_cost, 0);
    value := round(v_diff * coalesce(v_cost, 0), 4);
    return next;
  end loop;

  perform log_event('inventory', gen_random_uuid(), 'state',
    'Eröffnungsbewertung ausgeführt', p_actor);
end $$;


-- ---------------------------------------------------------------------------
-- 8. Auswertung: was hat die Fertigung gekostet?
-- ---------------------------------------------------------------------------
create or replace view production_cost as
  select mo.id,
         mo.number,
         mo.variant_id,
         variant_display_name(mo.variant_id) as product,
         mo.state,
         mo.date_done,
         mo.qty_produced,
         mo.material_cost,
         mo.labor_cost,
         mo.material_cost + mo.labor_cost as total_cost,
         mo.unit_cost,
         (select coalesce(sum(o.duration_real), 0)
          from mo_operations o where o.mo_id = mo.id and o.state = 'done') as minutes
  from manufacturing_orders mo
  where mo.state = 'done';

comment on view production_cost is
  'Herstellkosten je Fertigungsauftrag: Material aus den Wertschichten der '
  'Komponenten, Lohn aus den erfassten Arbeitsgangzeiten.';


-- ---------------------------------------------------------------------------
-- 9. Auftragsbestätigung: Kits mehrstufig auflösen
-- ---------------------------------------------------------------------------
-- Unverändert gegenüber 0014 bis auf die Kit-Explosion: statt einer Stufe
-- löst bom_explode nun auch Kits innerhalb von Kits auf.
create or replace function confirm_sales_order(p_order uuid, p_actor text default 'system')
returns uuid
language plpgsql as $$
declare
  o sales_orders%rowtype;
  v_op operation_types%rowtype;
  v_picking uuid;
  l record;
  c record;
  v_kit uuid;
  v_count int := 0;
  v_mo uuid;
  v_mo_count int := 0;
  v_scheduled timestamptz;
begin
  select * into o from sales_orders where id = p_order for update;
  if o.id is null then raise exception 'Verkaufsauftrag nicht gefunden'; end if;
  if o.state = 'sale' then return null; end if;
  if o.state = 'cancel' then raise exception 'Stornierte Aufträge können nicht bestätigt werden'; end if;

  -- Steuer-Schnappschuss: Satz aus der Zeilensteuer bzw. dem Produkt-Default.
  -- (Alias "zeile": ein Alias "l" würde mit der Schleifenvariable kollidieren.)
  update sales_order_lines zeile set
    tax_id = coalesce(zeile.tax_id, pt.sale_tax_id),
    tax_rate = coalesce(
      (select amount from taxes where id = coalesce(zeile.tax_id, pt.sale_tax_id)), zeile.tax_rate)
  from product_variants pv
  join product_templates pt on pt.id = pv.template_id
  where zeile.order_id = p_order and zeile.display_type is null and pv.id = zeile.variant_id;

  -- Terminierung: zugesagter Termin, sonst heute + längste Kundenlieferzeit.
  select coalesce(o.commitment_date,
                  now() + make_interval(days => coalesce(max(pt.sale_delay), 0)))
    into v_scheduled
  from sales_order_lines sol
  join product_variants pv on pv.id = sol.variant_id
  join product_templates pt on pt.id = pv.template_id
  where sol.order_id = p_order and sol.display_type is null;

  select * into v_op from operation_types where kind = 'delivery' and active limit 1;

  insert into stock_pickings (
    number, operation_type_id, state, partner_id, scheduled_date,
    origin_model, origin_id, origin_label)
  values (
    next_sequence(v_op.sequence_code), v_op.id, 'draft', o.partner_id,
    coalesce(v_scheduled, now()),
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
      v_kit := resolve_kit(l.variant_id);
      if v_kit is not null then
        -- Kit-Stückliste: die Komponenten werden geliefert, nicht das Set
        -- (mrp: bom_type='phantom'). Variantenfilter gelten wie bei der
        -- Fertigung.
        for c in select * from bom_explode(v_kit, l.variant_id, l.qty) loop
          insert into stock_moves (
            picking_id, variant_id, uom_id, qty, src_location_id, dest_location_id,
            state, reference, phantom_path)
          values (
            v_picking, c.component_variant_id, c.uom_id, round(c.qty, 4),
            v_op.default_src_id, v_op.default_dest_id, 'draft', 'Kit: ' || l.name,
            c.phantom_path);
          v_count := v_count + 1;
        end loop;
      else
        insert into stock_moves (
          picking_id, variant_id, uom_id, qty, src_location_id, dest_location_id, state)
        values (
          v_picking, l.variant_id, l.uom_id, l.qty,
          v_op.default_src_id, v_op.default_dest_id, 'draft');
        v_count := v_count + 1;
      end if;
    end if;

    -- Route "Fertigen auf Bestellung": je Position ein Fertigungsauftrag.
    -- MTO beschafft auftragsbezogen, auch wenn Bestand vorhanden ist.
    if l.route_manufacture and l.route_mto and resolve_bom(l.variant_id) is not null then
      v_mo := create_manufacturing_order(l.variant_id, l.qty, p_order, null, p_actor);
      update manufacturing_orders set origin = o.number where id = v_mo;
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


-- ---------------------------------------------------------------------------
-- 10. Geldbeträge im Verlauf deutsch formatieren
-- ---------------------------------------------------------------------------
-- money_text schrieb bisher "311.52 EUR" — abhängig von lc_numeric und damit
-- weder verlässlich noch deutsch. Jetzt deterministisch: Punkt als
-- Tausender-, Komma als Dezimaltrenner, Eurozeichen.
create or replace function money_text(p_value numeric) returns text
language sql immutable as $$
  select case when coalesce(p_value, 0) < 0 then '-' else '' end
      || regexp_replace(trunc(abs(round(coalesce(p_value, 0), 2)))::text,
                        '(\d)(?=(\d{3})+$)', '\1.', 'g')
      || ','
      || lpad(((abs(round(coalesce(p_value, 0), 2)) * 100)::bigint % 100)::text, 2, '0')
      || ' €';
$$;
