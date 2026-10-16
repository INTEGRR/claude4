-- ============================================================================
-- 0115  Kundenrechnungen: Rechnung bei Lieferung, Gutschrift, Zahlung,
--       Mahnung, Shop-Änderungen (Entscheidungslog 2026-10-16)
-- ----------------------------------------------------------------------------
-- Betreiber: Kundenrechnungen kommen künftig aus KRNL (eigener Nummernkreis,
-- PDF, DATEV) — mit Storno und Gutschrift. Das Problem der alten Lösung:
-- Bestellungen werden in Shopify auf Kundenwunsch geändert (andere Switches,
-- anderes Case, ein Artikel dazu); die Rechnungs-App erzeugte dann eine
-- Gutschrift und keine neue Rechnung.
--
-- Grundsatz: DIE RECHNUNG ENTSTEHT BEI DER LIEFERUNG (Leistungszeitpunkt),
-- aus dem Auftrag in seinem dann aktuellen Zustand. Eine Änderung vor dem
-- Versand ändert nur den Auftrag (Positionen, Lieferung, Fertigung) — es gibt
-- noch nichts zu korrigieren. Eine Änderung nach der Rechnung erzeugt
-- Korrekturbelege: Gutschrift über die zurückgenommene Menge, neue Rechnung
-- für die nachgelieferte. Beides ohne Handarbeit, beides mit Beleg.
--
--  * kundenrechnungen + kundenrechnung_positionen (Nummernkreise RE-/GU-)
--  * kundenrechnung_aus_lieferung: Rechnung je gebuchter Lieferung, Versand
--    einmal je Auftrag; Shop-Aufträge sind bezahlt (Zahlungsart aus Shopify)
--  * kundenrechnung_gutschrift / _stornieren: Gutschrift (Teil oder ganz),
--    Storno = volle Gutschrift mit Verweis
--  * kundenrechnung_zahlen, Zahlungen mit quelle 'kundenrechnung' (Register),
--    kundenrechnung_mahnen (Mahnstufen), finanz_faellig mit Forderungen
--  * Trigger: gebuchte Lieferung eines Verkaufsauftrags erzeugt die Rechnung
--    (settings.rechnung.automatisch, Standard an)
--  * sales_order_lieferung_angleichen: Auftragsänderung (Shop) zieht offene
--    Lieferung und nicht begonnene Fertigung nach
--  * Auftrag: Rechnungsanschrift, Zahlungsart, Listenpreis je Position
--  * Prozess „kundenrechnung", Einstellungen (rechnung), Firmendaten erweitert
-- ============================================================================

-- --- Nummernkreise ------------------------------------------------------------
insert into sequences (code, prefix, padding, next_number) values
  ('kundenrechnung', 'RE-', 4, 1),
  ('gutschrift',     'GU-', 4, 1);

-- Startnummer eines Kreises setzen (Umstellung: Anschluss an die bisherige
-- Nummerierung) — die Sequenz trägt den Stand, die Tabelle Präfix/Breite.
create or replace function sequence_setzen(p_code text, p_naechste bigint, p_prefix text default null)
returns void
language plpgsql
set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from sequences where code = p_code) then
    raise exception 'Unbekannter Nummernkreis: %', p_code;
  end if;
  if p_naechste < 1 then raise exception 'Die nächste Nummer muss mindestens 1 sein'; end if;
  perform setval('seq_' || p_code, p_naechste, false);
  update sequences set next_number = p_naechste, prefix = coalesce(p_prefix, prefix) where code = p_code;
end $$;

-- --- Auftrag: Rechnungsanschrift, Zahlungsart, Listenpreis -------------------------
alter table sales_orders
  add column rechnungsanschrift jsonb,
  add column zahlungsart text;
comment on column sales_orders.rechnungsanschrift is
  'Rechnungsanschrift aus dem Shop (billingAddress), eingefroren beim Import; null = Lieferadresse bzw. Kundenstammdaten.';
