-- ============================================================================
-- 0127 — Deutsche Zahlen in Verlauf und Grundlagen (F2, UX-Audit,
-- Entscheidungslog 2026-10-17)
--
-- format('%s', numeric) und to_char(…, 'G/D') schrieben „1.0000 ×",
-- „Zahlung 35.70 € erfasst", „Zins 469.61", „25.0 kg … 300.00 €" — abhängig
-- von Skala und lc_numeric. Neu: zahl_text(wert, stellen) — Tausenderpunkt,
-- Dezimalkomma, ohne Stellenangabe ohne überflüssige Nullen (trim_scale).
-- Geld weiter über money_text (0021).
--
--  * zahl_text (neu)
--  * volle Körper, nur die Textausgaben geändert: mo_produce (0021),
--    orderpoint_execute (0054, Signatur mit p_qty), darlehen_rate_zahlen (0060),
--    eingangs_sendung_schaetzung (0108), eingangs_sendung_verteilen (0108),
--    sendung_kosten_stornieren (0108), purchase_order_approve (0056),
--    zahlplan_pruefen (0058), retoure_pruefen (0119), zahlung_erfassen (0122)
-- ============================================================================

create or replace function zahl_text(p_wert numeric, p_stellen int default null) returns text
language sql immutable as $$
  select case when p_wert is null then null else
           case when x.v < 0 then '-' else '' end
           || regexp_replace(split_part(abs(x.v)::text, '.', 1), '(\d)(?=(\d{3})+$)', '\1.', 'g')
           || case when position('.' in abs(x.v)::text) > 0 then ',' || split_part(abs(x.v)::text, '.', 2) else '' end
         end
  from (select case when p_stellen is null then trim_scale(p_wert) else round(p_wert, p_stellen) end as v) x;
$$;

comment on function zahl_text(numeric, int) is
  'Zahl deutsch für Texte (0127): 1.234,5 — ohne p_stellen ohne überflüssige Nullen, sonst mit fester Stellenzahl. Geld: money_text.';


create or replace function mo_produce(
  p_mo uuid,
  p_qty numeric default null,
  p_consumed jsonb default '{}'::jsonb,
  p_create_backorder boolean default true,
  p_actor text default 'system',
  p_lot text default null
) returns uuid
language plpgsql as $$
declare
  mo manufacturing_orders%rowtype;
  v_bom boms%rowtype;
  v_qty numeric;
  v_factor numeric;
  v_expected numeric;
  v_actual numeric;
  m stock_moves%rowtype;
  v_stock uuid;
  v_production uuid;
  v_finished uuid;
  v_backorder uuid;
  v_remaining numeric;
  v_tracking text;
  v_lot uuid;
  v_material numeric;
  v_labor numeric;
  v_unit numeric;
