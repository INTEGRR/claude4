-- ===========================================================================
-- Verkauf: Verkaufsaufträge mit Odoo-18-Statuslogik
--
-- Hinweis zur Odoo-18-Semantik: "Gesperrt" ist KEIN eigener Status mehr,
-- sondern das Flag `locked` neben dem Status `sale`.
-- ===========================================================================

create type sale_state as enum ('draft', 'sent', 'sale', 'cancel');
create type delivery_status as enum ('pending', 'partial', 'full');
create type invoice_status as enum ('no', 'to_invoice', 'invoiced');
create type order_source as enum ('manual', 'shopify');

create table sales_orders (
  id                 uuid primary key default gen_random_uuid(),
  number             text unique not null,
  state              sale_state not null default 'draft',
  locked             boolean not null default false,
  partner_id         uuid not null references partners on delete restrict,
  order_date         timestamptz not null default now(),
  confirmed_at       timestamptz,
  delivery_status    delivery_status not null default 'pending',
  invoice_status     invoice_status not null default 'no',
  source             order_source not null default 'manual',
  shopify_order_id   text unique,
  shopify_order_name text,
  shopify_tags_pushed text[] not null default '{}',
  currency           text not null default 'EUR',
  -- Lieferadresse wird beim Import eingefroren (Kundenstammdaten ändern sich).
  ship_name          text,
  ship_street        text,
  ship_house_number  text,
  ship_street2       text,
  ship_zip           text,
  ship_city          text,
  ship_country_code  text,
  ship_phone         text,
  ship_email         text,
  note               text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz
);
select attach_touch_trigger('sales_orders');
create index sales_orders_state_idx on sales_orders (state);
create index sales_orders_partner_idx on sales_orders (partner_id);

create type line_display_type as enum ('section', 'note');

create table sales_order_lines (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references sales_orders on delete cascade,
  sequence      int not null default 10,
  variant_id    uuid references product_variants on delete restrict,
  display_type  line_display_type,
  name          text not null,
  qty           numeric(16,4) not null default 0,
  uom_id        uuid references uoms on delete restrict,
  price_unit    numeric(16,2) not null default 0,
  discount      numeric(5,2) not null default 0,
  tax_rate      numeric(5,2) not null default 19,
  qty_delivered numeric(16,4) not null default 0,
  qty_invoiced  numeric(16,4) not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz,
  -- Strukturzeilen haben kein Produkt, Produktzeilen brauchen eines.
  constraint sales_line_shape check (
    (display_type is not null and variant_id is null) or
    (display_type is null and variant_id is not null))
);
select attach_touch_trigger('sales_order_lines');
create index sales_order_lines_order_idx on sales_order_lines (order_id, sequence);

-- Nettobetrag einer Position
create or replace function sale_line_subtotal(l sales_order_lines) returns numeric
language sql immutable as $$
  select round(l.qty * l.price_unit * (1 - l.discount / 100), 2);
$$;

create or replace function sales_order_total(p_order uuid)
returns table (net numeric, tax numeric, gross numeric)
language sql stable as $$
  select coalesce(sum(sale_line_subtotal(l)), 0) as net,
         coalesce(sum(round(sale_line_subtotal(l) * l.tax_rate / 100, 2)), 0) as tax,
         coalesce(sum(sale_line_subtotal(l) + round(sale_line_subtotal(l) * l.tax_rate / 100, 2)), 0) as gross
  from sales_order_lines l
  where l.order_id = p_order and l.display_type is null;
$$;


-- --- Berechnete Status -----------------------------------------------------
-- Lieferstatus aus den Positionen (Odoo: pending / partial / full).
create or replace function sales_order_recompute_status(p_order uuid) returns void
language plpgsql as $$
declare
  v_total numeric; v_delivered numeric; v_invoiced numeric;
  v_state sale_state;
  v_policy_delivery boolean;
