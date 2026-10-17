-- ============================================================================
-- 0128 — Plural statt Klammer-Plural in Verlaufstexten (F5, UX-Audit,
-- Entscheidungslog 2026-10-17)
--
-- „3 Position(en)", „1 Fertigungsauftrag/-aufträge" — jetzt „3 Positionen",
-- „1 Fertigungsauftrag". plural_text(n, eins, viele) setzt die Zahl deutsch
-- (zahl_text, 0127) und wählt die Form.
--
--  * plural_text (neu)
--  * volle Körper, nur die Texte geändert: confirm_sales_order (0119),
--    cancel_sales_order (0110), create_manufacturing_order (0021),
--    absence_approve (0022), eingangs_sendung_verteilen und
--    eingangs_sendung_schaetzung (0127)
-- ============================================================================

create or replace function plural_text(p_anzahl numeric, p_eins text, p_viele text) returns text
language sql immutable as $$
  select zahl_text(p_anzahl) || ' ' || case when p_anzahl = 1 then p_eins else p_viele end;
$$;

comment on function plural_text(numeric, text, text) is
  'Zahl mit Singular/Plural für Texte (0128): plural_text(3, ''Position'', ''Positionen'') → „3 Positionen". Gegenstück zu plural() in format.ts.';


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
  v_genutzt jsonb := '{}'::jsonb;
  v_frei numeric;
  v_aus_lager numeric;
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

    -- Route "Fertigen auf Bestellung": je Position ein Fertigungsauftrag —
    -- seit 0119 nur für das, was ein verkaufsfähig geprüfter RÜCKLÄUFER
    -- (Retoure) nicht deckt. Gewöhnlicher Fertigbestand ersetzt keine
    -- Fertigung (MTO beschafft auftragsbezogen). Gedeckelt durch den freien
    -- Bestand am Ausgangsort; mehrere Zeilen derselben Variante teilen ihn.
    if l.route_manufacture and l.route_mto and resolve_bom(l.variant_id) is not null then
      v_frei := greatest(least(
                  free_to_use(l.variant_id, v_op.default_src_id)
                    - coalesce((v_genutzt ->> l.variant_id::text)::numeric, 0),
                  ruecklaeufer_frei(l.variant_id)), 0);
      v_aus_lager := least(v_frei, l.qty);
      if v_aus_lager > 0 then
        v_genutzt := v_genutzt || jsonb_build_object(l.variant_id::text,
          coalesce((v_genutzt ->> l.variant_id::text)::numeric, 0) + v_aus_lager);
        perform ruecklaeufer_verbrauchen(l.variant_id, v_aus_lager);
        perform log_event('sales_order', p_order, 'note',
          format('%s × %s aus Rückläufer (Retoure) bedient — dafür keine Fertigung', trim_scale(v_aus_lager), l.name), p_actor);
      end if;
      if l.qty - v_aus_lager > 0 then
        v_mo := create_manufacturing_order(l.variant_id, l.qty - v_aus_lager, p_order, null, p_actor);
        update manufacturing_orders set origin = o.number where id = v_mo;
        perform mo_confirm(v_mo, p_actor);
        v_mo_count := v_mo_count + 1;
      end if;
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
    format('Auftrag bestätigt (%s, %s)',
           plural_text(v_count, 'Lieferposition', 'Lieferpositionen'),
           plural_text(v_mo_count, 'Fertigungsauftrag', 'Fertigungsaufträge')), p_actor);
  return v_picking;
end $$;


create or replace function cancel_sales_order(p_order uuid, p_actor text default 'system')
returns void
language plpgsql
set search_path = public, pg_temp as $$
declare
  o sales_orders%rowtype;
  p record;
  m record;
  v_fertig int;
  v_druck int;
  v_meldungen int;