begin
  select * into mo from manufacturing_orders where id = p_mo for update;
  if mo.id is null then raise exception 'Fertigungsauftrag nicht gefunden'; end if;
  if mo.state in ('done', 'cancel') then
    raise exception 'Fertigungsauftrag % ist bereits abgeschlossen oder storniert', mo.number;
  end if;

  v_qty := coalesce(p_qty, mo.qty_to_produce - mo.qty_produced);
  if v_qty <= 0 then raise exception 'Produzierte Menge muss größer als 0 sein'; end if;
  if v_qty > mo.qty_to_produce - mo.qty_produced then
    raise exception 'Produzierte Menge (%) übersteigt die offene Menge (%)',
      v_qty, mo.qty_to_produce - mo.qty_produced;
  end if;

  v_tracking := product_tracking(mo.variant_id);
  if p_lot is not null and v_tracking = 'serial' and v_qty <> 1 then
    raise exception 'Eine Seriennummer gilt für genau 1 Stück — bitte einzeln fertig melden';
  end if;

  select * into v_bom from boms where id = mo.bom_id;
  select id into v_stock from stock_locations where full_path = 'WH/Stock';
  select id into v_production from stock_locations where type = 'production' limit 1;

  -- Anteil dieser Teilproduktion an der Gesamtmenge des Auftrags
  v_factor := v_qty / mo.qty_to_produce;
  v_remaining := mo.qty_to_produce - mo.qty_produced - v_qty;

  -- Komponenten verbrauchen
  for m in select * from stock_moves where production_id = p_mo and state not in ('done', 'cancel') loop
    v_expected := round(m.qty * v_factor, 4);

    -- Manuelle Positionen brauchen eine Eingabe; Backflush-Positionen (billige
    -- Massenteile) werden im Sollverhältnis automatisch verbraucht.
    if m.issue_method = 'manual' and not (p_consumed ? m.id::text) then
      raise exception 'Für % muss der Verbrauch erfasst werden (Verbrauchsart „manuell")',
        variant_display_name(m.variant_id);
    end if;

    v_actual := coalesce((p_consumed ->> m.id::text)::numeric, v_expected);

    if v_actual <> v_expected then
      if v_bom.consumption = 'blocked' then
        raise exception 'Abweichender Verbrauch ist für diese Stückliste gesperrt (Soll %, Ist %)',
          zahl_text(v_expected), zahl_text(v_actual);
      elsif v_bom.consumption = 'warning' then
        perform log_event('manufacturing_order', p_mo, 'note',
          format('Abweichender Verbrauch bei %s: Soll %s, Ist %s',
                 variant_display_name(m.variant_id), zahl_text(v_expected), zahl_text(v_actual)), p_actor);
      end if;
    end if;

    if v_remaining > 0 and p_create_backorder then
      -- Restbedarf bleibt für den Rückstands-Auftrag stehen: aktuelle Bewegung
      -- auf die Ist-Menge kürzen und den Rest in eine neue Bewegung übernehmen.
      update stock_moves set qty = v_actual where id = m.id;
    end if;

    if v_actual > 0 then
      perform move_done(m.id, v_actual);
    else
      perform move_cancel(m.id);
    end if;
  end loop;

  -- Arbeitsgänge abschließen und Kosten zusammenziehen.
  perform mo_operations_finalize(p_mo, v_factor, p_actor);
  v_labor := mo_labor_cost(p_mo);

  select coalesce(-sum(l.value), 0) into v_material
  from stock_valuation_layers l
  join stock_moves sm on sm.id = l.move_id
  where sm.production_id = p_mo and sm.reference = 'Komponentenverbrauch';

  -- Herstellkosten je Stück; ohne Material und Lohn bleibt die Bewertung beim
  -- hinterlegten Einstandspreis (NULL = valuation_apply entscheidet).
  v_unit := case when v_material + v_labor > 0
                 then round((v_material + v_labor) / v_qty, 6) end;

  -- Fertigprodukt zubuchen
  insert into stock_moves (
    production_id, variant_id, uom_id, qty, src_location_id, dest_location_id,
    state, reference, unit_cost)
  values (p_mo, mo.variant_id, mo.uom_id, v_qty, v_production, v_stock,
          'confirmed', 'Fertigmeldung', v_unit)
  returning id into v_finished;

  -- Gewünschte Losnummer setzen (sonst legt move_done automatisch an).
  if p_lot is not null and v_tracking <> 'none' then
    v_lot := ensure_lot(mo.variant_id, p_lot);
    insert into move_lot_assignments (move_id, lot_id, qty)
    values (v_finished, v_lot, v_qty)
    on conflict (move_id, lot_id) do update set qty = excluded.qty;
  end if;

  perform move_done(v_finished, v_qty);

  if v_tracking <> 'none' and v_lot is null then
    select lot_id into v_lot from move_lot_assignments
    where move_id = v_finished order by qty desc limit 1;
  end if;

  update manufacturing_orders
    set qty_produced = qty_produced + v_qty,
        state = 'done',
        date_done = now(),
        finished_move_id = v_finished,
        lot_producing_id = coalesce(v_lot, lot_producing_id),
        material_cost = v_material,
        labor_cost = v_labor,
        unit_cost = v_unit
  where id = p_mo;

  if v_material + v_labor > 0 then
    perform log_event('manufacturing_order', p_mo, 'note',
      format('Herstellkosten: Material %s + Lohn %s = %s je Stück',
             money_text(round(v_material, 2)), money_text(round(v_labor, 2)),
             money_text(round(v_unit, 2))), p_actor);
  end if;

  -- Rückstand für die Restmenge
  if v_remaining > 0 and p_create_backorder then
    v_backorder := create_manufacturing_order(
      mo.variant_id, v_remaining, mo.sales_order_id, mo.scheduled_date, p_actor);
    update manufacturing_orders set backorder_of_id = p_mo where id = v_backorder;
    perform mo_confirm(v_backorder, p_actor);
    perform log_event('manufacturing_order', p_mo, 'state',
      'Teilmenge gefertigt, Rückstand: ' ||
      (select number from manufacturing_orders where id = v_backorder), p_actor);
  else
    perform log_event('manufacturing_order', p_mo, 'state',
      format('Fertig gemeldet: %s', zahl_text(v_qty)), p_actor);
  end if;

  -- Sind alle Fertigungsaufträge des Verkaufsauftrags erledigt, ist die
  -- Lieferung versandbereit -> reservieren.
  if mo.sales_order_id is not null then
    if not exists (
      select 1 from manufacturing_orders
      where sales_order_id = mo.sales_order_id and state not in ('done', 'cancel')
    ) then
      perform picking_check_availability(p.id)
      from stock_pickings p
      where p.origin_model = 'sales_order' and p.origin_id = mo.sales_order_id
        and p.state not in ('done', 'cancel');
      perform log_event('sales_order', mo.sales_order_id, 'state',
        'Alle Fertigungsaufträge erledigt - Lieferung ist versandbereit', p_actor);
      perform sales_order_recompute_status(mo.sales_order_id);
    end if;
  end if;

  return v_backorder;
