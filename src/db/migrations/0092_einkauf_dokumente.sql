-- ============================================================================
-- 0092  Einkauf, Stufe 1 — Dokumente in Google Drive, Lieferantenakte,
--       Dienstleistungs-Bestellungen ohne Wareneingang, Preise auf 6 Stellen
-- ----------------------------------------------------------------------------
-- Das Einkaufstool (Entscheidungslog 2026-09-30) beginnt mit dem Fundament:
--
--   * Dateien (Zeichnungen, Gerber, STEP, AI, BOM-Excel, PI/CI, Rechnungen …)
--     liegen in der geteilten Google-Ablage „Einkauf". KRNL hält nur den
--     Index (`dokumente`) und die Verweise auf Belege (`dokument_verweise`,
--     n:m — eine Zeichnung hängt an Artikel, Projekt und Bestellung
--     zugleich). `drive_ordner` merkt sich, welcher Ordner zu welchem Beleg
--     gehört, damit jeder Ordner genau einmal entsteht.
--   * Lieferantenakte: Sprache, Maildomains (Zuordnung eingehender Mails ab
--     Stufe 2), zuständiger Einkäufer, Standard-Incoterm und -Währung.
--   * Dienstleistungen (Regale, Montage, Werkzeugkosten …) erzeugen beim
--     Bestätigen KEINE Lagerbewegung mehr. Eine reine Dienstleistungs-
--     Bestellung hat keinen Wareneingang — der Bestellprozess springt über
--     die neue Weiche „Lagerware dabei?" direkt zur Rechnung, statt ewig
--     im Teilprozess Wareneingang zu warten. Dienstleistungen werden nach
--     Bestellmenge abgerechnet.
--   * Einkaufspreise auf 6 Nachkommastellen: Kleinteile kosten 0,0034 USD.
-- ============================================================================

-- --- 1. Dokumente ------------------------------------------------------------

create type dokument_art as enum (
  'zeichnung', 'gerber', 'step', 'ai', 'bom', 'angebot', 'pi', 'ci',
  'packing_list', 'rechnung', 'bl_awb', 'zollbescheid', 'vertrag', 'nda',
  'foto', 'sonstiges');

create type dokument_quelle as enum ('upload', 'mail', 'drive', 'weitergeleitet', 'manuell');

create table dokumente (
  id                  uuid primary key default gen_random_uuid(),
  drive_file_id       text not null unique,
  name                text not null,
  mime                text,
  groesse             bigint,
  md5                 text,
  art                 dokument_art not null default 'sonstiges',
  revision            text,
  quelle              dokument_quelle not null default 'upload',
  partner_id          uuid references partners on delete set null,
  notiz               text,
  -- Für den Agenten (Stufe 6): gelesener Text/Tabelleninhalt. Bis dahin leer.
  text_auszug         text,
  datev_uebergeben_am timestamptz,
  hochgeladen_von     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz
);
select attach_touch_trigger('dokumente');
create index dokumente_partner_idx on dokumente (partner_id);

comment on table dokumente is
  'Index der Einkaufsdateien in Google Drive (0092) — die Datei selbst liegt in der geteilten Ablage, KRNL hält Art, Revision und Verweise';

create table dokument_verweise (
  id              uuid primary key default gen_random_uuid(),
  dokument_id     uuid not null references dokumente on delete cascade,
  modell          text not null,
  record_id       uuid not null,
  verknuepft_von  text,
  created_at      timestamptz not null default now(),
  unique (dokument_id, modell, record_id)
);
create index dokument_verweise_beleg_idx on dokument_verweise (modell, record_id);

comment on table dokument_verweise is
  'Welche Datei hängt an welchem Beleg (n:m) — modell wie in prozess_modelle/KOMMENTAR_MODELLE';

-- Ordner je Beleg in der geteilten Ablage; schluessel z. B. 'wurzel:lieferanten',
-- 'partner:<uuid>', 'purchase_order:<uuid>'.
create table drive_ordner (
  schluessel  text primary key,
  folder_id   text not null,
  name        text not null,
  created_at  timestamptz not null default now()
);