comment on column sales_orders.zahlungsart is
  'Zahlungsart laut Shop (paymentGatewayNames, lesbar) — steht auf der Rechnung.';

alter table sales_order_lines add column listenpreis numeric(16,2);
comment on column sales_order_lines.listenpreis is
  'Netto-Listenpreis vor Rabatt (Shop: originalUnitPrice) — die Rechnung weist den Rabatt aus; null = kein Rabatt.';

-- --- Belege -------------------------------------------------------------------
create type kundenrechnung_art as enum ('rechnung', 'gutschrift');
create type kundenrechnung_status as enum ('offen', 'bezahlt', 'storniert');

create table kundenrechnungen (
  id                 uuid primary key default gen_random_uuid(),
  nummer             text unique not null,
  art                kundenrechnung_art not null default 'rechnung',
  status             kundenrechnung_status not null default 'offen',
  sales_order_id     uuid references sales_orders on delete restrict,
  partner_id         uuid not null references partners on delete restrict,
  picking_id         uuid references stock_pickings on delete set null,
  -- Gutschrift → stornierte/teilgutgeschriebene Rechnung
  storno_von_id      uuid references kundenrechnungen on delete restrict,
  grund              text,
  rechnungsdatum     date not null default current_date,
  leistungsdatum     date,
  faellig_am         date,
  zahlungsart        text,
  bezahlt_am         date,
  mahnstufe          int not null default 0 check (mahnstufe between 0 and 3),
  gemahnt_am         date,
  waehrung           text not null default 'EUR',
  netto              numeric(16,2) not null default 0,
  steuer             numeric(16,2) not null default 0,
  brutto             numeric(16,2) not null default 0,
  anschrift          jsonb not null default '{}'::jsonb,
  kundennummer       text,
  kundenreferenz     text,
  ansprechpartner    text,
  notiz              text,
  datev_uebergeben_am timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz
);
select attach_touch_trigger('kundenrechnungen');
create index kundenrechnungen_order_idx on kundenrechnungen (sales_order_id);
create index kundenrechnungen_status_idx on kundenrechnungen (status, faellig_am);
comment on table kundenrechnungen is
  'Ausgangsrechnungen und Gutschriften (0115): entstehen bei der Lieferung; Beträge sind Schnappschüsse, die Anschrift ebenso.';

create table kundenrechnung_positionen (
  id                  uuid primary key default gen_random_uuid(),
  rechnung_id         uuid not null references kundenrechnungen on delete cascade,
  sequence            int not null default 10,
  art                 text not null default 'position' check (art in ('position', 'versand')),
  variant_id          uuid references product_variants on delete restrict,
  sales_order_line_id uuid references sales_order_lines on delete set null,
  bezeichnung         text not null,
  menge               numeric(16,4) not null,
  einheit             text not null default 'Stk',
  einzelpreis         numeric(16,2) not null,
  listenpreis         numeric(16,2),
  rabatt_pct          numeric(5,2) not null default 0,
  steuersatz          numeric(5,2) not null default 19,
  netto               numeric(16,2) not null,
  steuer              numeric(16,2) not null,
  brutto              numeric(16,2) not null
);
create index kundenrechnung_positionen_idx on kundenrechnung_positionen (rechnung_id, sequence);

-- Zahlungen: Forderungen im Register (Einzahlung auf Rechnung, Erstattung auf Gutschrift)
alter table zahlungen add column kundenrechnung_id uuid references kundenrechnungen on delete set null;
-- DESTRUKTIV: nur die Check-Liste der Quellen wird um 'kundenrechnung' erweitert, keine Daten betroffen.
alter table zahlungen drop constraint zahlungen_quelle_check;
alter table zahlungen add constraint zahlungen_quelle_check
  check (quelle in ('vendor_bill', 'po_rate', 'vertrag', 'darlehen', 'darlehen_rate', 'steuer', 'kundenrechnung', 'manuell'));
