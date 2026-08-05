-- ===========================================================================
-- Einkauf: Bestellungen, Wareneingang, Lieferantenrechnungen
--
-- Odoo-Semantik: "Gesperrt" ist im Einkauf der Status `done` (anders als im
-- Verkauf, wo es ein eigenes Flag ist).
-- ===========================================================================

create type purchase_state as enum ('draft', 'sent', 'purchase', 'done', 'cancel');
create type billing_status as enum ('nothing', 'waiting', 'fully_billed');

create table purchase_orders (
  id               uuid primary key default gen_random_uuid(),
  number           text unique not null,
  state            purchase_state not null default 'draft',
  vendor_id        uuid not null references partners on delete restrict,
  vendor_reference text,
  order_deadline   timestamptz,
  expected_arrival timestamptz,
  confirmed_at     timestamptz,
  billing_status   billing_status not null default 'nothing',
  currency         text not null default 'EUR',
  note             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz
);
select attach_touch_trigger('purchase_orders');
create index purchase_orders_state_idx on purchase_orders (state);
create index purchase_orders_vendor_idx on purchase_orders (vendor_id);

create table purchase_order_lines (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references purchase_orders on delete cascade,
  sequence     int not null default 10,
  variant_id   uuid not null references product_variants on delete restrict,
  name         text not null,
  qty          numeric(16,4) not null check (qty > 0),
  uom_id       uuid not null references uoms on delete restrict,   -- Einkaufseinheit
  price_unit   numeric(16,2) not null default 0,
  tax_rate     numeric(5,2) not null default 19,
  qty_received numeric(16,4) not null default 0,
  qty_billed   numeric(16,4) not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz
);
select attach_touch_trigger('purchase_order_lines');
create index purchase_order_lines_order_idx on purchase_order_lines (order_id, sequence);

create or replace function purchase_order_total(p_order uuid)
returns table (net numeric, tax numeric, gross numeric)
language sql stable as $$
  select coalesce(sum(round(l.qty * l.price_unit, 2)), 0),
         coalesce(sum(round(l.qty * l.price_unit * l.tax_rate / 100, 2)), 0),
         coalesce(sum(round(l.qty * l.price_unit, 2) + round(l.qty * l.price_unit * l.tax_rate / 100, 2)), 0)
  from purchase_order_lines l where l.order_id = p_order;
$$;


-- --- Statusübergänge -------------------------------------------------------
create or replace function purchase_order_guard_editable(p_order uuid) returns void
language plpgsql as $$
declare o purchase_orders%rowtype;
begin
  select * into o from purchase_orders where id = p_order;
  if o.id is null then raise exception 'Bestellung nicht gefunden'; end if;
  if o.state = 'done' then
    raise exception 'Bestellung % ist gesperrt. Zum Ändern bitte entsperren.', o.number;
  end if;
  if o.state = 'cancel' then raise exception 'Bestellung % ist storniert', o.number; end if;
end $$;

/*
 * Bestätigt eine Bestellung: Status -> purchase, erwartete Ankunft aus den
 * Lieferzeiten, und legt automatisch den Wareneingang an.
 */
create or replace function confirm_purchase_order(p_order uuid, p_actor text default 'system')
returns uuid
language plpgsql as $$
declare
  o purchase_orders%rowtype;
  v_op operation_types%rowtype;
  v_picking uuid;
  l record;
  v_lead int := 0;
  v_stock_uom uuid;
  v_qty_stock numeric;
  v_auto_lock boolean;
