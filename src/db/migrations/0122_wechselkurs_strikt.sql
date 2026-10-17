-- ============================================================================
-- 0122 — Fehlender Wechselkurs rechnet nicht mehr still 1:1 (UX-Audit,
-- Entscheidungslog 2026-10-17)
--
-- exchange_rate_at fällt ohne Kurs auf 1 zurück. An den Stellen, an denen ein
-- Betrag dauerhaft in Euro festgeschrieben wird, ist das ein stiller Fehler
-- (CHF/GBP als Euro bewertet): Kurs beim Bestätigen einer Bestellung
-- (Einstand, Bewertung), Zahlungen in Fremdwährung, Nebenkosten (TS).
--
--  * exchange_rate_kurs(währung, datum)   — Kurs oder NULL (Anzeige)
--  * exchange_rate_strikt(währung, datum) — Kurs oder Fehler mit Hinweis
--  * confirm_purchase_order, zahlung_erfassen: voller Körper aus 0092/0115,
--    nur die Kurszeile ist strikt. Prognosen/Anzeigen behalten
--    exchange_rate_at (Schätzwerte); einstand_schaetzen und sendung_abrechnen
--    prüften schon selbst.
-- ============================================================================

create or replace function exchange_rate_kurs(p_currency text, p_date date default current_date)
returns numeric
language sql stable as $$
  select case
    when p_currency is null or p_currency = 'EUR' then 1::numeric
    else (select rate from exchange_rates
          where currency = p_currency and valid_from <= p_date
          order by valid_from desc limit 1)
  end;
$$;

create or replace function exchange_rate_strikt(p_currency text, p_date date default current_date)
returns numeric
language plpgsql stable as $$
declare
  v_kurs numeric := exchange_rate_kurs(p_currency, p_date);
begin
  if v_kurs is null then
    raise exception 'Kein Wechselkurs für % hinterlegt (Stand %) — bitte unter Einkauf → Kurse die EZB-Kurse holen oder einen Kurs erfassen', p_currency, to_char(p_date, 'DD.MM.YYYY');
  end if;
  return v_kurs;
end $$;

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
  -- Seit 0122 strikt: ohne hinterlegten Kurs keine Bestätigung (vorher still 1:1).
  v_rate := case when o.exchange_rate <> 1 then o.exchange_rate
                 else exchange_rate_strikt(o.currency, current_date) end;
  update purchase_orders set exchange_rate = v_rate where id = p_order;

  select * into v_op from operation_types where kind = 'receipt' and active limit 1;

  for l in
    select pol.*, pt.uom_id as stock_uom, pt.type as produkt_typ
    from purchase_order_lines pol
    join product_variants pv on pv.id = pol.variant_id
    join product_templates pt on pt.id = pv.template_id
    where pol.order_id = p_order
  loop
    select greatest(v_lead, coalesce(max(vp.lead_time_days), 0)) into v_lead
    from vendor_prices vp
    join product_variants pv on pv.id = l.variant_id and pv.template_id = vp.template_id
    where vp.vendor_id = o.vendor_id;

    -- Dienstleistungen kommen nicht ins Lager.
    continue when l.produkt_typ <> 'goods';

    if v_picking is null then
      insert into stock_pickings (
        number, operation_type_id, state, partner_id, scheduled_date,
        origin_model, origin_id, origin_label)
      values (
        next_sequence(v_op.sequence_code), v_op.id, 'draft', o.vendor_id, now(),
        'purchase_order', o.id, o.number)
      returning id into v_picking;
    end if;

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
  end loop;

  if v_picking is not null then
    perform picking_confirm(v_picking);
  end if;

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
  perform log_event('purchase_order', p_order, 'state',
    case when v_picking is null then 'Bestellung bestätigt (nur Dienstleistungen, kein Wareneingang)'
         else 'Bestellung bestätigt' end, p_actor);
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
      format('Zahlung %s € erfasst, offen: %s €', round(p_betrag * v_kurs, 2), vendor_bill_offen(p_ref)),
      p_actor);
  elsif p_quelle = 'po_rate' then
    update zahlplan_raten set bezahlt_am = p_datum where id = p_ref;
    perform log_event('purchase_order', v_rate.purchase_order_id, 'state',
      format('Zahlplan-Rate „%s" bezahlt (%s €)', v_rate.bezeichnung, round(p_betrag * v_kurs, 2)),
      p_actor);
  elsif p_quelle = 'vertrag' then
    perform log_event('vertrag', p_ref, 'state',
      format('Vertragszahlung %s € erfasst', round(p_betrag * v_kurs, 2)), p_actor);
  elsif p_quelle = 'kundenrechnung' then
    perform log_event('kundenrechnung', p_ref, 'note',
      format('%s %s € erfasst, offen: %s €', case p_richtung when 'ein' then 'Zahlung' else 'Erstattung' end,
             round(p_betrag * v_kurs, 2), kundenrechnung_offen(p_ref)), p_actor);
    if kundenrechnung_offen(p_ref) <= 0 then
      perform kundenrechnung_zahlen(p_ref, p_datum, case when p_bankkonto is not null then 'Überweisung' end, p_actor);
    end if;
  end if;

  return v_id;
end $$;
