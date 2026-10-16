-- ============================================================================
-- 0117 — Kundenrechnungen im Probelauf (Entscheidungslog 2026-10-16)
--
-- Die Rechnung aus KRNL ist ein heikles Thema: Nummernkreise sind lückenlos,
-- DATEV bekommt, was einmal da ist. Deshalb läuft die Rechnung erst im
-- PROBELAUF parallel zur Shopify-Rechnungs-App: Testrechnungen entstehen wie
-- echte (Lieferung, Gutschrift bei Shop-Änderung, Zahlung, Mahnstufe), tragen
-- aber probe = true und einen eigenen Nummernkreis (PROBE-RE-/PROBE-GU-),
-- stehen nicht in DATEV, nicht in den Fälligkeiten und nicht im Umsatz, und
-- lassen sich am Ende in einem Zug löschen (Nummernkreise der Probe zurück
-- auf 1, qty_invoiced neu gerechnet). Scharf geschaltet wird erst, wenn kein
-- Probelauf mehr in der Datenbank steht.
--
--  * settings.rechnung.modus: 'aus' | 'test' | 'scharf' — ersetzt
--    `automatisch` (bleibt als Spiegel: automatisch = modus <> 'aus');
--    bestehende Instanzen landen auf 'test' (bisher an) bzw. 'aus'.
--  * kundenrechnungen.probe, Nummernkreise kundenrechnung_probe/gutschrift_probe
--  * rechnung_modus(): die eine Leseweise des Modus (SQL und Code)
--  * kundenrechnung_aus_lieferung / _gutschrift: Probe vererbt, eigener Kreis
--  * finanz_faellig ohne Probe, Trigger fragt den Modus
--  * kundenrechnung_probelauf_loeschen(): Aufräumen vor dem Scharfschalten
--  * sales_orders.shopify_brutto: Gesamtbetrag laut Shop für den Vergleich
--  * Einrichtungsaufgabe rechnung_probelauf
-- ============================================================================

-- --- Modus -------------------------------------------------------------------------
update settings
   set value = value || jsonb_build_object('modus',
                 case when coalesce((value ->> 'automatisch')::boolean, true) then 'test' else 'aus' end)
 where key = 'rechnung' and not (value ? 'modus');

create or replace function rechnung_modus() returns text
language sql stable
set search_path = public, pg_temp as $$
  select coalesce((
    select case
             when value ->> 'modus' in ('aus', 'test', 'scharf') then value ->> 'modus'
             when coalesce((value ->> 'automatisch')::boolean, true) then 'test'
             else 'aus'
           end
    from settings where key = 'rechnung'), 'test');
$$;
comment on function rechnung_modus() is
  'Modus der Kundenrechnung (0117): aus = keine Automatik, test = Probelauf (Testrechnungen, PROBE-Nummern), scharf = echte Rechnungen.';

-- --- Spalten ---------------------------------------------------------------------
alter table kundenrechnungen add column probe boolean not null default false;
create index kundenrechnungen_probe_idx on kundenrechnungen (probe) where probe;
comment on column kundenrechnungen.probe is
  'Testrechnung aus dem Probelauf (0117): eigener Nummernkreis PROBE-…, nicht in DATEV/Fälligkeiten/Umsatz, löschbar über kundenrechnung_probelauf_loeschen().';

alter table sales_orders add column shopify_brutto numeric(16,2);
comment on column sales_orders.shopify_brutto is
  'Gesamtbetrag der Bestellung laut Shop (currentTotalPriceSet, brutto inkl. Versand) — Vergleichsbasis des Rechnungs-Probelaufs (0117).';

-- --- Nummernkreise der Probe --------------------------------------------------------
insert into sequences (code, prefix, padding, next_number)
select v.code, v.prefix, 4, 1
from (values ('kundenrechnung_probe', 'PROBE-RE-'), ('gutschrift_probe', 'PROBE-GU-')) as v(code, prefix)
where not exists (select 1 from sequences s where s.code = v.code);

-- --- Rechnung aus Lieferung: Probe nach Modus, eigener Kreis, keine Vermischung ------
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
  end if;

  perform sales_order_recompute_status(o.id);
  perform log_event('kundenrechnung', v_id, 'state',
    format('%s %s aus Lieferung %s erstellt', case when v_probe then 'Testrechnung (Probelauf)' else 'Rechnung' end, v_nr, p.number), p_actor);
  perform log_event('sales_order', o.id, 'note',
    format('%s %s erstellt (%s)', case when v_probe then 'Testrechnung' else 'Rechnung' end, v_nr, money_text((select brutto from kundenrechnungen where id = v_id))), p_actor);
  return v_id;