begin
  select * into o from sales_orders where id = p_order for update;
  if o.id is null then raise exception 'Verkaufsauftrag nicht gefunden'; end if;
  if o.state = 'cancel' then return; end if;

  -- Offene Lieferungen stornieren (erledigte bleiben — Korrektur per Retoure).
  for p in
    select id from stock_pickings
    where origin_model = 'sales_order' and origin_id = p_order and state not in ('done', 'cancel')
  loop
    perform picking_cancel(p.id);
  end loop;

  for m in
    select id, number from manufacturing_orders
    where sales_order_id = p_order and state not in ('done', 'cancel')
  loop
    if exists (select 1 from stock_moves
               where production_id = m.id and state = 'done') then
      perform log_event('sales_order', p_order, 'note',
        format('Fertigungsauftrag %s ist angebrochen (Material bereits entnommen) und bleibt bestehen — fertig bauen oder demontieren.', m.number),
        p_actor);
    else
      perform mo_cancel(m.id, p_actor);
      perform log_event('sales_order', p_order, 'note',
        format('Fertigungsauftrag %s storniert, Materialreservierungen freigegeben.', m.number),
        p_actor);
    end if;
  end loop;

  select count(*) into v_fertig from manufacturing_orders
  where sales_order_id = p_order and state = 'done';
  if v_fertig > 0 then
    perform log_event('sales_order', p_order, 'note',
      'Die fertige Ware aus der bereits erledigten Fertigung liegt im Bestand und ist wieder frei verfügbar.',
      p_actor);
  end if;

  -- Noch nicht gedruckte Labels, Packzettel und Fertigungszettel nicht mehr
  -- drucken (nur offene von stornierten Belegen; Gedrucktes bleibt Verlauf).
  update druckauftraege d
  set status = 'fehler', fehler = 'Auftrag storniert — nicht gedruckt'
  where d.status = 'offen'
    and (
      d.picking_id in (select id from stock_pickings
                       where origin_model = 'sales_order' and origin_id = p_order and state = 'cancel')
      or d.shipment_id in (select s.id from shipments s
                           join stock_pickings sp on sp.id = s.picking_id
                           where sp.origin_model = 'sales_order' and sp.origin_id = p_order
                             and sp.state = 'cancel')
      or d.mo_id in (select id from manufacturing_orders
                     where sales_order_id = p_order and state = 'cancel')
    );
  get diagnostics v_druck = row_count;
  if v_druck > 0 then
    perform log_event('sales_order', p_order, 'note',
      format('%s zurückgezogen.', plural_text(v_druck, 'offener Druckauftrag', 'offene Druckaufträge')), p_actor);
  end if;

  -- Wartende Shop-Rückmeldungen (Fulfillment) zu Sendungen des Auftrags
  -- nicht mehr senden — eine stornierte Shop-Bestellung nimmt keins an.
  update integration_jobs j
  set status = 'done', last_result = 'Übersprungen: Auftrag storniert', last_error = null, dedupe_key = null
  where j.status = 'pending' and j.kind = 'shopify_fulfillment_create'
    and (j.payload ->> 'shipment_id')::uuid in (
      select s.id from shipments s
      left join stock_pickings sp on sp.id = s.picking_id
      where s.sales_order_id = p_order
         or (sp.origin_model = 'sales_order' and sp.origin_id = p_order));
  get diagnostics v_meldungen = row_count;
  if v_meldungen > 0 then
    perform log_event('sales_order', p_order, 'note',
      format('%s verworfen.', plural_text(v_meldungen, 'wartende Shop-Rückmeldung', 'wartende Shop-Rückmeldungen')), p_actor);
  end if;

  update sales_orders set state = 'cancel', locked = false where id = p_order;
  perform log_event('sales_order', p_order, 'state', 'Auftrag storniert', p_actor);
end $$;


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
            then format(' (%s aus Baugruppen aufgelöst)', plural_text(v_phantoms, 'Position', 'Positionen'))
            else '' end, p_actor);
  return v_mo;
end $$;


create or replace function absence_approve(
  p_absence uuid, p_user uuid default null, p_actor text default 'system')
returns void
language plpgsql as $$
declare
  a absences%rowtype;
  v_shifts int;
  v_name text;