end $$;


create or replace function orderpoint_execute(p_orderpoint uuid, p_actor text default 'system',
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
    format('Position aus Meldebestand: %s × %s', zahl_text(v_qty), s.product), p_actor);
  return v_po_number;
end $$;


create or replace function darlehen_rate_zahlen(
  p_rate uuid,
  p_datum date default current_date,
  p_bankkonto uuid default null,
  p_actor text default 'system'
) returns void
language plpgsql as $$
declare
  r darlehen_raten;
  d darlehen;
  z uuid;
begin
  select * into r from darlehen_raten where id = p_rate;
  if r.id is null then raise exception 'Unbekannte Darlehensrate'; end if;
  if r.bezahlt_am is not null then raise exception 'Die Rate ist bereits bezahlt'; end if;
  select * into d from darlehen where id = r.darlehen_id;
  if r.zins + r.tilgung > 0 then
    z := zahlung_erfassen('aus', r.zins + r.tilgung, 'EUR', p_datum,
                          coalesce(p_bankkonto, d.bankkonto_id), 'manuell', null,
                          format('%s — Rate %s (Zins %s, Tilgung %s)', d.nummer, r.nr, money_text(r.zins), money_text(r.tilgung)),
                          p_actor);
    update zahlungen set quelle = 'darlehen_rate', darlehen_rate_id = p_rate,
                         darlehen_id = d.id, partner_id = d.partner_id
    where id = z;
  end if;
  update darlehen_raten set bezahlt_am = p_datum where id = p_rate;
  if not exists (select 1 from darlehen_raten
                 where darlehen_id = d.id and bezahlt_am is null) then
    update darlehen set status = 'getilgt' where id = d.id;
    perform log_event('darlehen', d.id, 'state', 'Vollständig getilgt', p_actor);
  end if;
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
                        case when v_ohne_satz > 0 then format(' — %s Position(en) ohne Zollsatz', v_ohne_satz) else '' end);
    return next;
  end if;
end $$;


create or replace function retoure_pruefen(p_id uuid, p_ergebnisse jsonb, p_actor text default 'system')
returns uuid
language plpgsql
set search_path = public, pg_temp as $$
declare
  r          retouren%rowtype;
  v_op       operation_types%rowtype;
  v_kunden   uuid;
  v_lager    uuid;
  v_bware    uuid;
  v_picking  uuid;
  v_ergebnis text;
  v_fehlend  int;
  pos        record;