create index zahlungen_kundenrechnung_idx on zahlungen (kundenrechnung_id);

-- Einstellungen: Automatik, Zahlungsziel, Mahnfrist, DATEV-Konten
insert into settings (key, value) values
  ('rechnung', '{"automatisch": true, "zahlungsziel_tage": 14, "mahnfrist_tage": 7,
                 "kontenrahmen": "SKR03", "debitorenkonto": "10000",
                 "erloeskonto_19": "8400", "erloeskonto_7": "8300", "erloeskonto_0": "8120"}'::jsonb)
on conflict (key) do nothing;

-- Firmendaten für den Rechnungsfuß (Pflichtangaben GmbH): nur ergänzen, nichts überschreiben.
update settings
   set value = jsonb_build_object(
                 'registergericht', '', 'handelsregister', '', 'steuernummer', '',
                 'geschaeftsfuehrung', '', 'web', '', 'iban', '', 'bic', '', 'bank', '')
               || value
 where key = 'company';

-- --- Summen ------------------------------------------------------------------
create or replace function kundenrechnung_summen(p_id uuid) returns void
language sql
set search_path = public, pg_temp as $$
  update kundenrechnungen k set
    netto  = s.netto,
    steuer = s.steuer,
    brutto = s.brutto
  from (
    select coalesce(sum(netto), 0) as netto, coalesce(sum(steuer), 0) as steuer, coalesce(sum(brutto), 0) as brutto
    from kundenrechnung_positionen where rechnung_id = p_id
  ) s
  where k.id = p_id;
$$;

/** Offener Betrag: nichts mehr bei bezahlt/storniert, sonst brutto abzüglich nicht stornierter Zahlungen. */
create or replace function kundenrechnung_offen(p_id uuid) returns numeric
language sql stable
set search_path = public, pg_temp as $$
  select case when k.status <> 'offen' then 0
         else greatest(0, round(k.brutto - coalesce((
           select sum(z.betrag_eur) from zahlungen z
           where z.kundenrechnung_id = k.id and z.storniert_am is null
             and z.richtung = case k.art when 'rechnung' then 'ein' else 'aus' end), 0), 2))
         end
  from kundenrechnungen k where k.id = p_id;
$$;

-- --- Rechnung aus der Lieferung -------------------------------------------------
/*
 * Eine Rechnung je gebuchter Lieferung (Lieferschein): die gelieferten Mengen
 * zu den Preisen der Auftragszeile, der Versand einmal je Auftrag auf der
 * ersten Rechnung. Shop-Aufträge sind bezahlt (Zahlungsart aus dem Shop,
 * Zahldatum = Bestelldatum), manuelle Aufträge offen mit Zahlungsziel.
 * Anschrift, Kundennummer und Beträge sind Schnappschüsse — ein Beleg ändert
 * sich nicht mit den Stammdaten.
 */
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
             where picking_id = p.id and art = 'rechnung' and status <> 'storniert') then
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

  v_nr := next_sequence('kundenrechnung');
  insert into kundenrechnungen (
    nummer, art, status, sales_order_id, partner_id, picking_id, rechnungsdatum, leistungsdatum,
    faellig_am, zahlungsart, waehrung, anschrift, kundennummer, kundenreferenz, ansprechpartner)
  values (
    v_nr, 'rechnung', 'offen', o.id, o.partner_id, p.id, v_datum, coalesce(p.date_done::date, v_datum),
    v_faellig, case when o.source = 'shopify' then coalesce(o.zahlungsart, 'Shopify') else 'Überweisung' end,
    o.currency, v_anschrift, v_kundennr, coalesce(o.shopify_order_name, o.client_order_ref, o.number), v_ansprech)
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
    where kr.sales_order_id = o.id and kr.id <> v_id and kr.art = 'rechnung'
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
    format('Rechnung %s aus Lieferung %s erstellt', v_nr, p.number), p_actor);
  perform log_event('sales_order', o.id, 'note',
    format('Rechnung %s erstellt (%s)', v_nr, money_text((select brutto from kundenrechnungen where id = v_id))), p_actor);
  return v_id;
