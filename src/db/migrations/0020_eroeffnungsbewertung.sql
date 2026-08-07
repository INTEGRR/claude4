-- ===========================================================================
-- Eröffnungsbewertung für Altbestände
-- ===========================================================================
-- Bestand, der vor Einführung der Bewertung entstanden ist, trägt keinen
-- Wert. Ohne Eröffnungsbuchung bliebe er dauerhaft unbewertet: Abgänge
-- würden mit 0 € bewertet und der Bestandswert wäre zu niedrig.
--
-- Die Eröffnung bewertet die Differenz zwischen physischem und bewertetem
-- Bestand zum hinterlegten Einstandspreis. Sie ist wiederholbar und rührt
-- bereits bewertete Mengen nicht an.

create or replace function valuation_initialize(
  p_variant uuid default null,        -- NULL = alle Varianten
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
           -- Einstand: gepflegte Kosten, sonst Stücklistenwert der Variante
           case
             when pt.standard_cost > 0 then pt.standard_cost
             else coalesce((
               select sum(c.qty * cpt.standard_cost)
               from bom_components_for_variant(resolve_bom(pv.id), pv.id) c
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

    -- Zugang zum Einstandspreis; bei Abgangsdifferenz zum laufenden Schnitt.
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

comment on function valuation_initialize is
  'Bewertet unbewerteten Altbestand zum Einstandspreis. Wiederholbar — '
  'bereits bewertete Mengen bleiben unangetastet.';