begin
  select * into o from purchase_orders where id = p_order for update;
  if o.id is null then raise exception 'Bestellung nicht gefunden'; end if;
  if o.state in ('purchase', 'done') then return null; end if;
  if o.state = 'cancel' then raise exception 'Stornierte Bestellungen können nicht bestätigt werden'; end if;

  select * into v_op from operation_types where kind = 'receipt' and active limit 1;

  insert into stock_pickings (
    number, operation_type_id, state, partner_id, scheduled_date,
    origin_model, origin_id, origin_label)
  values (
    next_sequence(v_op.sequence_code), v_op.id, 'draft', o.vendor_id, now(),
    'purchase_order', o.id, o.number)
  returning id into v_picking;

  for l in
    select pol.*, pt.uom_id as stock_uom
    from purchase_order_lines pol
    join product_variants pv on pv.id = pol.variant_id
    join product_templates pt on pt.id = pv.template_id
    where pol.order_id = p_order
  loop
    -- Bestellt wird in der Einkaufseinheit, gebucht in der Lagereinheit.
    v_stock_uom := l.stock_uom;
    v_qty_stock := uom_convert(l.qty, l.uom_id, v_stock_uom);

    insert into stock_moves (
      picking_id, variant_id, uom_id, qty, src_location_id, dest_location_id, state)
    values (
      v_picking, l.variant_id, v_stock_uom, v_qty_stock,
      v_op.default_src_id, v_op.default_dest_id, 'draft');

    select greatest(v_lead, coalesce(max(vp.lead_time_days), 0)) into v_lead
    from vendor_prices vp
    join product_variants pv on pv.template_id = vp.template_id
    where pv.id = l.variant_id and vp.vendor_id = o.vendor_id;
  end loop;

  perform picking_confirm(v_picking);

  select coalesce((value ->> 'lock_confirmed')::boolean, false) into v_auto_lock
  from settings where key = 'purchase';

  update purchase_orders set
    state = case when coalesce(v_auto_lock, false) then 'done'::purchase_state
                 else 'purchase'::purchase_state end,
    confirmed_at = now(),
    expected_arrival = coalesce(expected_arrival, now() + make_interval(days => v_lead)),
    billing_status = 'nothing'
  where id = p_order;

  perform purchase_order_recompute_billing(p_order);
  perform log_event('purchase_order', p_order, 'state', 'Bestellung bestätigt', p_actor);
  return v_picking;
end $$;

create or replace function purchase_order_lock(p_order uuid, p_actor text default 'system')
returns void language plpgsql as $$
begin
  update purchase_orders set state = 'done' where id = p_order and state = 'purchase';
  perform log_event('purchase_order', p_order, 'state', 'Bestellung gesperrt', p_actor);
end $$;

create or replace function purchase_order_unlock(p_order uuid, p_actor text default 'system')
returns void language plpgsql as $$
begin
  update purchase_orders set state = 'purchase' where id = p_order and state = 'done';
  perform log_event('purchase_order', p_order, 'state', 'Bestellung entsperrt', p_actor);
end $$;

create or replace function cancel_purchase_order(p_order uuid, p_actor text default 'system')
returns void
language plpgsql as $$
declare
  v_received int;
  p record;
begin
  select count(*) into v_received
  from stock_pickings
  where origin_model = 'purchase_order' and origin_id = p_order and state = 'done';

  if v_received > 0 then
    raise exception 'Es wurde bereits Ware zu dieser Bestellung eingebucht. Bitte stattdessen eine Retoure anlegen.';
  end if;

  for p in
    select id from stock_pickings
    where origin_model = 'purchase_order' and origin_id = p_order and state not in ('done', 'cancel')
  loop
    perform picking_cancel(p.id);
  end loop;

  update purchase_orders set state = 'cancel' where id = p_order;
  perform log_event('purchase_order', p_order, 'state', 'Bestellung storniert', p_actor);
end $$;

-- Erhaltene Mengen aus validierten Wareneingängen zurückschreiben.
create or replace function purchase_order_sync_received(p_order uuid) returns void
language plpgsql as $$
begin
  update purchase_order_lines l set qty_received = coalesce((
    select sum(uom_convert(
      case when dst.type = 'internal' then m.qty_done
           when src.type = 'internal' then -m.qty_done   -- Rücksendung an den Lieferanten
           else 0 end, m.uom_id, l.uom_id))
    from stock_moves m
    join stock_pickings p on p.id = m.picking_id
    join stock_locations src on src.id = m.src_location_id
    join stock_locations dst on dst.id = m.dest_location_id
    where p.origin_model = 'purchase_order' and p.origin_id = p_order
      and m.state = 'done' and m.variant_id = l.variant_id), 0)
  where l.order_id = p_order;

  perform purchase_order_recompute_billing(p_order);
end $$;

/*
 * Abrechnungsstatus laut Odoo-Tabelle:
 *   nothing      - bestätigt, aber (bei Politik "erhalten") noch nichts erhalten
 *   waiting      - abrechenbare Mengen vorhanden, noch nicht (vollständig) berechnet
 *   fully_billed - alles berechnet
 */