end $$;

-- --- Gutschrift / Storno -------------------------------------------------------
/*
 * Gutschrift zu einer Rechnung: p_positionen null = alle Positionen (Storno —
 * die Rechnung wird „storniert"), sonst ein Teil [{position_id, menge}].
 * Beträge wie auf der Rechnung gerechnet (Menge × Einzelpreis × Rabatt),
 * damit die volle Gutschrift die Rechnung genau aufhebt. Status der
 * Gutschrift: offen = Erstattung steht aus (bezahlte Rechnung, Überweisung),
 * bezahlt = verrechnet (unbezahlte Rechnung) oder vom Shop erstattet.
 */
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

  v_nr := next_sequence('gutschrift');
  insert into kundenrechnungen (
    nummer, art, status, sales_order_id, partner_id, picking_id, storno_von_id, grund,
    rechnungsdatum, leistungsdatum, faellig_am, zahlungsart, bezahlt_am, waehrung,
    anschrift, kundennummer, kundenreferenz, ansprechpartner)
  values (
    v_nr, 'gutschrift', v_status, r.sales_order_id, r.partner_id, r.picking_id, r.id, p_grund,
    current_date, r.leistungsdatum, current_date, r.zahlungsart,
    case when v_status = 'bezahlt' then current_date end, r.waehrung,
    r.anschrift, r.kundennummer, r.kundenreferenz, r.ansprechpartner)
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

create or replace function kundenrechnung_stornieren(p_id uuid, p_grund text default null, p_actor text default 'system')
returns uuid
language sql
set search_path = public, pg_temp as $$
  select kundenrechnung_gutschrift(p_id, null, p_grund, p_actor);
$$;

/*
 * Auftragsänderung nach der Rechnung (Shop nimmt Menge zurück): Gutschrift
 * über die zurückgenommene Menge einer Variante — auf der jüngsten nicht
 * stornierten Rechnung des Auftrags, Position für Position.
 */
create or replace function kundenrechnung_aenderung_gutschreiben(
  p_order uuid, p_variant uuid, p_menge numeric, p_grund text default null, p_actor text default 'shopify'
) returns int
language plpgsql
set search_path = public, pg_temp as $$
declare
  v_rest numeric := p_menge;
  v_anzahl int := 0;
  pos record;
begin
  for pos in
    select kp.id as position_id, kp.rechnung_id, kp.menge
    from kundenrechnung_positionen kp
    join kundenrechnungen kr on kr.id = kp.rechnung_id
    where kr.sales_order_id = p_order and kr.art = 'rechnung' and kr.status <> 'storniert'
      and kp.variant_id = p_variant and kp.art = 'position'
    order by kr.rechnungsdatum desc, kr.created_at desc
  loop
    exit when v_rest <= 0;
    -- Schon gutgeschriebene Mengen dieser Position abziehen.
    select pos.menge - coalesce(sum(g.menge), 0) into pos.menge
    from kundenrechnung_positionen g
    join kundenrechnungen gk on gk.id = g.rechnung_id and gk.art = 'gutschrift' and gk.storno_von_id = pos.rechnung_id
    where g.variant_id = p_variant and g.art = 'position';
    continue when pos.menge <= 0;
    perform kundenrechnung_gutschrift(
      pos.rechnung_id,
      jsonb_build_array(jsonb_build_object('position_id', pos.position_id, 'menge', least(v_rest, pos.menge))),
      p_grund, p_actor);
    v_rest := v_rest - least(v_rest, pos.menge);
    v_anzahl := v_anzahl + 1;
  end loop;
  return v_anzahl;
end $$;

