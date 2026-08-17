-- BUG/00005: Beschaffungsvorschläge ließen sich mehrfach bestellen.
--
-- Ursache: Entwurfs- und angefragte Bestellungen (draft/sent) erzeugen noch
-- keine Lagerbewegungen, und Fertigungsaufträge buchen ihr Fertigprodukt erst
-- bei der Fertigmeldung — beides fehlt in forecasted_qty. Nach „Bestellen"
-- blieb der Vorschlag deshalb stehen und ein zweiter Klick bestellte erneut.
--
-- Fix: Die Vorschlagsrechnung zählt diesen offenen Zulauf mit. Nach dem
-- Ausführen fällt der Vorschlag sofort aus der Liste; er kehrt von selbst
-- zurück, wenn die Bestellung storniert wird, ohne dass Ware kam.

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
  -- Offener Zulauf, den forecasted_qty nicht sieht: Bestellpositionen in
  -- draft/sent (bestätigte Bestellungen haben Empfangs-Bewegungen und stecken
  -- schon in incoming_qty) und Restmengen laufender Fertigungsaufträge (das
  -- Fertigprodukt wird erst bei der Fertigmeldung gebucht).
  zulauf as (
    select b.orderpoint_id,
           coalesce((select sum(greatest(pol.qty - pol.qty_received, 0))
                     from purchase_order_lines pol
                     join purchase_orders po on po.id = pol.order_id
                     where pol.variant_id = b.variant_id
                       and po.state in ('draft', 'sent')), 0)
         + coalesce((select sum(greatest(mo.qty_to_produce - mo.qty_produced, 0))
                     from manufacturing_orders mo
                     where mo.variant_id = b.variant_id
                       and mo.state in ('draft', 'confirmed', 'progress', 'to_close')), 0)
           as qty_unterwegs
    from basis b
  ),
  bedarf as (
    select b.*,
           ceil(greatest(b.max_qty - (b.qty_forecast + z.qty_unterwegs), 0) / b.qty_multiple)
             * b.qty_multiple as qty_to_order
    from basis b
    join zulauf z using (orderpoint_id)
    where b.qty_forecast + z.qty_unterwegs < b.min_qty
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

comment on function orderpoint_suggestions is
  'Beschaffungsvorschläge: Prognose plus offener Zulauf (draft/sent-Bestellungen, laufende Fertigungsaufträge) unter Minimum → bis Maximum auffüllen, aufgerundet aufs Losgrößen-Vielfache.';