end $$;

-- --- Gutschrift erbt die Probe und nimmt den Probe-Kreis -----------------------------
create or replace function kundenrechnung_gutschrift(
  p_id uuid,
  p_positionen jsonb default null,
  p_grund text default null,
  p_actor text default 'system'
) returns uuid
language plpgsql
set search_path = public, pg_temp as $$
declare
  r        kundenrechnungen%rowtype;
  v_id     uuid;
  v_nr     text;
  v_voll   boolean := p_positionen is null;
  v_status kundenrechnung_status;
  v_menge  numeric;
  v_netto  numeric;
  v_steuer numeric;
  v_seq    int := 10;
  pos      record;
begin
  select * into r from kundenrechnungen where id = p_id for update;
  if r.id is null then raise exception 'Rechnung nicht gefunden'; end if;
  if r.art <> 'rechnung' then raise exception 'Gutschriften lassen sich nicht gutschreiben — bitte eine neue Rechnung stellen'; end if;
  if r.status = 'storniert' then raise exception 'Die Rechnung % ist bereits storniert', r.nummer; end if;

  -- Erstattung steht aus, wenn Geld geflossen ist und nicht der Shop erstattet.
  v_status := case when r.status = 'bezahlt' and coalesce(r.zahlungsart, '') = 'Überweisung'
                   then 'offen'::kundenrechnung_status else 'bezahlt'::kundenrechnung_status end;

  v_nr := next_sequence(case when r.probe then 'gutschrift_probe' else 'gutschrift' end);
  insert into kundenrechnungen (
    nummer, art, status, sales_order_id, partner_id, picking_id, storno_von_id, grund,
    rechnungsdatum, leistungsdatum, faellig_am, zahlungsart, bezahlt_am, waehrung,
    anschrift, kundennummer, kundenreferenz, ansprechpartner, probe)
  values (
    v_nr, 'gutschrift', v_status, r.sales_order_id, r.partner_id, r.picking_id, r.id, p_grund,
    current_date, r.leistungsdatum, current_date, r.zahlungsart,
    case when v_status = 'bezahlt' then current_date end, r.waehrung,
    r.anschrift, r.kundennummer, r.kundenreferenz, r.ansprechpartner, r.probe)
  returning id into v_id;

  for pos in
    select kp.*, g.menge as gut_menge
    from kundenrechnung_positionen kp
    left join lateral (
      select (e ->> 'menge')::numeric as menge
      from jsonb_array_elements(coalesce(p_positionen, '[]'::jsonb)) e
      where (e ->> 'position_id')::uuid = kp.id
      limit 1
    ) g on true
    where kp.rechnung_id = r.id
      and (v_voll or g.menge is not null)
    order by kp.sequence
  loop
    v_menge := case when v_voll then pos.menge else least(pos.gut_menge, pos.menge) end;
    continue when v_menge <= 0;
    v_netto  := round(v_menge * pos.einzelpreis * (1 - coalesce(pos.rabatt_pct, 0) / 100.0), 2);
    v_steuer := round(v_netto * pos.steuersatz / 100.0, 2);
    insert into kundenrechnung_positionen (
      rechnung_id, sequence, art, variant_id, sales_order_line_id, bezeichnung, menge, einheit,
      einzelpreis, listenpreis, rabatt_pct, steuersatz, netto, steuer, brutto)
    values (
      v_id, v_seq, pos.art, pos.variant_id, pos.sales_order_line_id, pos.bezeichnung, v_menge, pos.einheit,
      pos.einzelpreis, pos.listenpreis, pos.rabatt_pct, pos.steuersatz, v_netto, v_steuer, v_netto + v_steuer);
    if pos.sales_order_line_id is not null then
      update sales_order_lines set qty_invoiced = greatest(qty_invoiced - v_menge, 0)
      where id = pos.sales_order_line_id;
    end if;
    v_seq := v_seq + 10;
  end loop;

  if v_seq = 10 then raise exception 'Gutschrift ohne Position — bitte Mengen angeben'; end if;
  perform kundenrechnung_summen(v_id);

  if v_voll then
    update kundenrechnungen set status = 'storniert' where id = r.id;
    perform log_event('kundenrechnung', r.id, 'state',
      format('Storniert durch Gutschrift %s%s', v_nr, case when p_grund is not null then ' — ' || p_grund else '' end), p_actor);
  else
    perform log_event('kundenrechnung', r.id, 'note',
      format('Teilgutschrift %s über %s%s', v_nr,
             money_text((select brutto from kundenrechnungen where id = v_id)),
             case when p_grund is not null then ' — ' || p_grund else '' end), p_actor);
  end if;
  perform log_event('kundenrechnung', v_id, 'state',
    format('Gutschrift %s zu Rechnung %s', v_nr, r.nummer), p_actor);
  if r.sales_order_id is not null then
    perform sales_order_recompute_status(r.sales_order_id);
    perform log_event('sales_order', r.sales_order_id, 'note',
      format('Gutschrift %s zu Rechnung %s (%s)', v_nr, r.nummer,
             money_text((select brutto from kundenrechnungen where id = v_id))), p_actor);
  end if;
  return v_id;