-- --- Zahlung, Mahnung -----------------------------------------------------------
create or replace function kundenrechnung_zahlen(
  p_id uuid, p_datum date default current_date, p_zahlungsart text default null, p_actor text default 'system'
) returns void
language plpgsql
set search_path = public, pg_temp as $$
declare r kundenrechnungen%rowtype;
begin
  select * into r from kundenrechnungen where id = p_id for update;
  if r.id is null then raise exception 'Rechnung nicht gefunden'; end if;
  if r.status = 'storniert' then raise exception 'Der Beleg % ist storniert', r.nummer; end if;
  if r.status = 'bezahlt' then return; end if;
  update kundenrechnungen
     set status = 'bezahlt', bezahlt_am = p_datum, zahlungsart = coalesce(p_zahlungsart, zahlungsart)
   where id = p_id;
  perform log_event('kundenrechnung', p_id, 'state',
    format('%s am %s', case r.art when 'rechnung' then 'Bezahlt' else 'Erstattet' end, to_char(p_datum, 'DD.MM.YYYY')), p_actor);
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
  if r.faellig_am is null or r.faellig_am >= current_date then
    raise exception 'Die Rechnung % ist noch nicht fällig (fällig am %)', r.nummer, to_char(r.faellig_am, 'DD.MM.YYYY');
  end if;
  if r.mahnstufe >= 3 then raise exception 'Die Rechnung % hat die letzte Mahnstufe erreicht', r.nummer; end if;
  update kundenrechnungen set mahnstufe = mahnstufe + 1, gemahnt_am = current_date where id = p_id;
  perform log_event('kundenrechnung', p_id, 'note',
    format('%s erstellt', case r.mahnstufe + 1 when 1 then 'Zahlungserinnerung' when 2 then '1. Mahnung' else '2. Mahnung' end), p_actor);
  return r.mahnstufe + 1;
end $$;

-- Zahlungsregister: Einzahlung auf Rechnung / Erstattung auf Gutschrift.
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

  v_kurs := exchange_rate_at(p_waehrung, p_datum);

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

create or replace function zahlung_stornieren(p_zahlung uuid, p_actor text default 'system')
returns void
language plpgsql as $$
declare
  v_z zahlungen;
begin
  select * into v_z from zahlungen where id = p_zahlung;
  if v_z.id is null then raise exception 'Unbekannte Zahlung'; end if;
  if v_z.storniert_am is not null then raise exception 'Die Zahlung % ist bereits storniert', v_z.nummer; end if;

  update zahlungen set storniert_am = now() where id = p_zahlung;

  if v_z.vendor_bill_id is not null then
    update vendor_bills set state = 'posted', paid_at = null
    where id = v_z.vendor_bill_id and state = 'paid' and vendor_bill_offen(id) > 0;
    perform log_event('vendor_bill', v_z.vendor_bill_id, 'state',
      format('Zahlung %s storniert', v_z.nummer), p_actor);
  end if;
  if v_z.zahlplan_rate_id is not null then
    update zahlplan_raten r set bezahlt_am = null
    where r.id = v_z.zahlplan_rate_id
      and not exists (select 1 from zahlungen z
                      where z.zahlplan_rate_id = r.id and z.storniert_am is null);
  end if;
  if v_z.kundenrechnung_id is not null then
    -- Beleg wieder öffnen, wenn er nur durch diese Zahlung beglichen war.
    update kundenrechnungen set status = 'offen', bezahlt_am = null
    where id = v_z.kundenrechnung_id and status = 'bezahlt';
    update kundenrechnungen set status = 'bezahlt', bezahlt_am = v_z.gezahlt_am
    where id = v_z.kundenrechnung_id and status = 'offen' and kundenrechnung_offen(id) <= 0;
    perform log_event('kundenrechnung', v_z.kundenrechnung_id, 'note',
      format('Zahlung %s storniert', v_z.nummer), p_actor);
  end if;
end $$;