begin
  select * into r from retouren where id = p_id for update;
  if r.id is null then raise exception 'Retoure nicht gefunden'; end if;
  if r.status <> 'eingegangen' then
    raise exception 'Retoure % steht auf „%" — geprüft wird nach dem Eingang', r.nummer, r.status;
  end if;

  update retoure_positionen rp
     set pruefung = e ->> 'pruefung', pruef_notiz = nullif(trim(coalesce(e ->> 'notiz', '')), '')
    from jsonb_array_elements(coalesce(p_ergebnisse, '[]'::jsonb)) e
   where rp.retoure_id = p_id and rp.id = (e ->> 'position')::uuid
     and e ->> 'pruefung' in ('verkaufsfaehig', 'bware', 'defekt');
  select count(*) into v_fehlend from retoure_positionen where retoure_id = p_id and pruefung is null;
  if v_fehlend > 0 then raise exception 'Bitte jede Position prüfen (% ohne Ergebnis)', v_fehlend; end if;

  select * into v_op from operation_types where kind = 'receipt' and active order by created_at limit 1;
  select id into v_kunden from stock_locations where full_path = 'Partner/Kunden';
  select id into v_lager from stock_locations where full_path = 'WH/Stock';
  select id into v_bware from stock_locations where barcode = 'LOC-WH-BWARE';

  insert into stock_pickings (number, operation_type_id, state, partner_id, scheduled_date,
                              origin_model, origin_id, origin_label, return_of_id, note)
  values (next_sequence(v_op.sequence_code), v_op.id, 'draft', r.partner_id, now(),
          'retoure', r.id, r.nummer,
          (select p.id from stock_pickings p join operation_types ot on ot.id = p.operation_type_id and ot.kind = 'delivery'
           where p.origin_model = 'sales_order' and p.origin_id = r.sales_order_id and p.state = 'done'
           order by p.date_done desc nulls last limit 1),
          'Rücksendung ' || r.nummer)
  returning id into v_picking;

  for pos in
    select rp.*, pt.uom_id from retoure_positionen rp
    join product_variants pv on pv.id = rp.variant_id
    join product_templates pt on pt.id = pv.template_id
    where rp.retoure_id = p_id order by rp.sequence
  loop
    insert into stock_moves (picking_id, variant_id, uom_id, qty, src_location_id, dest_location_id, state, reference)
    values (v_picking, pos.variant_id, pos.uom_id, pos.menge, v_kunden,
            case when pos.pruefung = 'verkaufsfaehig' then v_lager else v_bware end, 'draft',
            r.nummer || ' — ' || case pos.pruefung when 'verkaufsfaehig' then 'verkaufsfähig' when 'bware' then 'B-Ware' else 'defekt' end);
  end loop;
  perform picking_confirm(v_picking);
  perform picking_validate(v_picking, '{}'::jsonb, false);
  -- Die Live-Reservierung (0086) läuft sonst erst am Transaktionsende — der
  -- Abschluss in derselben Transaktion (Shop hat schon erstattet) muss die
  -- jetzt gedeckten Lieferungen aber schon sehen.
  for pos in select distinct variant_id from retoure_positionen where retoure_id = p_id and pruefung = 'verkaufsfaehig' loop
    perform wartende_bewegungen_reservieren(pos.variant_id, v_lager);
  end loop;

  update retouren set picking_id = v_picking where id = p_id;
  select string_agg(format('%s × %s %s', zahl_text(rp.menge), rp.bezeichnung,
           case rp.pruefung when 'verkaufsfaehig' then 'verkaufsfähig → Lager' when 'bware' then 'B-Ware' else 'defekt → B-Ware' end), '; ' order by rp.sequence)
    into v_ergebnis from retoure_positionen rp where rp.retoure_id = p_id;
  perform retoure_status_setzen(p_id, '{eingegangen}', 'geprueft', 'Geprüft und zurückgebucht: ' || v_ergebnis, p_actor);
  perform log_event('sales_order', r.sales_order_id, 'note', format('Retoure %s geprüft: %s', r.nummer, v_ergebnis), p_actor);

  if r.erstattet_am is not null then
    perform retoure_abschliessen(p_id, p_actor);
  end if;
  return v_picking;
end $$;


create or replace function zahlung_erfassen(
  p_richtung text,
  p_betrag numeric,
  p_waehrung text default 'EUR',
  p_datum date default current_date,
  p_bankkonto uuid default null,
  p_quelle text default 'manuell',
  p_ref uuid default null,
  p_zweck text default null,
  p_actor text default 'system'
) returns uuid
language plpgsql as $$
declare
  v_id uuid;
  v_kurs numeric;
  v_partner uuid;
  v_bill vendor_bills;
  v_rate zahlplan_raten;
  v_vertrag vertraege;
  v_kr kundenrechnungen;
  v_offen numeric;