end $$;

-- --- Trigger: nur der Modus 'aus' hält die Automatik an (test und scharf laufen) -----------
create or replace function stock_pickings_kundenrechnung() returns trigger
language plpgsql
set search_path = public, pg_temp as $$
declare
  v_kind text;
begin
  if new.origin_model <> 'sales_order' or new.origin_id is null then return null; end if;
  select ot.kind::text into v_kind from operation_types ot where ot.id = new.operation_type_id;
  if v_kind <> 'delivery' then return null; end if;
  if rechnung_modus() = 'aus' then return null; end if;
  begin
    perform kundenrechnung_aus_lieferung(new.id, 'system');
  exception when others then
    -- Die Lieferung darf nie an der Rechnung scheitern — der Fehler steht am Beleg.
    perform log_event('stock_picking', new.id, 'error',
      left('Rechnung konnte nicht erzeugt werden: ' || sqlerrm, 500), 'system');
  end;
  return null;
end $$;

-- --- Fälligkeiten ohne Testbelege ---------------------------------------------------------
create or replace function finanz_faellig(p_bis date default current_date + 14)
returns table (quelle text, ref uuid, label text, partner text,
               faellig_am date, betrag_eur numeric, richtung text, link text)
language sql stable as $$
  select 'po_rate' as quelle, r.id as ref,
         po.number || ' — ' || r.bezeichnung as label,
         p.name as partner,
         zahlplan_faelligkeit(r) as faellig_am,
         zahlplan_betrag(r) as betrag_eur,
         'aus' as richtung,
         '/einkauf/' || po.id as link
  from zahlplan_raten r
  join purchase_orders po on po.id = r.purchase_order_id
  left join partners p on p.id = po.vendor_id
  where r.bezahlt_am is null
    and po.state not in ('cancel', 'done')
    and zahlplan_faelligkeit(r) <= p_bis
  union all
  select 'vendor_bill', b.id,
         b.number || ' — Lieferantenrechnung',
         p.name,
         coalesce(b.due_date, b.bill_date),
         vendor_bill_offen(b.id),
         'aus',
         '/einkauf/rechnungen/' || b.id
  from vendor_bills b
  left join partners p on p.id = b.vendor_id
  where b.state = 'posted'
    and not b.is_credit_note
    and vendor_bill_offen(b.id) > 0
    and coalesce(b.due_date, b.bill_date) <= p_bis
    and not exists (select 1 from zahlplan_raten r where r.purchase_order_id = b.purchase_order_id)
  union all
  select 'vertrag', v.id,
         v.nummer || ' — ' || v.name,
         p.name,
         z.faellig_am,
         z.betrag_eur,
         'aus',
         '/finanzen/vertraege/' || v.id
  from vertraege v
  left join partners p on p.id = v.partner_id
  cross join lateral vertrag_zahlungen_bis(v.id, p_bis) z
  where not exists (
    select 1 from zahlungen za
    where za.vertrag_id = v.id and za.storniert_am is null
      and date_trunc('month', za.gezahlt_am) = date_trunc('month', z.faellig_am))
  union all
  select 'darlehen_rate', r.id,
         d.nummer || ' — Rate ' || r.nr || ' (' || d.name || ')',
         p.name,
         r.faellig_am,
         r.zins + r.tilgung,
         'aus',
         '/finanzen/darlehen/' || d.id
  from darlehen_raten r
  join darlehen d on d.id = r.darlehen_id
  left join partners p on p.id = d.partner_id
  where r.bezahlt_am is null
    and d.status = 'laufend'
    and r.zins + r.tilgung > 0
    and r.faellig_am <= p_bis
  union all
  select 'steuer', s.id,
         s.bezeichnung,
         null,
         s.faellig_am,
         abs(s.betrag),
         case when s.betrag > 0 then 'aus' else 'ein' end,
         '/finanzen/steuern'
  from steuerzahlungen s
  where s.bezahlt_am is null
    and s.betrag <> 0
    and s.faellig_am <= p_bis
  union all
  select 'kundenrechnung', k.id,
         k.nummer || case k.art when 'rechnung' then ' — Kundenrechnung' else ' — Gutschrift (Erstattung)' end,
         p.name,
         coalesce(k.faellig_am, k.rechnungsdatum),
         kundenrechnung_offen(k.id),
         case k.art when 'rechnung' then 'ein' else 'aus' end,
         '/verkauf/rechnungen/' || k.id
  from kundenrechnungen k
  left join partners p on p.id = k.partner_id
  where k.status = 'offen'
    and not k.probe
    and kundenrechnung_offen(k.id) > 0
    and coalesce(k.faellig_am, k.rechnungsdatum) <= p_bis
  order by faellig_am;