begin
  select * into a from absences where id = p_absence for update;
  if a.id is null then raise exception 'Antrag nicht gefunden'; end if;
  if a.state <> 'requested' then
    raise exception 'Nur offene Anträge können genehmigt werden';
  end if;

  select count(*) into v_shifts from shift_assignments s
  where s.employee_id = a.employee_id and s.state <> 'cancel'
    and s.starts_at < (a.ends_on + 1)::timestamptz
    and s.ends_at > a.starts_on::timestamptz;

  update absences
    set state = 'approved', decided_by = p_user, decided_at = now()
  where id = p_absence;

  select name into v_name from employees where id = a.employee_id;
  perform log_event('employee', a.employee_id, 'state',
    format('Abwesenheit genehmigt: %s bis %s', a.starts_on, a.ends_on)
    || case when v_shifts > 0
            then format(' — Achtung: %s im Zeitraum', plural_text(v_shifts, 'geplante Schicht', 'geplante Schichten'))
            else '' end, p_actor);
end $$;


create or replace function eingangs_sendung_verteilen(p_sendung uuid, p_actor text default 'system')
returns int
language plpgsql
set search_path = public, pg_temp as $$
declare
  s eingangs_sendungen%rowtype;
  k sendung_kosten%rowtype;
  lc record;
  v_offen text;
  v_ids uuid[];
  v_wert numeric[];
  v_gewicht numeric[];
  v_alle_gewicht boolean;
  v_basis numeric[];
  v_gesamt numeric;
  v_anteile numeric[];
  v_rest numeric;
  v_kum numeric;
  v_vorher numeric;
  v_kurs numeric;
  v_nach_gewicht boolean;
  v_lc uuid;
  v_korrigiert uuid;
  v_storniert int;
  v_n int;
  i int;
  v_gebucht int := 0;