begin
  if p_betrag is null or p_betrag <= 0 then
    raise exception 'Der Zahlungsbetrag muss größer als null sein';
  end if;
  if p_richtung not in ('ein', 'aus') then
    raise exception 'Unbekannte Zahlungsrichtung: %', p_richtung;
  end if;

  -- Seit 0122 strikt: ohne Kurs keine Zahlung in Fremdwährung (vorher still 1:1).
  v_kurs := exchange_rate_strikt(p_waehrung, p_datum);

  if p_quelle = 'vendor_bill' then
    select * into v_bill from vendor_bills where id = p_ref;
    if v_bill.id is null then raise exception 'Unbekannte Rechnung'; end if;
    if v_bill.state not in ('posted', 'paid') then
      raise exception 'Zahlungen sind erst auf gebuchte Rechnungen möglich (Status: %)', v_bill.state;
    end if;
    v_offen := vendor_bill_offen(p_ref);
    if v_offen <= 0 then
      raise exception 'Die Rechnung % ist bereits vollständig gedeckt', v_bill.number;
    end if;
    v_partner := v_bill.vendor_id;
  elsif p_quelle = 'po_rate' then
    select * into v_rate from zahlplan_raten where id = p_ref;
    if v_rate.id is null then raise exception 'Unbekannte Zahlplan-Rate'; end if;
    if v_rate.bezahlt_am is not null then
      raise exception 'Die Rate „%" ist bereits bezahlt', v_rate.bezeichnung;
    end if;
    select vendor_id into v_partner from purchase_orders where id = v_rate.purchase_order_id;
  elsif p_quelle = 'vertrag' then
    select * into v_vertrag from vertraege where id = p_ref;
    if v_vertrag.id is null then raise exception 'Unbekannter Vertrag'; end if;
    v_partner := v_vertrag.partner_id;
  elsif p_quelle = 'kundenrechnung' then
    select * into v_kr from kundenrechnungen where id = p_ref;
    if v_kr.id is null then raise exception 'Unbekannte Kundenrechnung'; end if;
    if v_kr.status = 'storniert' then raise exception 'Der Beleg % ist storniert', v_kr.nummer; end if;
    if (v_kr.art = 'rechnung' and p_richtung <> 'ein') or (v_kr.art = 'gutschrift' and p_richtung <> 'aus') then
      raise exception 'Auf eine Rechnung wird eingezahlt, auf eine Gutschrift erstattet';
    end if;
    if kundenrechnung_offen(p_ref) <= 0 then
      raise exception 'Der Beleg % ist bereits vollständig beglichen', v_kr.nummer;
    end if;
    v_partner := v_kr.partner_id;
  elsif p_quelle <> 'manuell' then
    raise exception 'Unbekannte Zahlungsquelle: %', p_quelle;
  end if;

  insert into zahlungen (nummer, richtung, betrag, waehrung, kurs, betrag_eur,
                         gezahlt_am, bankkonto_id, quelle,
                         vendor_bill_id, zahlplan_rate_id, vertrag_id, kundenrechnung_id,
                         partner_id, verwendungszweck)
  values (next_sequence('zahlung'), p_richtung, p_betrag, p_waehrung, v_kurs,
          round(p_betrag * v_kurs, 2), p_datum, p_bankkonto, p_quelle,
          case when p_quelle = 'vendor_bill' then p_ref end,
          case when p_quelle = 'po_rate' then p_ref end,
          case when p_quelle = 'vertrag' then p_ref end,
          case when p_quelle = 'kundenrechnung' then p_ref end,
          v_partner, p_zweck)
  returning id into v_id;

  if p_quelle = 'vendor_bill' then
    if vendor_bill_offen(p_ref) <= 0 and v_bill.state = 'posted' then
      update vendor_bills set state = 'paid', paid_at = p_datum::timestamptz where id = p_ref;
    end if;
    perform log_event('vendor_bill', p_ref, 'state',
      format('Zahlung %s erfasst, offen: %s', money_text(round(p_betrag * v_kurs, 2)), money_text(vendor_bill_offen(p_ref))),
      p_actor);
  elsif p_quelle = 'po_rate' then
    update zahlplan_raten set bezahlt_am = p_datum where id = p_ref;
    perform log_event('purchase_order', v_rate.purchase_order_id, 'state',
      format('Zahlplan-Rate „%s" bezahlt (%s)', v_rate.bezeichnung, money_text(round(p_betrag * v_kurs, 2))),
      p_actor);
  elsif p_quelle = 'vertrag' then
    perform log_event('vertrag', p_ref, 'state',
      format('Vertragszahlung %s erfasst', money_text(round(p_betrag * v_kurs, 2))), p_actor);
  elsif p_quelle = 'kundenrechnung' then
    perform log_event('kundenrechnung', p_ref, 'note',
      format('%s %s erfasst, offen: %s', case p_richtung when 'ein' then 'Zahlung' else 'Erstattung' end,
             money_text(round(p_betrag * v_kurs, 2)), money_text(kundenrechnung_offen(p_ref))), p_actor);
    if kundenrechnung_offen(p_ref) <= 0 then
      perform kundenrechnung_zahlen(p_ref, p_datum, case when p_bankkonto is not null then 'Überweisung' end, p_actor);
    end if;
  end if;

  return v_id;
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
      format('%s %s %s%s verteilt auf %s Wareneingang/-eingänge (nach %s)%s',
             eingangs_sendung_kostenart_text(k.art),
             zahl_text(k.betrag, 2), k.waehrung,
             case when k.schaetzung then ' (Schätzung)' else '' end,
             v_n, case when v_nach_gewicht then 'Gewicht' else 'Warenwert' end,
             case when v_storniert > 0 then format(' — Korrektur: %s Nebenkostenbeleg(e) der Schätzung storniert', v_storniert)
                  else '' end),
      p_actor);
  end loop;
  return v_gebucht;
