-- ===========================================================================
-- Reparatur: Teile auch nach dem Bestätigen erfassen
-- ===========================================================================
--
-- Gefunden vom Prozesstest: der Reparatur-Prozess bietet „Teile erfassen"
-- während der laufenden Reparatur an (erst am offenen Gerät zeigt sich der
-- Bedarf) — die Engine legte Bewegungen aber nur beim Bestätigen an
-- (repair_confirm). Ein später erfasstes Teil bekam nie einen Move:
-- repair_end setzte zwar qty_done, gebucht wurde nichts — Teileliste und
-- Lager liefen stillschweigend auseinander.
--
-- repair_add_part legt das Teil an UND zieht bei bereits bestätigten
-- Aufträgen die Bewegung sofort nach (inklusive Reservierung bei
-- Einbauteilen) — dieselben Buchungsrichtungen wie repair_confirm.

create or replace function repair_add_part(
  p_repair uuid,
  p_variant uuid,
  p_qty numeric,
  p_part_type repair_part_type,
  p_actor text default 'system'
) returns uuid
language plpgsql as $$
declare
  r repair_orders%rowtype;
  v_uom uuid;
  v_price numeric;
  v_part uuid;
  v_move uuid;
  v_stock uuid;
  v_production uuid;
  v_scrap uuid;
  v_src uuid;
  v_dest uuid;
begin
  select * into r from repair_orders where id = p_repair for update;
  if r.id is null then raise exception 'Reparaturauftrag nicht gefunden'; end if;
  if r.state not in ('new', 'confirmed', 'under_repair') then
    raise exception 'Im Status % lassen sich keine Teile mehr erfassen', r.state;
  end if;
  if p_qty <= 0 then raise exception 'Die Menge muss größer als 0 sein'; end if;

  select pt.uom_id, pt.list_price into v_uom, v_price
  from product_variants pv join product_templates pt on pt.id = pv.template_id
  where pv.id = p_variant;
  if v_uom is null then raise exception 'Teil nicht gefunden'; end if;

  insert into repair_parts (repair_id, sequence, part_type, variant_id, qty, uom_id, price_unit)
  values (p_repair,
          coalesce((select max(sequence) + 10 from repair_parts where repair_id = p_repair), 10),
          p_part_type, p_variant, p_qty, v_uom, coalesce(v_price, 0))
  returning id into v_part;

  -- Vor dem Bestätigen reicht die Zeile — repair_confirm zieht die Bewegungen.
  if r.state = 'new' then return v_part; end if;

  select id into v_stock from stock_locations where full_path = 'WH/Stock';
  select id into v_production from stock_locations where type = 'production' limit 1;
  select id into v_scrap from stock_locations where is_scrap limit 1;

  if p_part_type = 'add' then
    v_src := v_stock; v_dest := v_production;
  elsif p_part_type = 'remove' then
    v_src := v_production; v_dest := v_scrap;
  else
    v_src := v_production; v_dest := v_stock;
  end if;

  insert into stock_moves (repair_id, variant_id, uom_id, qty,
                           src_location_id, dest_location_id, state, reference)
  values (p_repair, p_variant, v_uom, p_qty, v_src, v_dest,
          'confirmed', 'Reparatur ' || r.number)
  returning id into v_move;

  update repair_parts set move_id = v_move where id = v_part;

  if p_part_type = 'add' then
    perform move_reserve(v_move);
  end if;

  perform log_event('repair_order', p_repair, 'note',
    'Teil während der Reparatur erfasst (' || p_part_type || ', Menge ' || p_qty || ')',
    p_actor);
  return v_part;
end $$;
