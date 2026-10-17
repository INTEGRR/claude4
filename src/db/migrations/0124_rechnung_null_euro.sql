-- ============================================================================
-- 0124 — Rechnung über 0,00 € ist ausgeglichen (UX-Audit, Entscheidungslog
-- 2026-10-17)
--
-- kundenrechnung_aus_lieferung legte auch bei 0 € Gesamtbetrag (Garantie,
-- Ersatzteil zum Nulltarif) eine „offene" Rechnung an; nichts schloss sie, und
-- sie war mahnbar. Jetzt: 0 € → sofort bezahlt (ausgeglichen); gemahnt wird
-- nur mit offenem Betrag. Bestehende 0-€-Rechnungen bleiben unangetastet
-- (keine Datenänderung im Betrieb per Migration) — von Hand als bezahlt markieren.
--
--  * kundenrechnung_aus_lieferung (voller Körper aus 0117), kundenrechnung_mahnen (aus 0115)
-- ============================================================================

create or replace function kundenrechnung_aus_lieferung(p_picking uuid, p_actor text default 'system')
returns uuid
language plpgsql
set search_path = public, pg_temp as $$
declare
  p          stock_pickings%rowtype;
  o          sales_orders%rowtype;
  k          partners%rowtype;
  v_kind     text;
  v_einst    jsonb;
  v_probe    boolean := rechnung_modus() = 'test';
  v_id       uuid;
  v_nr       text;
  v_datum    date := current_date;
  v_faellig  date;
  v_anschrift jsonb;
  v_ansprech text;
  v_kundennr text;
  v_seq      int := 10;
  v_netto    numeric;
  v_steuer   numeric;
  v_rate     numeric;
  v_zeilen   int := 0;
  m          record;
