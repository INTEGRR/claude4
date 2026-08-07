-- ===========================================================================
-- Odoo-Vervollständigung IV: Meldebestände (stock.warehouse.orderpoint)
-- Min/Max-Regeln je Variante und Lagerort, Beschaffungsvorschläge und
-- deren Ausführung als Entwurfs-Bestellung bzw. Fertigungsauftrag.
-- ===========================================================================

create table stock_orderpoints (
  id            uuid primary key default gen_random_uuid(),
  variant_id    uuid not null references product_variants on delete cascade,
  location_id   uuid not null references stock_locations on delete cascade,
  min_qty       numeric(16,4) not null default 0,        -- product_min_qty
  max_qty       numeric(16,4) not null default 0,        -- product_max_qty
  qty_multiple  numeric(16,4) not null default 1 check (qty_multiple > 0),
  trigger       text not null default 'auto' check (trigger in ('auto', 'manual')),
  snoozed_until date,                                    -- snoozed_until
  route         text check (route in ('buy', 'manufacture')),  -- null = aus Produktrouten
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz,
  unique (variant_id, location_id),
  check (max_qty >= min_qty)
);
select attach_touch_trigger('stock_orderpoints');

alter table manufacturing_orders
  add column orderpoint_id uuid references stock_orderpoints on delete set null;

-- --- Vorschlagsliste -------------------------------------------------------
-- Ein Vorschlag entsteht, wenn der disponierte Bestand (forecasted_qty)
-- unter den Mindestbestand fällt. Aufgefüllt wird bis zum Maximalbestand,
-- aufgerundet auf das Losgrößen-Vielfache (Odoo: qty_to_order).
create or replace function orderpoint_suggestions()
returns table (
  orderpoint_id uuid,
  variant_id    uuid,
  product       text,
  location      text,
  qty_on_hand   numeric,
  qty_forecast  numeric,
  min_qty       numeric,
  max_qty       numeric,
  qty_to_order  numeric,
  route         text,
  vendor_id     uuid,
  vendor_name   text,
  unit_price    numeric
)
language sql stable as $$
  with basis as (
    select op.id as orderpoint_id, op.variant_id,
           variant_display_name(op.variant_id) as product,
           loc.full_path as location,
           on_hand_qty(op.variant_id, loc.id) as qty_on_hand,
           forecasted_qty(op.variant_id) as qty_forecast,
           op.min_qty, op.max_qty, op.qty_multiple,
           coalesce(op.route,
                    case when pt.route_manufacture then 'manufacture'
                         when pt.route_buy then 'buy' end) as route,
           pv.template_id
    from stock_orderpoints op
    join stock_locations loc on loc.id = op.location_id
    join product_variants pv on pv.id = op.variant_id
    join product_templates pt on pt.id = pv.template_id
    where op.active and op.trigger = 'auto'
      and (op.snoozed_until is null or op.snoozed_until <= current_date)
  ),
  bedarf as (
    select b.*,
           ceil(greatest(b.max_qty - b.qty_forecast, 0) / b.qty_multiple) * b.qty_multiple
             as qty_to_order
    from basis b
    where b.qty_forecast < b.min_qty
  )
  select d.orderpoint_id, d.variant_id, d.product, d.location,
         d.qty_on_hand, d.qty_forecast, d.min_qty, d.max_qty, d.qty_to_order,
         d.route, vp.vendor_id, p.name as vendor_name,
         vendor_price_net((best_vendor_price(d.variant_id, vp.vendor_id, d.qty_to_order)).price,
                          (best_vendor_price(d.variant_id, vp.vendor_id, d.qty_to_order)).discount)
           as unit_price
  from bedarf d
  left join lateral (
    select vendor_id from vendor_prices
    where template_id = d.template_id
      and (variant_id is null or variant_id = d.variant_id)
    order by sequence, price limit 1
  ) vp on true
  left join partners p on p.id = vp.vendor_id
  where d.qty_to_order > 0
  order by d.product;
$$;

-- --- Ausführung ------------------------------------------------------------
-- Route 'buy': in eine offene Entwurfs-Bestellung desselben Lieferanten
-- mergen (Odoo-Verhalten), sonst neue anlegen. Route 'manufacture':
-- bestätigter Fertigungsauftrag. origin verweist auf den Meldebestand.
create or replace function orderpoint_execute(p_orderpoint uuid, p_actor text default 'system')
returns text
language plpgsql as $$
declare
  s record;
  v_po uuid;
  v_po_number text;
  v_uom uuid;
  v_mo uuid;
  v_number text;
begin
  select * into s from orderpoint_suggestions() where orderpoint_id = p_orderpoint;
  if s.orderpoint_id is null then
    raise exception 'Kein offener Beschaffungsvorschlag zu dieser Regel';
  end if;

  if s.route = 'manufacture' then
    v_mo := create_manufacturing_order(s.variant_id, s.qty_to_order, null, null, p_actor);
    update manufacturing_orders
      set orderpoint_id = p_orderpoint, origin = 'Meldebestand ' || s.product
      where id = v_mo;
    perform mo_confirm(v_mo, p_actor);
    select number into v_number from manufacturing_orders where id = v_mo;
    return v_number;
  end if;

  if s.vendor_id is null then
    raise exception 'Kein Lieferant mit Preisliste für % hinterlegt', s.product;
  end if;

  -- Offene Entwurfs-Bestellung des Lieferanten wiederverwenden.
  select id, number into v_po, v_po_number
  from purchase_orders
  where vendor_id = s.vendor_id and state = 'draft'
  order by created_at desc limit 1;

  if v_po is null then
    insert into purchase_orders (number, vendor_id, origin)
    values (next_sequence('purchase'), s.vendor_id, 'Meldebestand')
    returning id, number into v_po, v_po_number;
  end if;

  select coalesce(pt.purchase_uom_id, pt.uom_id) into v_uom
  from product_variants pv join product_templates pt on pt.id = pv.template_id
  where pv.id = s.variant_id;

  insert into purchase_order_lines
    (order_id, sequence, variant_id, name, qty, uom_id, price_unit)
  values (
    v_po,
    coalesce((select max(sequence) + 10 from purchase_order_lines where order_id = v_po), 10),
    s.variant_id, s.product, s.qty_to_order, v_uom, coalesce(s.unit_price, 0));

  perform log_event('purchase_order', v_po, 'note',
    format('Position aus Meldebestand: %s × %s', s.qty_to_order, s.product), p_actor);
  return v_po_number;
end $$;