-- Laufende Uploads: der Browser lädt in 4-MiB-Stücken über KRNL zu Google
-- (Vercel lässt keine größeren Anfragen durch). Die Google-Sitzungsadresse
-- bleibt serverseitig — der Browser kennt nur die ID.
create table upload_sitzungen (
  id            uuid primary key default gen_random_uuid(),
  session_uri   text not null,
  name          text not null,
  mime          text,
  groesse       bigint not null check (groesse > 0),
  ordner_id     text not null,
  modell        text,
  record_id     uuid,
  art           dokument_art not null default 'sonstiges',
  erstellt_von  text not null,
  drive_file_id text,
  abgeschlossen_am timestamptz,
  created_at    timestamptz not null default now()
);

-- --- 2. Lieferantenakte --------------------------------------------------------

alter table partners
  add column sprache text check (sprache in ('de', 'en', 'zh')),
  add column mail_domains text[] not null default '{}',
  add column einkaeufer_id uuid references users on delete set null,
  add column standard_incoterm text references incoterms (code) on delete set null,
  add column standard_waehrung text references currencies on delete set null;

create index partners_mail_domains_idx on partners using gin (mail_domains);

comment on column partners.sprache is
  'Kommunikationssprache mit dem Lieferanten (de/en/zh) — Vorlagen und Entwürfe in dieser Sprache, Anzeige immer auch deutsch';
comment on column partners.mail_domains is
  'Maildomains des Lieferanten (z. B. {example.cn}) — ordnen eingehende Mails automatisch zu (ab Stufe 2)';
comment on column partners.einkaeufer_id is
  'Zuständiger Einkäufer (Vorgabe für neue Bestellungen/Projekte und das Cockpit)';

-- --- 3. Dienstleistungen: kein Wareneingang, Abrechnung nach Bestellmenge ----

-- Dienstleistungen haben keine Eingangsmenge — abgerechnet wird, was bestellt ist.
create or replace function product_template_dienstleistung_abrechnung()
returns trigger language plpgsql as $$
begin
  if new.type = 'service' then
    new.bill_policy := 'ordered';
  end if;
  return new;
end $$;

create trigger product_templates_dienstleistung_abrechnung
  before insert or update of type, bill_policy on product_templates
  for each row execute function product_template_dienstleistung_abrechnung();

update product_templates set bill_policy = 'ordered'
where type = 'service' and bill_policy <> 'ordered';

-- Voller Körper aus 0019; neu: nur Lagerware erzeugt Bewegungen, ohne
-- Lagerware entsteht kein Eingangs-Transfer (Rückgabe null).
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
  v_rate := case when o.exchange_rate <> 1 then o.exchange_rate
                 else exchange_rate_at(o.currency, current_date) end;
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

-- prozess_beleg_daten: voller Körper aus 0068, neu `hat_lagerware` für
-- Bestellungen — die Weiche „Lagerware dabei?" im Bestellprozess liest es.
create or replace function prozess_beleg_daten(p_modell text, p_id uuid)
returns jsonb language plpgsql stable as $$
declare
  m prozess_modelle%rowtype;
  v_daten jsonb;
  v_herkunft_tabelle text;
  v_herkunft jsonb;
  v_noetig boolean;
  v_auto boolean;
  v_lagerware boolean;
begin
  select * into m from prozess_modelle where modell = p_modell;
  if not found then
    raise exception 'Unbekanntes Prozessmodell: %', p_modell;
  end if;
  execute format('select to_jsonb(t) from %I t where id = $1', m.tabelle)
    into v_daten using p_id;
  if v_daten is null then
    raise exception 'Datensatz % in % nicht gefunden', p_id, m.tabelle;
  end if;

  -- Herkunft anreichern: nur über den Modell-Katalog aufgelöst, damit auch
  -- hier nie ein Tabellenname aus Nutzerdaten in dynamisches SQL wandert.
  if v_daten ? 'origin_model' and v_daten ? 'origin_id'
     and v_daten ->> 'origin_model' is not null
     and v_daten ->> 'origin_id' is not null then
    select mm.tabelle into v_herkunft_tabelle
    from prozess_modelle mm where mm.modell = v_daten ->> 'origin_model';
    if v_herkunft_tabelle is not null then
      execute format('select to_jsonb(t) from %I t where id = $1', v_herkunft_tabelle)
        into v_herkunft using (v_daten ->> 'origin_id')::uuid;
      if v_herkunft is not null then
        select v_daten || jsonb_object_agg('herkunft_' || key, value)
          into v_daten
        from jsonb_each(v_herkunft);
      end if;
    end if;
  end if;

  -- Abgeleitete Felder aus den Positionen: ohne sie lässt sich der Zweig
  -- „Fertigung nötig?" im Verkaufsprozess nicht als Bedingung schreiben.
  if p_modell = 'sales_order' then
    select coalesce(bool_or(pt.route_manufacture and resolve_bom(l.variant_id) is not null), false),
           coalesce(bool_or(pt.route_manufacture and pt.route_mto
                            and resolve_bom(l.variant_id) is not null), false)
      into v_noetig, v_auto
    from sales_order_lines l
    join product_variants pv on pv.id = l.variant_id
    join product_templates pt on pt.id = pv.template_id
    where l.order_id = p_id;

    v_daten := v_daten || jsonb_build_object(
      'fertigung_noetig', coalesce(v_noetig, false),
      'fertigung_automatisch', coalesce(v_auto, false));
  end if;

  -- Einkauf (0092): enthält die Bestellung Lagerware? Ohne Positionen gilt
  -- „ja" — der gewohnte Weg über den Wareneingang bleibt der Normalfall.
  if p_modell = 'purchase_order' then
    select coalesce(bool_or(pt.type = 'goods'), true)
      into v_lagerware
    from purchase_order_lines l
    join product_variants pv on pv.id = l.variant_id
    join product_templates pt on pt.id = pv.template_id
    where l.order_id = p_id;

    v_daten := v_daten || jsonb_build_object('hat_lagerware', coalesce(v_lagerware, true));
  end if;

  return v_daten;
