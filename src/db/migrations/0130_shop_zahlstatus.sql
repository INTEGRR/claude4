-- ============================================================================
-- 0130 — Shop-Rechnung bezahlt nur, wenn Shopify nichts mehr offen meldet
--        (Entscheidungslog 2026-10-17, Vorlage auftragsaenderung.md Punkt 3)
--
-- Bisher entstand jede Shop-Rechnung „bezahlt" („der Shop hat das Geld vor
-- dem Versand"). Nach einer Bestelländerung mit Aufpreis stimmt das nicht:
-- Shopify meldet PARTIALLY_PAID und einen offenen Betrag, bis der Kunde über
-- die Zahlungsaufforderung nachzahlt. Jetzt:
--   * sales_orders merkt sich Zahlstatus und offenen Betrag laut Shopify
--     (der Import schreibt beides; null = unbekannt → Verhalten wie bisher).
--   * kundenrechnungen.shop_offen = Restbetrag laut Shopify; der offene
--     Betrag (kundenrechnung_offen) ist dann dieser Rest abzüglich in KRNL
--     erfasster Zahlungen. Keine Schein-Zahlung im Register — das Geld, das
--     Shopify hat, ist kein Bankeingang.
--   * kundenrechnung_shop_abgleich verteilt den offenen Betrag auf die
--     offenen Shop-Rechnungen des Auftrags (neueste zuerst) und schließt,
--     was laut Shopify bezahlt ist.
-- Nur Erweiterungen (Expand) — nichts wird entfernt.
-- ============================================================================

alter table sales_orders add column shopify_zahlstatus text;
alter table sales_orders add column shopify_offen numeric(14,2);
comment on column sales_orders.shopify_zahlstatus is
  'Zahlstatus laut Shopify (displayFinancialStatus, z. B. PAID, PARTIALLY_PAID), vom Import geschrieben (0130).';
comment on column sales_orders.shopify_offen is
  'Offener Betrag laut Shopify (totalOutstandingSet); null = unbekannt (0130).';

alter table kundenrechnungen add column shop_offen numeric(14,2);
comment on column kundenrechnungen.shop_offen is
  'Restbetrag laut Shopify bei offenen Shop-Rechnungen (0130); null bei allen anderen.';

/** Offener Betrag: nichts mehr bei bezahlt/storniert, sonst brutto bzw. Shop-Rest abzüglich nicht stornierter Zahlungen. */
create or replace function kundenrechnung_offen(p_id uuid) returns numeric
language sql stable
set search_path = public, pg_temp as $$
  select case when k.status <> 'offen' then 0
         else greatest(0, round(least(k.brutto, coalesce(k.shop_offen, k.brutto)) - coalesce((
           select sum(z.betrag_eur) from zahlungen z
           where z.kundenrechnung_id = k.id and z.storniert_am is null
             and z.richtung = case k.art when 'rechnung' then 'ein' else 'aus' end), 0), 2))
         end
  from kundenrechnungen k where k.id = p_id;
$$;

-- Verteilt den offenen Betrag laut Shopify auf die offenen Shop-Rechnungen
-- des Auftrags (neueste zuerst — der Aufpreis gehört zur späteren Lieferung)
-- und schließt Rechnungen ohne Rest. Echte und Testbelege getrennt.
-- Rückgabe: Anzahl der dabei als bezahlt markierten Rechnungen.
create or replace function kundenrechnung_shop_abgleich(p_order uuid, p_actor text default 'system')
returns int
language plpgsql
set search_path = public, pg_temp as $$
declare
  o sales_orders%rowtype;
  r record;
  v_probe boolean;
  v_rest numeric;
  v_teil numeric;
  v_bezahlt int := 0;
begin
  select * into o from sales_orders where id = p_order;
  if o.id is null or o.source <> 'shopify' or o.shopify_offen is null then return 0; end if;
  foreach v_probe in array array[false, true] loop
    v_rest := greatest(0, o.shopify_offen);
    for r in
      select id, nummer, brutto, shop_offen from kundenrechnungen
      where sales_order_id = o.id and art = 'rechnung' and status = 'offen'
        and probe = v_probe and shop_offen is not null
      order by created_at desc, nummer desc
    loop
      v_teil := least(r.brutto, v_rest);
      v_rest := v_rest - v_teil;
      if v_teil <= 0 then
        perform kundenrechnung_zahlen(r.id, current_date, null, p_actor);
        v_bezahlt := v_bezahlt + 1;
      elsif v_teil is distinct from r.shop_offen then
        update kundenrechnungen set shop_offen = v_teil where id = r.id;
        perform log_event('kundenrechnung', r.id, 'note',
          format('Shopify meldet %s offen — Rechnung bleibt offen', money_text(v_teil)), p_actor);
      end if;
    end loop;
  end loop;
  return v_bezahlt;
end $$;

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

  -- Shop-Aufträge: bezahlt, wenn der Shop das Geld hat. 0130: meldet Shopify
  -- einen offenen Betrag (Aufpreis nach Bestelländerung, PARTIALLY_PAID),
  -- bleibt die Rechnung offen mit dem Restbetrag und regulärem Zahlungsziel.
  if o.source = 'shopify' and coalesce(o.shopify_offen, 0) > 0 then
    update kundenrechnungen set shop_offen = brutto where id = v_id;
    perform kundenrechnung_shop_abgleich(o.id, p_actor);
  elsif o.source = 'shopify' then
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