-- Fälligkeiten: Forderungen (offene Rechnungen) und ausstehende Erstattungen dazu.
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
    and kundenrechnung_offen(k.id) > 0
    and coalesce(k.faellig_am, k.rechnungsdatum) <= p_bis
  order by faellig_am;
$$;

-- --- Lieferung bucht → Rechnung (Automatik) ------------------------------------------
create or replace function stock_pickings_kundenrechnung() returns trigger
language plpgsql
set search_path = public, pg_temp as $$
declare
  v_auto boolean;
  v_kind text;
begin
  if new.origin_model <> 'sales_order' or new.origin_id is null then return null; end if;
  select ot.kind::text into v_kind from operation_types ot where ot.id = new.operation_type_id;
  if v_kind <> 'delivery' then return null; end if;
  select coalesce((value ->> 'automatisch')::boolean, true) into v_auto from settings where key = 'rechnung';
  if not coalesce(v_auto, true) then return null; end if;
  begin
    perform kundenrechnung_aus_lieferung(new.id, 'system');
  exception when others then
    -- Die Lieferung darf nie an der Rechnung scheitern — der Fehler steht am Beleg.
    perform log_event('stock_picking', new.id, 'error',
      left('Rechnung konnte nicht erzeugt werden: ' || sqlerrm, 500), 'system');
  end;
  return null;
end $$;

-- DESTRUKTIV: Neudefinition des eigenen Triggers aus dieser Migration (Wiederholbarkeit), kein Altbestand.
drop trigger if exists stock_pickings_kundenrechnung on stock_pickings;
create trigger stock_pickings_kundenrechnung
  after update of state on stock_pickings
  for each row
  when (new.state = 'done' and old.state is distinct from 'done')
  execute function stock_pickings_kundenrechnung();

-- --- Auftragsänderung: Lieferung und Fertigung nachziehen ------------------------------
/*
 * Gleicht die offenen Lieferbewegungen und die nicht begonnene Fertigung
 * eines bestätigten Auftrags an seine Positionen an — nach einer Änderung
 * im Shop (Menge, Variante, Zusatzartikel) oder von Hand. Gelieferte Mengen
 * bleiben, angebrochene Fertigung bleibt (mit Hinweis), der Rest folgt den
 * Zeilen. Kits (Phantom-Stücklisten) werden nicht angefasst.
 */
create or replace function sales_order_lieferung_angleichen(p_order uuid, p_actor text default 'system')
returns void
language plpgsql
set search_path = public, pg_temp as $$
declare
  o         sales_orders%rowtype;
  v_op      operation_types%rowtype;
  l         record;
  m         record;
  mo        record;
  v_bedarf  numeric;
  v_offen   numeric;
  v_diff    numeric;
  v_picking uuid;
  v_move    uuid;
  v_fertig  numeric;
  v_mo_offen numeric;
  v_mo_rest numeric;
  v_mo      uuid;