begin
  select * into s from eingangs_sendungen where id = p_sendung for update;
  if s.id is null then raise exception 'Eingangssendung nicht gefunden'; end if;
  if s.status = 'storniert' then raise exception '% ist storniert — es gibt nichts zu verteilen', s.nummer; end if;

  if not exists (select 1 from sendung_kosten k2
                 where k2.sendung_id = s.id and k2.art <> 'eust' and k2.storniert_am is null
                   and k2.ersetzt_durch_id is null and k2.verteilt_am is null) then
    return 0;
  end if;

  select string_agg(p.number, ', ' order by p.number) into v_offen
  from stock_pickings p where p.eingangs_sendung_id = s.id and p.state not in ('done', 'cancel');
  if v_offen is not null then
    raise exception 'Erst die Wareneingänge buchen (%) — verteilt wird auf die gebuchten Eingänge der Sendung', v_offen;
  end if;

  select array_agg(x.id order by x.number), array_agg(x.wert order by x.number),
         array_agg(x.gewicht order by x.number), bool_and(x.alle_gewicht)
    into v_ids, v_wert, v_gewicht, v_alle_gewicht
  from (
    select p.id, p.number,
           coalesce(sum(greatest(m.qty_done * coalesce(move_receipt_cost(m.id), 0), 0)), 0) as wert,
           coalesce(sum(greatest(m.qty_done * coalesce(pt.weight_g, 0), 0)), 0) as gewicht,
           coalesce(bool_and(coalesce(pt.weight_g, 0) > 0), false) as alle_gewicht
    from stock_pickings p
    join stock_moves m on m.picking_id = p.id and m.state = 'done'
    join product_variants pv on pv.id = m.variant_id
    join product_templates pt on pt.id = pv.template_id
    where p.eingangs_sendung_id = s.id and p.state = 'done'
    group by p.id, p.number
  ) x;
  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then
    raise exception '% hat noch keinen gebuchten Wareneingang — erst Bestellungen zuordnen und den Eingang buchen', s.nummer;
  end if;

  for k in
    select * from sendung_kosten
    where sendung_id = s.id and art <> 'eust' and storniert_am is null
      and ersetzt_durch_id is null and verteilt_am is null
    order by created_at
  loop
    if k.waehrung <> 'EUR' and k.kurs is null and not exists (
         select 1 from exchange_rates r
         where r.currency = k.waehrung and r.valid_from <= coalesce(k.belegdatum, current_date)) then
      raise exception 'Kein Kurs für % — erst einen Kurs erfassen (Einkauf → Wechselkurse)', k.waehrung;
    end if;
    v_kurs := coalesce(k.kurs, exchange_rate_at(k.waehrung, coalesce(k.belegdatum, current_date)));

    -- Korrektur: die Landed Costs der ersetzten Schätzungen zurücknehmen.
    v_storniert := 0;
    for lc in
      select l.id from landed_costs l
      join sendung_kosten e on e.id = l.sendung_kosten_id
      where e.ersetzt_durch_id = k.id and l.state = 'posted'
    loop
      perform landed_cost_cancel(lc.id, p_actor);
      v_storniert := v_storniert + 1;
    end loop;

    v_nach_gewicht := k.art = 'fracht' and coalesce(v_alle_gewicht, false);
    v_basis := case when v_nach_gewicht then v_gewicht else v_wert end;
    select coalesce(sum(b), 0) into v_gesamt from unnest(v_basis) b;
    if v_gesamt <= 0 then
      v_basis := array_fill(1::numeric, array[v_n]);
      v_gesamt := v_n;
    end if;

    -- Anteile auf den Cent, Rundungsrest auf den letzten Eingang.
    v_anteile := array_fill(0::numeric, array[v_n]);
    v_rest := k.betrag;
    for i in 1 .. v_n - 1 loop
      v_anteile[i] := round(k.betrag * v_basis[i] / v_gesamt, 2);
      v_rest := v_rest - v_anteile[i];
    end loop;
    v_anteile[v_n] := v_rest;
    if v_rest < 0 then
      -- Grenzfall vieler winziger Anteile: kumulativ runden — die Summe
      -- bleibt exakt, kein Anteil wird negativ, der Rest landet am Ende.
      v_kum := 0;
      v_vorher := 0;
      for i in 1 .. v_n loop
        v_kum := v_kum + v_basis[i];
        v_anteile[i] := round(k.betrag * v_kum / v_gesamt, 2) - v_vorher;
        v_vorher := v_vorher + v_anteile[i];
      end loop;
    end if;

    for i in 1 .. v_n loop
      continue when v_anteile[i] <= 0;
      v_korrigiert := null;
      select l.id into v_korrigiert
      from landed_costs l join sendung_kosten e on e.id = l.sendung_kosten_id
      where e.ersetzt_durch_id = k.id and l.picking_id = v_ids[i]
      order by l.created_at limit 1;

      insert into landed_costs (number, picking_id, cost_type, basis, amount, currency, exchange_rate,
                                is_estimate, corrects_id, vendor_id, note, sendung_kosten_id)
      values (next_sequence('landed'), v_ids[i],
              (case k.art when 'fracht' then 'freight' when 'zoll' then 'customs_duty'
                          when 'versicherung' then 'insurance' else 'other' end)::landed_cost_type,
              (case when v_nach_gewicht then 'weight' else 'value' end)::landed_cost_basis,
              v_anteile[i], k.waehrung, v_kurs, k.schaetzung, v_korrigiert, k.partner_id,
              format('%s · %s%s', s.nummer, eingangs_sendung_kostenart_text(k.art),
                     case when k.schaetzung then ' (Schätzung)' else '' end),
              k.id)
      returning id into v_lc;
      perform landed_cost_post(v_lc, p_actor);
      v_gebucht := v_gebucht + 1;
    end loop;

    update sendung_kosten set verteilt_am = now(), kurs = v_kurs where id = k.id;
    perform log_event('eingangs_sendung', s.id, 'info',
      format('%s %s %s%s verteilt auf %s (nach %s)%s',
             eingangs_sendung_kostenart_text(k.art),
             zahl_text(k.betrag, 2), k.waehrung,
             case when k.schaetzung then ' (Schätzung)' else '' end,
             plural_text(v_n, 'Wareneingang', 'Wareneingänge'), case when v_nach_gewicht then 'Gewicht' else 'Warenwert' end,
             case when v_storniert > 0 then format(' — Korrektur: %s der Schätzung storniert', plural_text(v_storniert, 'Nebenkostenbeleg', 'Nebenkostenbelege'))
                  else '' end),
      p_actor);
  end loop;
  return v_gebucht;