begin
  select state into v_state from sales_orders where id = p_order;

  select coalesce(sum(l.qty), 0), coalesce(sum(l.qty_delivered), 0), coalesce(sum(l.qty_invoiced), 0)
    into v_total, v_delivered, v_invoiced
  from sales_order_lines l where l.order_id = p_order and l.display_type is null;

  update sales_orders set delivery_status = case
      when v_delivered <= 0 then 'pending'::delivery_status
      when v_delivered >= v_total then 'full'::delivery_status
      else 'partial'::delivery_status
    end
  where id = p_order;

  -- Abrechnungsstatus hängt an der Abrechnungspolitik der Produkte.
  select bool_or(pt.invoice_policy = 'delivery') into v_policy_delivery
  from sales_order_lines l
  join product_variants pv on pv.id = l.variant_id
  join product_templates pt on pt.id = pv.template_id
  where l.order_id = p_order;

  update sales_orders set invoice_status = case
      when v_state <> 'sale' then 'no'::invoice_status
      when v_invoiced >= (case when coalesce(v_policy_delivery, false) then v_delivered else v_total end)
           and v_invoiced > 0 then 'invoiced'::invoice_status
      when (case when coalesce(v_policy_delivery, false) then v_delivered else v_total end) > v_invoiced
        then 'to_invoice'::invoice_status
      else 'no'::invoice_status
    end
  where id = p_order;
end $$;

-- Schreibt gelieferte Mengen aus validierten Lieferungen in die Positionen zurück.
create or replace function sales_order_sync_delivered(p_order uuid) returns void
language plpgsql as $$
begin
  update sales_order_lines l set qty_delivered = coalesce((
    select sum(
      case when dst.type = 'customer' then m.qty_done
           when src.type = 'customer' then -m.qty_done   -- Retoure mindert wieder
           else 0 end)
    from stock_moves m
    join stock_pickings p on p.id = m.picking_id
    join stock_locations src on src.id = m.src_location_id
    join stock_locations dst on dst.id = m.dest_location_id
    where p.origin_model = 'sales_order' and p.origin_id = p_order
      and m.state = 'done' and m.variant_id = l.variant_id), 0)
  where l.order_id = p_order and l.display_type is null;

  perform sales_order_recompute_status(p_order);
end $$;


-- --- Statusübergänge -------------------------------------------------------
create or replace function sales_order_guard_editable(p_order uuid) returns void
language plpgsql as $$
declare o sales_orders%rowtype;
begin
  select * into o from sales_orders where id = p_order;
  if o.id is null then raise exception 'Verkaufsauftrag nicht gefunden'; end if;
  if o.locked then raise exception 'Auftrag % ist gesperrt und kann nicht geändert werden', o.number; end if;
  if o.state = 'cancel' then raise exception 'Auftrag % ist storniert', o.number; end if;
end $$;

/*
 * Bestätigt einen Verkaufsauftrag:
 *   - Status -> sale
 *   - legt EINEN Lieferauftrag über alle lagergeführten Positionen an
 *   - Fertigungsaufträge kommen in Migration 0006 dazu (Route "Fertigen")
 */
create or replace function confirm_sales_order(p_order uuid, p_actor text default 'system')
returns uuid
language plpgsql as $$
declare
  o sales_orders%rowtype;
  v_op operation_types%rowtype;
  v_picking uuid;
  l record;
  v_count int := 0;
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
    select sol.*, pt.type as product_type
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
  perform log_event('sales_order', p_order, 'state', 'Auftrag bestätigt', p_actor);
  return v_picking;
end $$;

create or replace function cancel_sales_order(p_order uuid, p_actor text default 'system')
returns void
language plpgsql as $$
declare
  o sales_orders%rowtype;
  p record;
begin
  select * into o from sales_orders where id = p_order for update;
  if o.id is null then raise exception 'Verkaufsauftrag nicht gefunden'; end if;
  if o.state = 'cancel' then return; end if;

  -- Offene Lieferungen stornieren (erledigte bleiben - Korrektur per Retoure).
  for p in
    select id, number from stock_pickings
    where origin_model = 'sales_order' and origin_id = p_order and state not in ('done', 'cancel')
  loop
    perform picking_cancel(p.id);
  end loop;

  update sales_orders set state = 'cancel', locked = false where id = p_order;
  perform log_event('sales_order', p_order, 'state', 'Auftrag storniert', p_actor);
end $$;

-- Nach jeder Transfer-Validierung die Auftragsmengen nachziehen.
create or replace function trg_picking_sync_sales() returns trigger
language plpgsql as $$
begin
  if new.state = 'done' and coalesce(old.state, 'draft') <> 'done'
     and new.origin_model = 'sales_order' and new.origin_id is not null then
    perform sales_order_sync_delivered(new.origin_id);
  end if;
  return null;
end $$;

create trigger picking_sync_sales
  after update of state on stock_pickings
  for each row execute function trg_picking_sync_sales();

insert into settings (key, value) values ('sales', '{"lock_confirmed": false}'::jsonb);
