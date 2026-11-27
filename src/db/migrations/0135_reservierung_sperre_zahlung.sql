-- ===========================================================================
-- 0135  Release-Schutz I: Reservierung mit Sperre, Reservieren beim Eingang
-- ===========================================================================
-- Entscheidungslog 2026-11-27 (Pakete S2 und „unbezahlt reserviert").
--
-- 1. move_reserve las den freien Bestand OHNE Sperre: zwei gleichzeitige
--    Bestell-Importe konnten beide die letzten Stücke reservieren. Jetzt
--    sperrt die Reservierung die Bestandszeile (for update) — die zweite
--    wartet, bis die erste gebucht hat, und sieht dann den Rest.
--
-- 2. Shop-Bestellungen reservieren schon beim EINGANG, nicht erst bei
--    Zahlung (Shopify hat seinen Bestand da längst heruntergezählt — KRNL
--    muss dasselbe sehen). Damit nichts Unbezahltes das Haus verlässt, ist
--    die Lieferung einer Bestellung mit offener Zahlung nicht versandbereit
--    und lässt sich nicht ausbuchen — dieselbe Sperre wie beim Halt (0134).

create or replace function move_reserve(p_move uuid) returns numeric
language plpgsql set search_path to 'public', 'pg_temp' as $$
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

  -- 0135: Bestandszeile sperren — gleichzeitige Reservierungen derselben
  -- Ware laufen nacheinander, keine reserviert doppelt.
  select greatest(coalesce(on_hand - reserved, 0), 0) into v_available
  from stock_quants where location_id = m.src_location_id and variant_id = m.variant_id
  for update;
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

-- Zahlung offen laut Shop: die Bestellung ist angelegt, das Geld noch nicht
-- da (Vorkasse, nur autorisiert, verfallen). null = unbekannt bzw. kein
-- Shop-Auftrag — gilt als frei.
create or replace function shop_zahlung_offen(p_zahlstatus text) returns boolean
language sql immutable as $$
  select coalesce(p_zahlstatus, '') in ('PENDING', 'AUTHORIZED', 'VOIDED', 'EXPIRED')
$$;

create or replace view shipping_ready as
  select
    p.id            as picking_id,
    p.number        as picking_number,
    p.state         as picking_state,
    so.id           as sales_order_id,
    so.number       as sales_order_number,
    so.shopify_order_name,
    part.name       as customer_name,
    so.ship_zip,
    so.ship_city,
    so.ship_country_code,
    (select count(*) from shipments s where s.picking_id = p.id
       and s.state <> 'cancelled')                       as shipment_count,
    (select coalesce(sum(pt.weight_g * m.qty), 0)::int
       from stock_moves m
       join product_variants pv on pv.id = m.variant_id
       join product_templates pt on pt.id = pv.template_id
      where m.picking_id = p.id and m.state <> 'cancel')  as weight_g,
    p.scheduled_date
  from stock_pickings p
  join operation_types ot on ot.id = p.operation_type_id
  left join sales_orders so on so.id = p.origin_id and p.origin_model = 'sales_order'
  left join partners part on part.id = p.partner_id
  where ot.kind = 'delivery'
    and p.state = 'assigned'
    and not coalesce(so.shopify_halt, false)
    and not shop_zahlung_offen(so.shopify_zahlstatus)
    and not exists (
      select 1 from manufacturing_orders mo
      where mo.sales_order_id = so.id and mo.state not in ('done', 'cancel'));

create or replace function picking_shopify_halt_pruefen() returns trigger
language plpgsql as $$
declare
  v record;
begin
  if new.state = 'done' and old.state is distinct from new.state
     and new.origin_model = 'sales_order' then
    select so.number, so.shopify_order_name, so.shopify_halt, so.shopify_halt_grund,
           so.shopify_halt_notiz, so.shopify_zahlstatus
      into v
      from sales_orders so
      join operation_types ot on ot.id = new.operation_type_id
     where so.id = new.origin_id and ot.kind = 'delivery'
       and (so.shopify_halt or shop_zahlung_offen(so.shopify_zahlstatus));
    if found and v.shopify_halt then
      raise exception '% ist in Shopify angehalten (%) — erst dort freigeben, dann versenden.',
        coalesce(v.shopify_order_name, v.number),
        coalesce(nullif(concat_ws(': ', v.shopify_halt_grund, v.shopify_halt_notiz), ''), 'ohne Angabe');
    elsif found then
      raise exception '% ist laut Shopify noch nicht bezahlt — Versand erst nach Zahlungseingang.',
        coalesce(v.shopify_order_name, v.number);
    end if;
  end if;
  return new;
end $$;