begin
  select * into p from stock_pickings where id = p_picking for update;
  if p.id is null then raise exception 'Lieferung nicht gefunden'; end if;
  if p.origin_model <> 'sales_order' then
    raise exception 'Nur Lieferungen zu Verkaufsaufträgen werden abgerechnet';
  end if;
  select ot.kind::text into v_kind from operation_types ot where ot.id = p.operation_type_id;
  if v_kind <> 'delivery' then raise exception 'Nur Warenausgänge werden abgerechnet'; end if;
  if p.state <> 'done' then raise exception 'Die Lieferung % ist noch nicht gebucht', p.number; end if;
  if exists (select 1 from kundenrechnungen
             where picking_id = p.id and art = 'rechnung' and status <> 'storniert' and probe = v_probe) then
    raise exception 'Die Lieferung % ist bereits abgerechnet', p.number;
  end if;

  select * into o from sales_orders where id = p.origin_id;
  select * into k from partners where id = o.partner_id;
  select coalesce(value, '{}'::jsonb) into v_einst from settings where key = 'rechnung';

  -- Anschrift: Rechnungsanschrift des Shops, sonst Lieferadresse des Auftrags, sonst Kundenstamm.
  if o.rechnungsanschrift is not null and coalesce(o.rechnungsanschrift ->> 'name', '') <> '' then
    v_anschrift := o.rechnungsanschrift;
  elsif o.ship_name is not null then
    v_anschrift := jsonb_build_object(
      'name', o.ship_name, 'street', o.ship_street, 'house', o.ship_house_number, 'street2', o.ship_street2,
      'zip', o.ship_zip, 'city', o.ship_city, 'country', o.ship_country_code,
      'email', coalesce(o.ship_email, k.email), 'vat', k.vat);
  else
    v_anschrift := jsonb_build_object(
      'name', k.name, 'street', k.street, 'house', k.house_number, 'street2', k.street2,
      'zip', k.zip, 'city', k.city, 'country', k.country_code, 'email', k.email, 'vat', k.vat);
  end if;
  v_kundennr := coalesce(nullif(k.ref, ''), nullif(regexp_replace(coalesce(k.shopify_customer_id, ''), '\D', '', 'g'), ''));
  select u.name into v_ansprech from users u where u.id = o.user_id;
  v_faellig := coalesce(
    payment_term_due_date(coalesce(o.payment_term_id, k.customer_payment_term_id), v_datum),
    v_datum + coalesce((v_einst ->> 'zahlungsziel_tage')::int, 14));

  v_nr := next_sequence(case when v_probe then 'kundenrechnung_probe' else 'kundenrechnung' end);
  insert into kundenrechnungen (
    nummer, art, status, sales_order_id, partner_id, picking_id, rechnungsdatum, leistungsdatum,
    faellig_am, zahlungsart, waehrung, anschrift, kundennummer, kundenreferenz, ansprechpartner, probe)
  values (
    v_nr, 'rechnung', 'offen', o.id, o.partner_id, p.id, v_datum, coalesce(p.date_done::date, v_datum),
    v_faellig, case when o.source = 'shopify' then coalesce(o.zahlungsart, 'Shopify') else 'Überweisung' end,
    o.currency, v_anschrift, v_kundennr, coalesce(o.shopify_order_name, o.client_order_ref, o.number), v_ansprech, v_probe)
  returning id into v_id;

  -- Positionen: gelieferte Menge je Variante (mehrere Bewegungen derselben
  -- Variante — etwa nach einer Bestelländerung — werden EINE Rechnungszeile)
  -- × Preis der Auftragszeile (erste Zeile der Variante).
  for m in
    select g.variant_id, g.qty_done, l.id as line_id, l.name, l.price_unit, l.discount, l.tax_rate, l.listenpreis,
           coalesce(uo.name, 'Stk') as einheit, l.sequence as lseq
    from (
      select sm.variant_id, sm.uom_id, sum(sm.qty_done) as qty_done, min(sm.created_at) as erste
      from stock_moves sm
      where sm.picking_id = p.id and sm.state = 'done' and sm.qty_done > 0
      group by sm.variant_id, sm.uom_id
    ) g
    left join lateral (
      select l.* from sales_order_lines l
      where l.order_id = o.id and l.variant_id = g.variant_id
      order by l.sequence limit 1
    ) l on true
    left join uoms uo on uo.id = g.uom_id
    order by l.sequence nulls last, g.erste
  loop
    -- Bewegungen ohne Auftragszeile (Kit-Bestandteile) tragen keinen Preis — die Kit-Zeile selbst ist nicht lagergeführt.
    continue when m.line_id is null;
    v_netto  := round(m.qty_done * m.price_unit * (1 - coalesce(m.discount, 0) / 100.0), 2);
    v_steuer := round(v_netto * m.tax_rate / 100.0, 2);
    insert into kundenrechnung_positionen (
      rechnung_id, sequence, art, variant_id, sales_order_line_id, bezeichnung, menge, einheit,
      einzelpreis, listenpreis, rabatt_pct, steuersatz, netto, steuer, brutto)
    values (
      v_id, v_seq, 'position', m.variant_id, m.line_id, m.name, m.qty_done, m.einheit,
      m.price_unit, m.listenpreis, coalesce(m.discount, 0), m.tax_rate, v_netto, v_steuer, v_netto + v_steuer);
    update sales_order_lines set qty_invoiced = qty_invoiced + m.qty_done where id = m.line_id;
    v_seq := v_seq + 10;
    v_zeilen := v_zeilen + 1;
  end loop;

  if v_zeilen = 0 then
    raise exception 'Lieferung %: keine abrechenbare Position', p.number;
  end if;

  -- Versand: einmal je Auftrag, auf der ersten nicht stornierten Rechnung.
  if coalesce(o.versandkosten, 0) > 0 and not exists (
    select 1 from kundenrechnung_positionen kp
    join kundenrechnungen kr on kr.id = kp.rechnung_id
    where kr.sales_order_id = o.id and kr.id <> v_id and kr.art = 'rechnung' and kr.probe = v_probe
      and kr.status <> 'storniert' and kp.art = 'versand') then
    select coalesce(max(steuersatz), 19) into v_rate from kundenrechnung_positionen where rechnung_id = v_id;
    v_netto  := round(o.versandkosten, 2);
    v_steuer := round(v_netto * v_rate / 100.0, 2);
    insert into kundenrechnung_positionen (
      rechnung_id, sequence, art, bezeichnung, menge, einheit, einzelpreis, steuersatz, netto, steuer, brutto)
    values (v_id, v_seq, 'versand', 'Versand', 1, 'Stk', v_netto, v_rate, v_netto, v_steuer, v_netto + v_steuer);
  end if;

  perform kundenrechnung_summen(v_id);

  -- Shop-Aufträge sind bezahlt — der Shop hat das Geld vor dem Versand.
  if o.source = 'shopify' then
    update kundenrechnungen
       set status = 'bezahlt', bezahlt_am = o.order_date::date, faellig_am = v_datum
     where id = v_id;
  elsif (select brutto from kundenrechnungen where id = v_id) = 0 then
    -- 0124: eine Rechnung über 0,00 € ist ausgeglichen, nicht offen (sonst
    -- bliebe sie dauerhaft offen und wäre mahnbar).
    update kundenrechnungen
       set status = 'bezahlt', bezahlt_am = v_datum, faellig_am = v_datum
     where id = v_id;
  end if;

  perform sales_order_recompute_status(o.id);
  perform log_event('kundenrechnung', v_id, 'state',
    format('%s %s aus Lieferung %s erstellt', case when v_probe then 'Testrechnung (Probelauf)' else 'Rechnung' end, v_nr, p.number), p_actor);
  perform log_event('sales_order', o.id, 'note',
    format('%s %s erstellt (%s)', case when v_probe then 'Testrechnung' else 'Rechnung' end, v_nr, money_text((select brutto from kundenrechnungen where id = v_id))), p_actor);
  return v_id;
end $$;

create or replace function kundenrechnung_mahnen(p_id uuid, p_actor text default 'system')
returns int
language plpgsql
set search_path = public, pg_temp as $$
declare r kundenrechnungen%rowtype;
begin
  select * into r from kundenrechnungen where id = p_id for update;
  if r.id is null then raise exception 'Rechnung nicht gefunden'; end if;
  if r.art <> 'rechnung' or r.status <> 'offen' then raise exception 'Nur offene Rechnungen werden gemahnt'; end if;
  if kundenrechnung_offen(p_id) <= 0 then raise exception 'Die Rechnung % hat keinen offenen Betrag', r.nummer; end if;
  if r.faellig_am is null or r.faellig_am >= current_date then
    raise exception 'Die Rechnung % ist noch nicht fällig (fällig am %)', r.nummer, to_char(r.faellig_am, 'DD.MM.YYYY');
  end if;
  if r.mahnstufe >= 3 then raise exception 'Die Rechnung % hat die letzte Mahnstufe erreicht', r.nummer; end if;
  update kundenrechnungen set mahnstufe = mahnstufe + 1, gemahnt_am = current_date where id = p_id;
  perform log_event('kundenrechnung', p_id, 'note',
    format('%s erstellt', case r.mahnstufe + 1 when 1 then 'Zahlungserinnerung' when 2 then '1. Mahnung' else '2. Mahnung' end), p_actor);
  return r.mahnstufe + 1;
end $$;