end $$;


create or replace function sendung_kosten_stornieren(p_kosten uuid, p_actor text default 'system')
returns void
language plpgsql
set search_path = public, pg_temp as $$
declare
  k sendung_kosten%rowtype;
  lc record;
  v_nummer text;
begin
  select * into k from sendung_kosten where id = p_kosten for update;
  if k.id is null then raise exception 'Kostenposition nicht gefunden'; end if;
  if k.storniert_am is not null then raise exception 'Die Kostenposition ist schon storniert'; end if;

  for lc in select id from landed_costs where sendung_kosten_id = k.id and state = 'posted' loop
    perform landed_cost_cancel(lc.id, p_actor);
  end loop;
  update sendung_kosten set storniert_am = now() where id = k.id;

  update sendung_kosten e set
    ersetzt_durch_id = null,
    verteilt_am = case when exists (select 1 from landed_costs l where l.sendung_kosten_id = e.id and l.state = 'posted')
                       then e.verteilt_am end
  where e.ersetzt_durch_id = k.id;

  select nummer into v_nummer from eingangs_sendungen where id = k.sendung_id;
  perform log_event('eingangs_sendung', k.sendung_id, 'info',
    format('%s %s %s%s storniert', eingangs_sendung_kostenart_text(k.art), zahl_text(k.betrag, 2), k.waehrung,
           case when k.schaetzung then ' (Schätzung)' else '' end), p_actor);
end $$;


create or replace function purchase_order_approve(p_order uuid, p_actor text default 'system')
returns void
language plpgsql as $$
declare
  o record;
begin
  select po.*, t.net into o
  from purchase_orders po
  cross join lateral purchase_order_total(po.id) t
  where po.id = p_order;
  if o.id is null then raise exception 'Bestellung nicht gefunden'; end if;
  if o.state not in ('draft', 'sent') then
    raise exception 'Nur offene Bestellungen (Entwurf/Angefragt) lassen sich freigeben';
  end if;
  if o.freigegeben_am is not null then
    raise exception 'Bereits freigegeben von % am %', o.freigegeben_von, o.freigegeben_am::date;
  end if;

  update purchase_orders
  set freigegeben_von = p_actor, freigegeben_am = now()
  where id = p_order;
  perform log_event('purchase_order', p_order, 'state',
    format('Bestellung freigegeben (Summe %s netto)', money_text(o.net)), p_actor);
end $$;


create or replace function zahlplan_pruefen(p_order uuid)
returns text
language plpgsql stable as $$
declare
  v_summe numeric;
  v_gross numeric;
begin
  select coalesce(sum(zahlplan_betrag(r)), 0) into v_summe
  from zahlplan_raten r where r.purchase_order_id = p_order;
  select round(t.gross * coalesce(po.exchange_rate, 1), 2) into v_gross
  from purchase_orders po, purchase_order_total(po.id) t where po.id = p_order;
  if v_summe > v_gross + 0.01 then
    return format('Zahlplan-Summe %s liegt über dem Bestellbrutto %s.', money_text(v_summe), money_text(v_gross));
  end if;
  return null;
end $$;
