-- BUG/00006: Die Beschaffung kennt Mindestbestellmengen (MOQ) und
-- Preisstaffeln. vendor_prices trägt beides längst (min_qty je Staffelzeile),
-- aber die Vorschläge ignorierten es: Mengen unter der MOQ, Preise stets aus
-- der Basisstaffel, und ohne Zeile mit min_qty 0 blieb der Preis leer.
--
-- Jetzt nennt jede Vorschlagszeile die MOQ des Lieferanten und eine
-- EMPFOHLENE Menge (auf die MOQ angehoben, aufs Losgrößen-Vielfache
-- gerundet); der Preis gilt für die empfohlene Menge. Entschieden wird auf
-- der Beschaffungsseite: die Ausführung nimmt eine Wunschmenge entgegen und
-- zieht den Staffelpreis der tatsächlich bestellten Menge — nichts wird
-- stumm angehoben.

-- Rückgabetyp wächst → alte Funktion muss weichen (orderpoint_execute wird
-- unten ohnehin neu erstellt).
drop function if exists orderpoint_execute(uuid, text);
drop function if exists orderpoint_suggestions();

create function orderpoint_suggestions()
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
  moq           numeric,
  qty_empfohlen numeric,
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
  -- Offener Zulauf, den forecasted_qty nicht sieht (siehe 0053).
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
  ),
  mit_lieferant as (
    select d.*, vp.vendor_id, p.name as vendor_name,
           -- MOQ = kleinste Mindestmenge der aktuell gültigen Preiszeilen.
           (select min(vp2.min_qty) from vendor_prices vp2
            where vp2.vendor_id = vp.vendor_id
              and vp2.template_id = d.template_id
              and (vp2.variant_id is null or vp2.variant_id = d.variant_id)
              and (vp2.date_start is null or vp2.date_start <= current_date)
              and (vp2.date_end is null or vp2.date_end >= current_date)) as moq
    from bedarf d
    left join lateral (
      select vendor_id from vendor_prices
      where template_id = d.template_id
        and (variant_id is null or variant_id = d.variant_id)
      order by sequence, price limit 1
    ) vp on true
    left join partners p on p.id = vp.vendor_id
    where d.qty_to_order > 0
  )
  select m.orderpoint_id, m.variant_id, m.product, m.location,
         m.qty_on_hand, m.qty_forecast, m.min_qty, m.max_qty, m.qty_to_order,
         m.route, m.vendor_id, m.vendor_name, m.moq,
         -- Empfehlung: mindestens die MOQ, wieder aufs Vielfache gerundet.
         ceil(greatest(m.qty_to_order, coalesce(m.moq, 0)) / m.qty_multiple) * m.qty_multiple
           as qty_empfohlen,
         vendor_price_net(
           (best_vendor_price(m.variant_id, m.vendor_id,
              ceil(greatest(m.qty_to_order, coalesce(m.moq, 0)) / m.qty_multiple) * m.qty_multiple)).price,
           (best_vendor_price(m.variant_id, m.vendor_id,
              ceil(greatest(m.qty_to_order, coalesce(m.moq, 0)) / m.qty_multiple) * m.qty_multiple)).discount)
           as unit_price
  from mit_lieferant m
  order by m.product;
$$;

comment on function orderpoint_suggestions is
  'Beschaffungsvorschläge: Prognose plus offener Zulauf unter Minimum → bis Maximum auffüllen. qty_empfohlen hebt auf die MOQ des Lieferanten an; unit_price ist der Staffelpreis der empfohlenen Menge.';

-- Gültige Staffelzeilen eines Lieferanten für eine Variante — die
-- Beschaffungsseite zeigt daraus alternative Mengen mit Begründung.
create or replace function vendor_staffeln(p_variant uuid, p_vendor uuid)
returns table (min_qty numeric, price numeric, discount numeric, netto numeric)
language sql stable as $$
  select vp.min_qty, vp.price, vp.discount, vendor_price_net(vp.price, vp.discount) as netto
  from vendor_prices vp
  join product_variants pv on pv.template_id = vp.template_id
  where pv.id = p_variant
    and vp.vendor_id = p_vendor
    and (vp.variant_id is null or vp.variant_id = p_variant)
    and (vp.date_start is null or vp.date_start <= current_date)
    and (vp.date_end is null or vp.date_end >= current_date)
  order by vp.min_qty, vp.sequence;
$$;

comment on function vendor_staffeln is
  'Aktuell gültige Preisstaffeln (min_qty aufsteigend) eines Lieferanten für eine Variante.';

-- Ausführung mit Wunschmenge: p_qty leer = empfohlene Menge. Der Preis der
-- Bestellposition kommt aus der Staffel der TATSÄCHLICH bestellten Menge.
create function orderpoint_execute(p_orderpoint uuid, p_actor text default 'system',
                                   p_qty numeric default null)
returns text
language plpgsql as $$
declare
  s record;
  v_qty numeric;
  v_price numeric;
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

  v_qty := coalesce(p_qty, s.qty_empfohlen, s.qty_to_order);
  if v_qty is null or v_qty <= 0 then
    raise exception 'Die Menge muss über 0 liegen';
  end if;

  if s.route = 'manufacture' then
    v_mo := create_manufacturing_order(s.variant_id, v_qty, null, null, p_actor);
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

  if s.moq is not null and v_qty < s.moq then
    raise exception 'Menge % liegt unter der Mindestbestellmenge % von %',
      v_qty, s.moq, s.vendor_name;
  end if;

  v_price := vendor_price_net((best_vendor_price(s.variant_id, s.vendor_id, v_qty)).price,
                              (best_vendor_price(s.variant_id, s.vendor_id, v_qty)).discount);

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
    s.variant_id, s.product, v_qty, v_uom, coalesce(v_price, s.unit_price, 0));

  perform log_event('purchase_order', v_po, 'note',
    format('Position aus Meldebestand: %s × %s', v_qty, s.product), p_actor);
  return v_po_number;
end $$;

comment on function orderpoint_execute is
  'Führt einen Beschaffungsvorschlag aus (Bestellposition oder bestätigter Fertigungsauftrag). p_qty leer = empfohlene Menge (MOQ-angehoben); Kaufmengen unter der MOQ werden abgelehnt.';