begin
  select * into o from sales_orders where id = p_order for update;
  if o.id is null then raise exception 'Verkaufsauftrag nicht gefunden'; end if;
  if o.state <> 'sale' then return; end if;
  select * into v_op from operation_types where kind = 'delivery' and active limit 1;

  for l in
    select sol.*, pt.type as produkt_typ, pt.route_manufacture, pt.route_mto
    from sales_order_lines sol
    join product_variants pv on pv.id = sol.variant_id
    join product_templates pt on pt.id = pv.template_id
    where sol.order_id = p_order and sol.display_type is null and sol.variant_id is not null
  loop
    continue when l.produkt_typ <> 'goods' or resolve_kit(l.variant_id) is not null;

    -- Lieferung ---------------------------------------------------------
    v_bedarf := greatest(l.qty - l.qty_delivered, 0);
    select coalesce(sum(sm.qty), 0) into v_offen
    from stock_moves sm
    join stock_pickings p on p.id = sm.picking_id
    join operation_types ot on ot.id = p.operation_type_id and ot.kind = 'delivery'
    where p.origin_model = 'sales_order' and p.origin_id = p_order
      and sm.variant_id = l.variant_id and sm.state not in ('done', 'cancel');

    if v_bedarf > v_offen then
      v_diff := v_bedarf - v_offen;
      select p.id into v_picking
      from stock_pickings p
      join operation_types ot on ot.id = p.operation_type_id and ot.kind = 'delivery'
      where p.origin_model = 'sales_order' and p.origin_id = p_order and p.state not in ('done', 'cancel')
      order by p.created_at limit 1;
      if v_picking is null then
        insert into stock_pickings (number, operation_type_id, state, partner_id, scheduled_date,
                                    origin_model, origin_id, origin_label)
        values (next_sequence(v_op.sequence_code), v_op.id, 'confirmed', o.partner_id, now(),
                'sales_order', o.id, o.number)
        returning id into v_picking;
      end if;
      insert into stock_moves (picking_id, variant_id, uom_id, qty, src_location_id, dest_location_id, state)
      values (v_picking, l.variant_id, l.uom_id, v_diff, v_op.default_src_id, v_op.default_dest_id, 'confirmed')
      returning id into v_move;
      perform move_reserve(v_move);
    elsif v_bedarf < v_offen then
      v_diff := v_offen - v_bedarf;
      for m in
        select sm.* from stock_moves sm
        join stock_pickings p on p.id = sm.picking_id
        join operation_types ot on ot.id = p.operation_type_id and ot.kind = 'delivery'
        where p.origin_model = 'sales_order' and p.origin_id = p_order
          and sm.variant_id = l.variant_id and sm.state not in ('done', 'cancel')
        order by sm.created_at desc
      loop
        exit when v_diff <= 0;
        if m.qty <= v_diff then
          perform move_cancel(m.id);
          v_diff := v_diff - m.qty;
        else
          if m.reserved_qty > m.qty - v_diff then
            perform quant_apply(m.src_location_id, m.variant_id, 0, -(m.reserved_qty - (m.qty - v_diff)));
            update stock_moves set reserved_qty = m.qty - v_diff where id = m.id;
          end if;
          update stock_moves set qty = m.qty - v_diff where id = m.id;
          v_diff := 0;
        end if;
      end loop;
    end if;

    -- Fertigung auf Bestellung -------------------------------------------------
    if l.route_manufacture and l.route_mto and resolve_bom(l.variant_id) is not null then
      select coalesce(sum(qty_produced), 0) into v_fertig
      from manufacturing_orders
      where sales_order_id = p_order and variant_id = l.variant_id and state = 'done';
      v_mo_rest := greatest(l.qty - v_fertig, 0);
      select coalesce(sum(qty_to_produce - qty_produced), 0) into v_mo_offen
      from manufacturing_orders
      where sales_order_id = p_order and variant_id = l.variant_id and state in ('draft', 'confirmed', 'progress');
      if v_mo_offen <> v_mo_rest then
        -- Nicht begonnene Aufträge stornieren, angebrochene behalten (Material ist entnommen).
        for mo in
          select id, number, qty_to_produce - qty_produced as offen
          from manufacturing_orders
          where sales_order_id = p_order and variant_id = l.variant_id and state in ('draft', 'confirmed', 'progress')
        loop
          if exists (select 1 from stock_moves where production_id = mo.id and state = 'done') then
            v_mo_rest := v_mo_rest - mo.offen;
            perform log_event('sales_order', p_order, 'note',
              format('Fertigungsauftrag %s ist angebrochen und bleibt trotz Änderung bestehen.', mo.number), p_actor);
          else
            perform mo_cancel(mo.id, p_actor);
          end if;
        end loop;
        if v_mo_rest > 0 then
          v_mo := create_manufacturing_order(l.variant_id, v_mo_rest, p_order, null, p_actor);
          update manufacturing_orders set origin = o.number where id = v_mo;
          perform mo_confirm(v_mo, p_actor);
        end if;
      end if;
    end if;
  end loop;

  -- Bewegungen und Fertigung zu Varianten, die keine Zeile mehr haben.
  for m in
    select sm.id from stock_moves sm
    join stock_pickings p on p.id = sm.picking_id
    join operation_types ot on ot.id = p.operation_type_id and ot.kind = 'delivery'
    where p.origin_model = 'sales_order' and p.origin_id = p_order and sm.state not in ('done', 'cancel')
      and not exists (select 1 from sales_order_lines sol
                      where sol.order_id = p_order and sol.variant_id = sm.variant_id and sol.qty > sol.qty_delivered)
  loop
    perform move_cancel(m.id);
  end loop;
  for mo in
    select f.id, f.number from manufacturing_orders f
    where f.sales_order_id = p_order and f.state in ('draft', 'confirmed')
      and not exists (select 1 from sales_order_lines sol where sol.order_id = p_order and sol.variant_id = f.variant_id)
      and not exists (select 1 from stock_moves where production_id = f.id and state = 'done')
  loop
    perform mo_cancel(mo.id, p_actor);
  end loop;

  for m in
    select p.id from stock_pickings p
    join operation_types ot on ot.id = p.operation_type_id and ot.kind = 'delivery'
    where p.origin_model = 'sales_order' and p.origin_id = p_order and p.state not in ('done', 'cancel')
  loop
    perform picking_recompute_state(m.id);
  end loop;
  perform sales_order_recompute_status(p_order);