end $$;


create or replace function eingangs_sendung_schaetzung(p_sendung uuid)
returns table (art text, betrag numeric, grundlage text)
language plpgsql stable
set search_path = public, pg_temp as $$
declare
  s eingangs_sendungen%rowtype;
  v_satz frachtsaetze%rowtype;
  v_kg numeric;
  v_kg_quelle text;
  v_ware numeric;
  v_zoll numeric;
  v_ohne_satz int;
  v_fracht numeric;
begin
  select * into s from eingangs_sendungen where id = p_sendung;
  if s.id is null then raise exception 'Eingangssendung nicht gefunden'; end if;
  select * into v_satz from frachtsaetze f where f.modus = s.modus;

  with pos as (
    select l.qty, coalesce(pt.weight_g, 0)::numeric as weight_g,
           l.price_unit * (1 - coalesce(l.discount, 0) / 100.0) * l.qty
             * case when po.currency = 'EUR' then 1
                    when po.exchange_rate <> 1 then po.exchange_rate
                    else exchange_rate_at(po.currency) end as ware_eur,
           coalesce(po.incoterm_code in ('DAP', 'DPU', 'DDP'), false) as d_klausel,
           coalesce(po.incoterm_code = 'DDP', false) as ddp,
           (select z.satz_pct from zolltarife z
            where nullif(regexp_replace(coalesce(pt.hs_code, ''), '[^0-9]', '', 'g'), '') like z.hs_praefix || '%'
            order by length(z.hs_praefix) desc limit 1) as satz
    from eingangs_sendung_bestellungen b
    join purchase_orders po on po.id = b.purchase_order_id and po.state <> 'cancel'
    join purchase_order_lines l on l.order_id = po.id
    join product_variants pv on pv.id = l.variant_id
    join product_templates pt on pt.id = pv.template_id and pt.type = 'goods'
    where b.sendung_id = s.id
  )
  select coalesce(sum(pos.qty * pos.weight_g) filter (where not pos.d_klausel), 0) / 1000.0,
         coalesce(sum(pos.ware_eur) filter (where not pos.ddp), 0),
         coalesce(sum(pos.ware_eur * pos.satz / 100) filter (where not pos.ddp and pos.satz is not null), 0),
         count(*) filter (where not pos.ddp and pos.satz is null)
    into v_kg, v_ware, v_zoll, v_ohne_satz
  from pos;

  v_kg_quelle := 'Artikelgewichte';
  if coalesce(s.gewicht_kg, 0) > 0 then
    v_kg := s.gewicht_kg;
    v_kg_quelle := 'Sendungsgewicht';
  end if;

  if v_satz.modus is not null and v_kg > 0 then
    v_fracht := round(greatest(v_kg * v_satz.eur_je_kg, v_satz.mindestbetrag_eur), 2);
    art := 'fracht';
    betrag := v_fracht;
    grundlage := format('%s kg (%s) × %s €/kg %s, mindestens %s €',
                        zahl_text(round(v_kg, 1)), v_kg_quelle,
                        zahl_text(v_satz.eur_je_kg, 2),
                        case s.modus when 'see' then 'See' when 'luft' then 'Luft' else 'Express' end,
                        zahl_text(v_satz.mindestbetrag_eur, 2));
    return next;
  end if;

  if v_zoll > 0 then
    art := 'zoll';
    betrag := round(v_zoll * (1 + coalesce(v_fracht, 0) / nullif(v_ware, 0)), 2);
    grundlage := format('Zollwert ≈ Ware %s € + Fracht, Sätze je HS-Präfix%s',
                        zahl_text(v_ware, 2),
                        case when v_ohne_satz > 0 then format(' — %s ohne Zollsatz', plural_text(v_ohne_satz, 'Position', 'Positionen')) else '' end);
    return next;
  end if;
end $$;