$$;

-- --- Probelauf löschen ----------------------------------------------------------------
/*
 * Räumt den Probelauf komplett weg: Zahlungen des Registers zu Testbelegen,
 * Testgutschriften, Testrechnungen (Positionen per Cascade). Danach
 * qty_invoiced der betroffenen Auftragszeilen aus den verbliebenen echten
 * Belegen neu gerechnet, Auftragsstatus neu bestimmt, Probe-Nummernkreise
 * zurück auf 1. Rückgabe: Anzahl gelöschter Belege.
 */
create or replace function kundenrechnung_probelauf_loeschen(p_actor text default 'system')
returns int
language plpgsql
set search_path = public, pg_temp as $$
declare
  v_orders uuid[];
  v_lines  uuid[];
  v_belege int := 0;
  v_n      int;
  o        uuid;
begin
  select array_agg(distinct sales_order_id) into v_orders
  from kundenrechnungen where probe and sales_order_id is not null;
  select array_agg(distinct kp.sales_order_line_id) into v_lines
  from kundenrechnung_positionen kp
  join kundenrechnungen k on k.id = kp.rechnung_id
  where k.probe and kp.sales_order_line_id is not null;

  -- DESTRUKTIV: Testdaten des Probelaufs (0117) — Zahlungen, Gutschriften und Rechnungen mit probe = true; echte Belege unberührt.
  delete from zahlungen where kundenrechnung_id in (select id from kundenrechnungen where probe);
  delete from kundenrechnungen where probe and art = 'gutschrift';
  get diagnostics v_n = row_count; v_belege := v_belege + v_n;
  delete from kundenrechnungen where probe;
  get diagnostics v_n = row_count; v_belege := v_belege + v_n;

  update sales_order_lines l
     set qty_invoiced = greatest(coalesce((
           select sum(case k.art when 'rechnung' then kp.menge else -kp.menge end)
           from kundenrechnung_positionen kp
           join kundenrechnungen k on k.id = kp.rechnung_id
           where kp.sales_order_line_id = l.id), 0), 0)
   where l.id = any(coalesce(v_lines, '{}'::uuid[]));
  foreach o in array coalesce(v_orders, '{}'::uuid[]) loop
    perform sales_order_recompute_status(o);
    perform log_event('sales_order', o, 'note', 'Testrechnungen des Probelaufs gelöscht', p_actor);
  end loop;

  perform sequence_setzen('kundenrechnung_probe', 1);
  perform sequence_setzen('gutschrift_probe', 1);
  return v_belege;
end $$;

-- --- Einrichtungsaufgabe: den Probelauf auswerten und beenden ----------------------------
insert into einrichtungsaufgaben (schluessel, titel, beschreibung, link, sortierung)
select 'rechnung_probelauf',
       'Rechnungs-Probelauf auswerten: Testrechnungen mit Shopify vergleichen, dann löschen und scharf schalten',
       'Die Rechnung läuft im Probelauf parallel zur Shopify-Rechnungs-App: Testrechnungen (PROBE-RE-…) entstehen mit jeder Lieferung, zählen aber nirgends. Unter Verkauf → Rechnungen → Probelauf die Beträge je Bestellung mit dem Shop vergleichen; Abweichungen melden. Wenn alles stimmt: Nummernkreise RE-/GU- und Firmendaten prüfen, Probelauf löschen, unter Einstellungen → Belege auf „scharf" stellen und die Shopify-Rechnungs-App abschalten.',
       '/verkauf/rechnungen?filter=probelauf', 5
where not exists (select 1 from einrichtungsaufgaben where schluessel = 'rechnung_probelauf');

select einrichtungsaufgaben_anlegen('system');