create or replace function purchase_order_recompute_billing(p_order uuid) returns void
language plpgsql as $$
declare
  v_state purchase_state;
  v_billable numeric := 0;
  v_billed numeric := 0;
begin
  select state into v_state from purchase_orders where id = p_order;
  if v_state not in ('purchase', 'done') then
    update purchase_orders set billing_status = 'nothing' where id = p_order;
    return;
  end if;

  select
    coalesce(sum(case when pt.bill_policy = 'ordered' then l.qty else l.qty_received end), 0),
    coalesce(sum(l.qty_billed), 0)
    into v_billable, v_billed
  from purchase_order_lines l
  join product_variants pv on pv.id = l.variant_id
  join product_templates pt on pt.id = pv.template_id
  where l.order_id = p_order;

  update purchase_orders set billing_status = case
      when v_billable <= 0 then 'nothing'::billing_status
      when v_billed >= v_billable then 'fully_billed'::billing_status
      else 'waiting'::billing_status
    end
  where id = p_order;
end $$;

create or replace function trg_picking_sync_purchase() returns trigger
language plpgsql as $$
begin
  if new.state = 'done' and coalesce(old.state, 'draft') <> 'done'
     and new.origin_model = 'purchase_order' and new.origin_id is not null then
    perform purchase_order_sync_received(new.origin_id);
  end if;
  return null;
end $$;

create trigger picking_sync_purchase
  after update of state on stock_pickings
  for each row execute function trg_picking_sync_purchase();


-- --- Lieferantenrechnungen -------------------------------------------------
create type bill_state as enum ('draft', 'posted', 'paid', 'cancel');

create table vendor_bills (
  id                    uuid primary key default gen_random_uuid(),
  number                text unique not null,
  purchase_order_id     uuid references purchase_orders on delete set null,
  vendor_id             uuid not null references partners on delete restrict,
  state                 bill_state not null default 'draft',
  bill_date             date,
  due_date              date,
  vendor_bill_reference text,
  is_credit_note        boolean not null default false,
  reversed_bill_id      uuid references vendor_bills on delete set null,
  currency              text not null default 'EUR',
  paid_at               timestamptz,
  note                  text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz
);
select attach_touch_trigger('vendor_bills');
create index vendor_bills_order_idx on vendor_bills (purchase_order_id);