end $$;

-- --- Prozess „Kundenrechnung" ---------------------------------------------------------
insert into prozess_modelle (modell, tabelle, status_spalte, routen_muster)
values ('kundenrechnung', 'kundenrechnungen', 'status', '/verkauf/rechnungen/:id');

do $$
declare
  v_prozess uuid;
  v_version uuid;
begin
  insert into prozesse (code, name, beschreibung, bereich, modell)
  values ('kundenrechnung', 'Kundenrechnung',
          'Die Rechnung entsteht mit der Lieferung (von selbst oder von Hand aus dem Lieferschein), '
          || 'wird bezahlt (Shop: sofort) oder gemahnt — und mit einer Gutschrift storniert.',
          'verkauf', 'kundenrechnung')
  returning id into v_prozess;

  insert into prozess_versionen (prozess_id, version, status, created_by)
  values (v_prozess, 1, 'entwurf', 'migration:0115')
  returning id into v_version;

  insert into prozess_schritte (version_id, code, name, art, sequence, aktion, zustand, optional)
  values
    (v_version, 'start',      'Lieferung gebucht',          'start',  0,  null,                          null,        false),
    (v_version, 'rechnung',   'Rechnung aus der Lieferung', 'aktion', 10, 'verkauf.rechnung_erstellen',  'offen',     false),
    (v_version, 'zahlen',     'Zahlung',                    'aktion', 20, 'verkauf.rechnung_zahlen',     'bezahlt',   false),
    (v_version, 'stornieren', 'Gutschrift (Storno)',        'aktion', 80, 'verkauf.rechnung_stornieren', 'storniert', true),
    (v_version, 'ende',       'Erledigt',                   'ende',   90, null,                          null,        false);

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
  values
    (v_version, 'start',      'rechnung',   10, null),
    (v_version, 'rechnung',   'zahlen',     10, null),
    (v_version, 'rechnung',   'stornieren', 90, 'Storno'),
    (v_version, 'zahlen',     'ende',       10, null),
    (v_version, 'zahlen',     'stornieren', 90, 'Storno mit Erstattung'),
    (v_version, 'stornieren', 'ende',       10, null);

  perform prozess_version_aktivieren(v_version);
end $$;

insert into prozess_routen (pfad_muster, prozess_code, schritt_code)
values ('/verkauf/rechnungen', 'kundenrechnung', null)
on conflict (pfad_muster) do nothing;