end $$;

-- Neue Version des Bestellprozesses: Weiche „Lagerware dabei?" nach dem
-- Bestätigen — nur mit Lagerware in den Teilprozess Wareneingang.
do $$
declare
  v_neu uuid;
begin
  v_neu := prozess_version_kopieren('einkauf_wareneingang_rechnung', 'migration:0092');

  insert into prozess_schritte (version_id, code, name, art, sequence, optional)
  values (v_neu, 'lagerware', 'Lagerware dabei?', 'xor', 32, false);

  delete from prozess_uebergaenge
  where version_id = v_neu and von_code = 'bestaetigen' and nach_code = 'wareneingang';

  -- Ohne Lagerware stehen Rechnung erstellen UND Abrechnung nebeneinander —
  -- wie nach dem durchlaufenen Wareneingang (0050); beide Kanten bedingt,
  -- damit der Lagerweg sie nicht vorzeitig anbietet.
  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, bedingung, beschriftung)
  values
    (v_neu, 'bestaetigen', 'lagerware',    10, null, null),
    (v_neu, 'lagerware',   'wareneingang', 10,
     '{"feld": "hat_lagerware", "op": "=", "wert": true}'::jsonb, 'Ware kommt an'),
    (v_neu, 'lagerware',   'rechnung',     20,
     '{"feld": "hat_lagerware", "op": "=", "wert": false}'::jsonb, 'nur Dienstleistung'),
    (v_neu, 'lagerware',   'abrechnung',   30,
     '{"feld": "hat_lagerware", "op": "=", "wert": false}'::jsonb, null);

  perform prozess_version_aktivieren(v_neu);
end $$;

-- --- 4. Einkaufspreise auf 6 Nachkommastellen -------------------------------

-- DESTRUKTIV: der Freigabe-Trigger (0056) nennt price_unit und blockiert die Typänderung — er wird direkt danach unverändert neu angelegt.
drop trigger purchase_order_freigabe_reset on purchase_order_lines;
-- DESTRUKTIV: nur Verbreiterung numeric(16,2) → numeric(18,6); keine Sicht hängt an den Spalten, bestehende Werte bleiben exakt erhalten.
alter table purchase_order_lines alter column price_unit type numeric(18,6);
alter table vendor_prices        alter column price      type numeric(18,6);
alter table vendor_bill_lines    alter column price_unit type numeric(18,6);
create trigger purchase_order_freigabe_reset
after insert or delete or update of qty, price_unit, discount
on purchase_order_lines
for each row execute function purchase_order_freigabe_reset();

-- --- 5. Protokoll der Außenaufrufe: Google und EZB -----------------------------

-- DESTRUKTIV: Constraint wird nur um 'google' und 'ezb' erweitert (Muster 0084), keine Zeile wird ungültig.
alter table api_transactions drop constraint api_transactions_system_check;
alter table api_transactions
  add constraint api_transactions_system_check
  check (system in ('shopify', 'dhl', 'mail', 'telegram', 'google', 'ezb'));