create table vendor_bill_lines (
  id         uuid primary key default gen_random_uuid(),
  bill_id    uuid not null references vendor_bills on delete cascade,
  po_line_id uuid references purchase_order_lines on delete set null,
  name       text not null,
  qty        numeric(16,4) not null,
  price_unit numeric(16,2) not null,
  tax_rate   numeric(5,2) not null default 19,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
select attach_touch_trigger('vendor_bill_lines');

create or replace function vendor_bill_total(p_bill uuid)
returns table (net numeric, tax numeric, gross numeric)
language sql stable as $$
  select coalesce(sum(round(l.qty * l.price_unit, 2)), 0),
         coalesce(sum(round(l.qty * l.price_unit * l.tax_rate / 100, 2)), 0),
         coalesce(sum(round(l.qty * l.price_unit, 2) + round(l.qty * l.price_unit * l.tax_rate / 100, 2)), 0)
  from vendor_bill_lines l where l.bill_id = p_bill;
$$;

/*
 * Erzeugt eine Entwurfsrechnung aus der Bestellung. Die abrechenbare Menge
 * hängt an der Politik des Produkts:
 *   ordered  - bestellte Menge
 *   received - erhaltene Menge (Rechnung vor Wareneingang wird abgelehnt)
 * Bereits abgerechnete Mengen werden abgezogen.
 */
create or replace function create_vendor_bill(p_order uuid, p_actor text default 'system')
returns uuid
language plpgsql as $$
declare
  o purchase_orders%rowtype;
  v_bill uuid;
  l record;
  v_billable numeric;
  v_count int := 0;
begin
  select * into o from purchase_orders where id = p_order;
  if o.id is null then raise exception 'Bestellung nicht gefunden'; end if;
  if o.state not in ('purchase', 'done') then
    raise exception 'Nur bestätigte Bestellungen können abgerechnet werden';
  end if;

  insert into vendor_bills (number, purchase_order_id, vendor_id, currency)
  values (next_sequence('bill'), o.id, o.vendor_id, o.currency)
  returning id into v_bill;

  for l in
    select pol.*, pt.bill_policy
    from purchase_order_lines pol
    join product_variants pv on pv.id = pol.variant_id
    join product_templates pt on pt.id = pv.template_id
    where pol.order_id = p_order
  loop
    v_billable := (case when l.bill_policy = 'ordered' then l.qty else l.qty_received end) - l.qty_billed;
    if v_billable > 0 then
      insert into vendor_bill_lines (bill_id, po_line_id, name, qty, price_unit, tax_rate)
      values (v_bill, l.id, l.name, v_billable, l.price_unit, l.tax_rate);
      v_count := v_count + 1;
    end if;
  end loop;

  if v_count = 0 then
    delete from vendor_bills where id = v_bill;
    raise exception 'Nichts abzurechnen. Bei der Politik "nach erhaltener Menge" muss zuerst der Wareneingang gebucht werden.';
  end if;

  perform log_event('purchase_order', p_order, 'note',
    'Entwurfsrechnung erstellt: ' || (select number from vendor_bills where id = v_bill), p_actor);
  return v_bill;
end $$;

create or replace function post_vendor_bill(p_bill uuid, p_actor text default 'system')
returns void
language plpgsql as $$
declare
  b vendor_bills%rowtype;
  l record;
begin
  select * into b from vendor_bills where id = p_bill for update;
  if b.id is null then raise exception 'Rechnung nicht gefunden'; end if;
  if b.state <> 'draft' then raise exception 'Nur Entwurfsrechnungen können gebucht werden'; end if;
  if b.bill_date is null then raise exception 'Bitte zuerst das Rechnungsdatum erfassen'; end if;

  for l in select * from vendor_bill_lines where bill_id = p_bill and po_line_id is not null loop
    update purchase_order_lines
      set qty_billed = qty_billed + (case when b.is_credit_note then -l.qty else l.qty end)
    where id = l.po_line_id;
  end loop;

  update vendor_bills set state = 'posted' where id = p_bill;

  if b.purchase_order_id is not null then
    perform purchase_order_recompute_billing(b.purchase_order_id);
  end if;
  perform log_event('vendor_bill', p_bill, 'state', 'Rechnung gebucht', p_actor);
end $$;

create or replace function pay_vendor_bill(p_bill uuid, p_actor text default 'system')
returns void language plpgsql as $$
begin
  update vendor_bills set state = 'paid', paid_at = now()
  where id = p_bill and state = 'posted';
  perform log_event('vendor_bill', p_bill, 'state', 'Zahlung erfasst', p_actor);
end $$;

/*
 * Storno: Entwürfe werden verworfen, gebuchte Rechnungen über eine Gutschrift
 * ausgeglichen (die die abgerechneten Mengen wieder reduziert).
 */
create or replace function cancel_vendor_bill(p_bill uuid, p_actor text default 'system')
returns uuid
language plpgsql as $$
declare
  b vendor_bills%rowtype;
  v_credit uuid;
begin
  select * into b from vendor_bills where id = p_bill for update;
  if b.id is null then raise exception 'Rechnung nicht gefunden'; end if;

  if b.state = 'draft' then
    update vendor_bills set state = 'cancel' where id = p_bill;
    perform log_event('vendor_bill', p_bill, 'state', 'Entwurf verworfen', p_actor);
    return null;
  end if;

  if b.state = 'cancel' then return null; end if;

  insert into vendor_bills (
    number, purchase_order_id, vendor_id, state, bill_date,
    vendor_bill_reference, is_credit_note, reversed_bill_id, currency)
  values (
    next_sequence('bill'), b.purchase_order_id, b.vendor_id, 'draft', current_date,
    b.vendor_bill_reference, true, b.id, b.currency)
  returning id into v_credit;

  insert into vendor_bill_lines (bill_id, po_line_id, name, qty, price_unit, tax_rate)
  select v_credit, po_line_id, name, qty, price_unit, tax_rate
  from vendor_bill_lines where bill_id = p_bill;

  perform log_event('vendor_bill', p_bill, 'state',
    'Gutschrift angelegt: ' || (select number from vendor_bills where id = v_credit), p_actor);
  return v_credit;
end $$;

insert into settings (key, value) values ('purchase', '{"lock_confirmed": false}'::jsonb);
