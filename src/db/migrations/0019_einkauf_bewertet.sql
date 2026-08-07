-- ===========================================================================
-- Einkauf mit Bewertung verzahnen
-- ===========================================================================
-- Beim Bestätigen wird der Tageskurs eingefroren und der Einstandspreis je
-- Lagereinheit direkt an die Eingangsbewegung geschrieben. So steht der Wert
-- fest, auch wenn sich Kurs oder Bestellpreis später ändern.

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
  v_rate numeric;
  v_unit_cost numeric;
begin
  select * into o from purchase_orders where id = p_order for update;
  if o.id is null then raise exception 'Bestellung nicht gefunden'; end if;
  if o.state in ('purchase', 'done') then return null; end if;
  if o.state = 'cancel' then raise exception 'Stornierte Bestellungen können nicht bestätigt werden'; end if;

  -- Kurs einfrieren (Hauswährung: 1). Ein bereits gesetzter Kurs bleibt.
  v_rate := case when o.exchange_rate <> 1 then o.exchange_rate
                 else exchange_rate_at(o.currency, current_date) end;
  update purchase_orders set exchange_rate = v_rate where id = p_order;

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

    -- Einstand je Lagereinheit: Preis abzüglich Rabatt, in Hauswährung,
    -- umgerechnet auf die Lagereinheit (z. B. Dutzend → Stück).
    v_unit_cost := case when v_qty_stock > 0
      then round(l.qty * l.price_unit * (1 - l.discount / 100.0) * v_rate / v_qty_stock, 6)
      else null end;

    insert into stock_moves (
      picking_id, variant_id, uom_id, qty, src_location_id, dest_location_id,
      state, unit_cost)
    values (
      v_picking, l.variant_id, v_stock_uom, v_qty_stock,
      v_op.default_src_id, v_op.default_dest_id, 'draft', v_unit_cost);

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
