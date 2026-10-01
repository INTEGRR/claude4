-- ============================================================================
-- 0108  Einkauf, Stufe 5 — Eingangssendungen (Sammelfracht), Zoll,
--       Pflichtdokumente, Einkaufs-Cockpit, DATEV-Vorbereitung
-- ----------------------------------------------------------------------------
-- Der Betreiber (Interview 2026-09-29): Sammelsendungen mit mehreren
-- Bestellungen kommen oft vor (K+N See/Luft, Express vom Lieferanten),
-- Zollunterlagen je Sendung, Fracht und Zoll als Einstandskosten, EUSt
-- GETRENNT; Pflichtdokumente je Bestellung (PI vor der Anzahlung, CI +
-- Packing List bei Versand, Endrechnung) und je Sendung (Fracht-/Zollbelege);
-- Wiedervorlagen im Cockpit plus tägliche Zusammenfassung im Telegram-Chat,
-- gegliedert nach Einkäufer; lernende Schätzwerte für Fracht und Zoll.
--
--  1. Eingangssendung (ES/…) als Beleg mit eigenem Prozess
--     `eingangs_sendung`, n:m zu Bestellungen, Wareneingänge hängen über
--     stock_pickings.eingangs_sendung_id an der Sendung (Teilprozess
--     Wareneingang). Die Sendung schreibt Verschiffungstag, ETA und Tracking
--     auf ihre Bestellungen — `verschifft_am` ist genau der Fakt, aus dem
--     zahlplan_faelligkeit die Raten „bei Verschiffung" fällig rechnet.
--  2. Kosten je Sendung (Fracht, Zoll, EUSt, Versicherung, Sonstiges;
--     Schätzung oder Rechnung) und Zollzeilen je HS-Code.
--     eingangs_sendung_verteilen() legt je Kostenposition und Wareneingang
--     einen landed_costs-Satz an und bucht ihn über das UNVERÄNDERTE
--     landed_cost_post; die EUSt wird nie verteilt. Schätzung → Rechnung:
--     landed_cost_post kennt keine negativen Beträge, deshalb Storno der
--     Schätzung (landed_cost_cancel) und Neubuchung (corrects_id).
--  3. Lernende Schätzwerte: Sicht einkauf_einstand_vorschlaege (EUR/kg je
--     Modus, echte Zollsätze je HS-Präfix aus abgerechneten Sendungen) —
--     Vorschlag, übernommen wird per Aktion.
--  4. Pflichtdokumente als Daten (pflichtdokument_regeln, Bedingungssprache
--     über prozess_beleg_daten) und Sicht einkauf_offene_pflichtdokumente.
--  5. Cockpit-Sicht einkauf_cockpit; überfällige ETA als regelbasierte
--     Wiedervorlage.
--  6. Benachrichtigungsart 'einkauf' (tägliche Zusammenfassung).
--  7. DATEV nur VORBEREITET (Betreiber 2026-10-01): Sicht
--     einkauf_datev_vorbereitung, kein Versand.
--
-- Entscheidungslog 2026-10-01, „Einkauf Stufe 5".
-- ============================================================================

-- --- 0. Kleine Helfer ----------------------------------------------------------

-- Drittland = außerhalb der EU-27: dort braucht es CI, Packing List und
-- Zollbescheid. Ohne Länderangabe gilt „nicht Drittland" (keine Pflicht
-- aus geratenen Daten).
create or replace function land_drittland(p_land text)
returns boolean
language sql immutable as $$
  select coalesce(btrim(p_land), '') <> ''
     and upper(btrim(p_land)) <> all (array[
       'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
       'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'])
$$;

comment on function land_drittland(text) is
  'true für Länder außerhalb der EU-27 (0108) — CI, Packing List und Zollbescheid sind dort Pflicht';

-- Detailseite eines Einkaufsbelegs (Cockpit, Pflichtdokumente, Digest).
create or replace function einkauf_beleg_link(p_modell text, p_id uuid)
returns text
language sql immutable as $$
  select case p_modell
    when 'purchase_order'     then '/einkauf/' || p_id
    when 'vendor_bill'        then '/einkauf/rechnungen/' || p_id
    when 'partner'            then '/einkauf/lieferanten/' || p_id
    when 'mail_thread'        then '/einkauf/posteingang/' || p_id
    when 'mail_entwurf'       then '/einkauf/entwuerfe/' || p_id
    when 'einkaufsprojekt'    then '/einkauf/projekte/' || p_id
    when 'bemusterung'        then '/einkauf/muster/' || p_id
    when 'werkzeug'           then '/einkauf/werkzeuge/' || p_id
    when 'lieferantenvertrag' then '/einkauf/vertraege/' || p_id
    when 'eingangs_sendung'   then '/einkauf/sendungen/' || p_id
    when 'stock_picking'      then '/lager/' || p_id
  end
$$;

create or replace function eingangs_sendung_kostenart_text(p_art text)
returns text
language sql immutable as $$
  select case p_art
    when 'fracht'       then 'Fracht'
    when 'zoll'         then 'Zoll'
    when 'eust'         then 'Einfuhrumsatzsteuer'
    when 'versicherung' then 'Versicherung'
    else 'Sonstiges'
  end
$$;

-- --- 1. Eingangssendung ------------------------------------------------------------

insert into sequences (code, prefix, padding) values ('eingangs_sendung', 'ES/', 5)
on conflict (code) do nothing;

create type eingangs_sendung_status as enum
  ('geplant', 'verschifft', 'verzollt', 'angekommen', 'abgerechnet', 'storniert');

create table eingangs_sendungen (
  id              uuid primary key default gen_random_uuid(),
  nummer          text not null unique,
  bezeichnung     text,
  status          eingangs_sendung_status not null default 'geplant',
  modus           text not null default 'see' check (modus in ('see', 'luft', 'express')),
  -- Spediteur (K+N) bzw. Kurier als Lieferant — er schickt die Frachtrechnung.
  spediteur_id    uuid references partners on delete set null,
  -- Reederei, Airline oder Kurierdienst (frei, z. B. „Maersk", „DHL Express").
  traeger         text,
  hbl_awb         text,
  container       text,
  tracking_url    text,
  etd             date,
  eta             date,
  verschifft_am   date,
  verzollt_am     date,
  angekommen_am   date,
  abgerechnet_am  timestamptz,
  gewicht_kg      numeric(12,3) check (gewicht_kg >= 0),
  volumen_cbm     numeric(12,3) check (volumen_cbm >= 0),
  packstuecke     int check (packstuecke >= 0),
  zustaendig_id   uuid references users on delete set null,
  storno_grund    text,
  notiz           text,
  erstellt_von    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz
);
select attach_touch_trigger('eingangs_sendungen');
create index eingangs_sendungen_status_idx on eingangs_sendungen (status, created_at desc);

comment on table eingangs_sendungen is
  'Eingangssendungen (0108, ES/…): Sammelfracht mit einer oder mehreren Bestellungen — Spediteur, Modus see|luft|express, '
  'HBL/AWB, Container, ETD/ETA, kg, cbm, Packstücke. Prozess eingangs_sendung; Kosten in sendung_kosten, Zoll in sendung_zoll';

create table eingangs_sendung_bestellungen (
  sendung_id         uuid not null references eingangs_sendungen on delete cascade,
  purchase_order_id  uuid not null references purchase_orders on delete cascade,
  hinzugefuegt_von   text,
  created_at         timestamptz not null default now(),
  primary key (sendung_id, purchase_order_id)
);
create index eingangs_sendung_bestellungen_po_idx on eingangs_sendung_bestellungen (purchase_order_id);

comment on table eingangs_sendung_bestellungen is
  'Welche Bestellungen in welcher Eingangssendung reisen (0108, n:m — eine Bestellung kann auf zwei Sendungen verteilt sein)';

-- Der Wareneingang weiß, mit welcher Sendung er kam — verteilt wird auf die
-- gebuchten Eingänge der Sendung. Backorders erben das bewusst NICHT
-- (picking_validate kopiert die Spalte nicht): der Rest kommt mit einer
-- späteren Sendung.
alter table stock_pickings add column eingangs_sendung_id uuid references eingangs_sendungen on delete set null;
create index stock_pickings_sendung_idx on stock_pickings (eingangs_sendung_id) where eingangs_sendung_id is not null;

-- --- 2. Kosten und Zoll ---------------------------------------------------------

create table sendung_kosten (
  id                uuid primary key default gen_random_uuid(),
  sendung_id        uuid not null references eingangs_sendungen on delete cascade,
  art               text not null check (art in ('fracht', 'zoll', 'eust', 'versicherung', 'sonstiges')),
  betrag            numeric(18,2) not null check (betrag >= 0),
  waehrung          text not null default 'EUR' references currencies (code),
  -- EUR je Fremdeinheit, eingefroren beim Verteilen (ohne Angabe: Kurs am Belegdatum).
  kurs              numeric(18,8) check (kurs > 0),
  belegdatum        date,
  schaetzung        boolean not null default false,
  -- Aus dem Zollbescheid (einkauf.sendung_zoll_erfassen) — ein neuer Bescheid ersetzt sie.
  aus_zollbescheid  boolean not null default false,
  partner_id        uuid references partners on delete set null,
  vendor_bill_id    uuid references vendor_bills on delete set null,
  dokument_id       uuid references dokumente on delete set null,
  -- Schätzung → echte Rechnung: die Schätzung zeigt auf ihren Ersatz; beim
  -- Verteilen des Ersatzes werden ihre Landed Costs storniert.
  ersetzt_durch_id  uuid references sendung_kosten on delete set null,
  verteilt_am       timestamptz,
  storniert_am      timestamptz,
  notiz             text,
  erstellt_von      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz
);
select attach_touch_trigger('sendung_kosten');
create index sendung_kosten_sendung_idx on sendung_kosten (sendung_id, created_at);
create index sendung_kosten_bill_idx on sendung_kosten (vendor_bill_id) where vendor_bill_id is not null;

comment on table sendung_kosten is
  'Kosten einer Eingangssendung (0108): art fracht|zoll|eust|versicherung|sonstiges, Betrag + Währung, Schätzung oder Rechnung '
  '(vendor_bill_id, dokument_id). Aktiv = nicht storniert und nicht ersetzt. Alles außer EUSt wird auf die Wareneingänge verteilt';

create table sendung_zoll (
  id                 uuid primary key default gen_random_uuid(),
  sendung_id         uuid not null references eingangs_sendungen on delete cascade,
  purchase_order_id  uuid references purchase_orders on delete set null,
  hs_code            text not null check (hs_code ~ '^[0-9]{4,10}$'),
  ursprungsland      text,
  zollwert_eur       numeric(18,2) not null check (zollwert_eur >= 0),
  zoll_eur           numeric(18,2) not null default 0 check (zoll_eur >= 0),
  eust_eur           numeric(18,2) not null default 0 check (eust_eur >= 0),
  created_at         timestamptz not null default now()
);
create index sendung_zoll_sendung_idx on sendung_zoll (sendung_id);

comment on table sendung_zoll is
  'Zollzeilen einer Eingangssendung laut Zollbescheid (0108): HS-Code, Zollwert, Zoll und EUSt GETRENNT — Grundlage der '
  'lernenden Zollsätze (einkauf_einstand_vorschlaege)';

alter table landed_costs add column sendung_kosten_id uuid references sendung_kosten on delete set null;
create index landed_costs_sendung_kosten_idx on landed_costs (sendung_kosten_id) where sendung_kosten_id is not null;
comment on column landed_costs.sendung_kosten_id is
  'Kostenposition der Eingangssendung, aus der dieser Nebenkostenbeleg verteilt wurde (0108)';

-- --- 3. Sendung → Bestellungen (Verschiffung, ETA, Tracking) --------------------

-- Hängt die Wareneingänge der Bestellungen an die Sendung (die noch keiner
-- anderen gehören) und schreibt Verschiffungstag, ETA und Tracking auf die
-- Bestellungen. Über alle nicht stornierten Sendungen einer Bestellung gilt
-- der früheste Verschiffungstag (er löst die Raten „bei Verschiffung" aus,
-- zahlplan_faelligkeit liest purchase_orders.verschifft_am) und das späteste
-- ETA der noch reisenden Sendungen.
create or replace function eingangs_sendung_synchronisieren(p_sendung uuid, p_actor text default 'system')
returns int
language plpgsql
set search_path = public, pg_temp as $$
declare
  s eingangs_sendungen%rowtype;
  r record;
  v_verschifft date;
  v_eta date;
  v_neu_verschifft date;
  v_neu_eta date;
  v_traeger text;
  v_tracking text;
  n int := 0;
begin
  select * into s from eingangs_sendungen where id = p_sendung;
  if s.id is null then raise exception 'Eingangssendung nicht gefunden'; end if;

  if s.status <> 'storniert' then
    update stock_pickings p set eingangs_sendung_id = s.id
    from eingangs_sendung_bestellungen b
    where b.sendung_id = s.id
      and p.origin_model = 'purchase_order' and p.origin_id = b.purchase_order_id
      and p.eingangs_sendung_id is null and p.state <> 'cancel';
  end if;

  v_traeger := coalesce(nullif(btrim(s.traeger), ''), (select pa.name from partners pa where pa.id = s.spediteur_id));
  v_tracking := coalesce(nullif(btrim(s.hbl_awb), ''), nullif(btrim(s.container), ''));

  for r in
    select po.id, po.number, po.verschifft_am, po.eta_confirmed, po.carrier, po.tracking_number, po.tracking_url
    from purchase_orders po
    join eingangs_sendung_bestellungen b on b.purchase_order_id = po.id
    where b.sendung_id = s.id and po.state <> 'cancel'
  loop
    select min(s2.verschifft_am),
           max(s2.eta) filter (where s2.status in ('geplant', 'verschifft', 'verzollt'))
      into v_verschifft, v_eta
    from eingangs_sendungen s2
    join eingangs_sendung_bestellungen b2 on b2.sendung_id = s2.id
    where b2.purchase_order_id = r.id and s2.status <> 'storniert';

    v_neu_verschifft := coalesce(v_verschifft, r.verschifft_am);
    -- Storno der einzigen verschifften Sendung nimmt ihren Tag wieder weg.
    if v_verschifft is null and s.status = 'storniert' and r.verschifft_am = s.verschifft_am then
      v_neu_verschifft := null;
    end if;
    v_neu_eta := coalesce(v_eta, r.eta_confirmed);

    if v_neu_verschifft is distinct from r.verschifft_am
       or v_neu_eta is distinct from r.eta_confirmed
       or (s.status <> 'storniert' and (
             coalesce(v_traeger, r.carrier) is distinct from r.carrier
             or coalesce(v_tracking, r.tracking_number) is distinct from r.tracking_number
             or coalesce(nullif(btrim(s.tracking_url), ''), r.tracking_url) is distinct from r.tracking_url)) then
      update purchase_orders set
        verschifft_am = v_neu_verschifft,
        eta_confirmed = v_neu_eta,
        carrier = case when s.status <> 'storniert' then coalesce(v_traeger, carrier) else carrier end,
        tracking_number = case when s.status <> 'storniert' then coalesce(v_tracking, tracking_number) else tracking_number end,
        tracking_url = case when s.status <> 'storniert' then coalesce(nullif(btrim(s.tracking_url), ''), tracking_url) else tracking_url end
      where id = r.id;
      n := n + 1;

      if r.verschifft_am is null and v_neu_verschifft is not null then
        perform log_event('purchase_order', r.id, 'info',
          format('Verschifft am %s mit %s — Zahlplan-Raten „bei Verschiffung" sind ab jetzt fällig',
                 to_char(v_neu_verschifft, 'DD.MM.YYYY'), s.nummer), p_actor);
      elsif r.verschifft_am is not null and v_neu_verschifft is null then
        perform log_event('purchase_order', r.id, 'info',
          format('Verschiffung zurückgenommen (%s storniert)', s.nummer), p_actor);
      end if;
      if v_neu_eta is distinct from r.eta_confirmed then
        perform purchase_order_eta_sync(r.id);
      end if;
    end if;
  end loop;
  return n;
end $$;

comment on function eingangs_sendung_synchronisieren(uuid, text) is
  'Sendung → Bestellungen (0108): Wareneingänge anhängen, verschifft_am (Zahlplan-Auslöser), ETA und Tracking schreiben';

-- --- 4. Verteilen auf die Wareneingänge (Landed Costs) -------------------------

-- Verteilt jede noch nicht verteilte, aktive Kostenposition (außer EUSt) auf
-- die gebuchten Wareneingänge der Sendung:
--   Schlüssel: Fracht nach Gewicht, wenn JEDE gebuchte Position ein Gewicht
--   hat (der Spediteur rechnet nach Gewicht/Raum, nicht nach Wert), sonst
--   nach Warenwert; Zoll, Versicherung, Sonstiges nach Warenwert (Zoll ist
--   ein Wertzoll). Ohne Basis gleichmäßig.
--   Je Eingang ein landed_costs-Satz (sendung_kosten_id), gebucht über das
--   unveränderte landed_cost_post (das innerhalb des Eingangs dieselbe
--   Basis nutzt). Beträge auf den Cent, der Rundungsrest geht auf den
--   letzten Eingang — die Summe ist exakt der Kostenbetrag.
--   Ersetzt die Position Schätzungen, werden deren Landed Costs zuerst
--   storniert (landed_cost_cancel) und die neuen zeigen per corrects_id
--   darauf: netto bucht das genau die Differenz.
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
             to_char(k.betrag, 'FM999G999G990D00'), k.waehrung,
             case when k.schaetzung then ' (Schätzung)' else '' end,
             v_n, case when v_nach_gewicht then 'Gewicht' else 'Warenwert' end,
             case when v_storniert > 0 then format(' — Korrektur: %s Nebenkostenbeleg(e) der Schätzung storniert', v_storniert)
                  else '' end),
      p_actor);
  end loop;
  return v_gebucht;
end $$;

comment on function eingangs_sendung_verteilen(uuid, text) is
  'Verteilt die offenen Kosten einer Eingangssendung (ohne EUSt) anteilig auf ihre gebuchten Wareneingänge: je Eingang ein '
  'landed_costs-Satz über landed_cost_post, Rundungsrest auf den letzten; Schätzung → Rechnung als Storno + Neubuchung (0108)';

-- Kostenposition stornieren: gebuchte Landed Costs zurücknehmen; ersetzte
-- Schätzungen leben wieder auf (und werden neu verteilt, falls ihre Buchung
-- schon zurückgenommen war).
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
    format('%s %s %s%s storniert', eingangs_sendung_kostenart_text(k.art), to_char(k.betrag, 'FM999G999G990D00'), k.waehrung,
           case when k.schaetzung then ' (Schätzung)' else '' end), p_actor);
end $$;

-- Abrechnen: alle Eingänge gebucht, keine Schätzung mehr offen, Rest
-- verteilen, Status `abgerechnet` (Grundlage der lernenden Schätzwerte).
create or replace function eingangs_sendung_abrechnen(p_sendung uuid, p_actor text default 'system')
returns int
language plpgsql
set search_path = public, pg_temp as $$
declare
  s eingangs_sendungen%rowtype;
  v_schaetzungen text;
  v_gebucht int;
begin
  select * into s from eingangs_sendungen where id = p_sendung for update;
  if s.id is null then raise exception 'Eingangssendung nicht gefunden'; end if;
  if s.status <> 'angekommen' then
    raise exception '% ist %, abgerechnet wird eine angekommene Sendung', s.nummer, s.status;
  end if;
  if not exists (select 1 from stock_pickings where eingangs_sendung_id = s.id and state = 'done') then
    raise exception '% hat keinen gebuchten Wareneingang — erst Bestellungen zuordnen und den Eingang buchen', s.nummer;
  end if;

  select string_agg(distinct eingangs_sendung_kostenart_text(k.art), ', ') into v_schaetzungen
  from sendung_kosten k
  where k.sendung_id = s.id and k.schaetzung and k.storniert_am is null and k.ersetzt_durch_id is null;
  if v_schaetzungen is not null then
    raise exception 'Noch geschätzt: % — erst die Rechnung bzw. den Zollbescheid erfassen oder die Schätzung entfernen', v_schaetzungen;
  end if;

  v_gebucht := eingangs_sendung_verteilen(p_sendung, p_actor);
  update eingangs_sendungen set status = 'abgerechnet', abgerechnet_am = now() where id = s.id;
  perform log_event('eingangs_sendung', s.id, 'state', 'Abgerechnet — Kosten auf die Wareneingänge verteilt', p_actor);
  return v_gebucht;
end $$;

-- --- 5. Schätzung aus Frachtsätzen und Zolltarifen ------------------------------

-- Fracht = kg × Satz des Modus (mindestens Mindestbetrag); kg aus der
-- Sendung, sonst aus Bestellmenge × Artikelgewicht (D-Klauseln ohne Fracht).
-- Zoll = Σ Warenwert × Satz des längsten HS-Präfixes, auf (Ware + Fracht)
-- hochgerechnet (Zollwert CIF); DDP ohne Zoll. EUSt wird nicht geschätzt.
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
                        to_char(round(v_kg, 1), 'FM999G999G990D0'), v_kg_quelle,
                        to_char(v_satz.eur_je_kg, 'FM990D00'),
                        case s.modus when 'see' then 'See' when 'luft' then 'Luft' else 'Express' end,
                        to_char(v_satz.mindestbetrag_eur, 'FM999G990D00'));
    return next;
  end if;

  if v_zoll > 0 then
    art := 'zoll';
    betrag := round(v_zoll * (1 + coalesce(v_fracht, 0) / nullif(v_ware, 0)), 2);
    grundlage := format('Zollwert ≈ Ware %s € + Fracht, Sätze je HS-Präfix%s',
                        to_char(round(v_ware, 2), 'FM999G999G990D00'),
                        case when v_ohne_satz > 0 then format(' — %s Position(en) ohne Zollsatz', v_ohne_satz) else '' end);
    return next;
  end if;
end $$;

comment on function eingangs_sendung_schaetzung(uuid) is
  'Schätzt Fracht (kg × frachtsaetze) und Zoll (Warenwert × zolltarife, auf Ware + Fracht) einer Eingangssendung (0108); EUSt nie';

-- --- 6. Prozess „Eingangssendung" ----------------------------------------------

insert into prozess_modelle (modell, tabelle, status_spalte, routen_muster)
values ('eingangs_sendung', 'eingangs_sendungen', 'status', '/einkauf/sendungen/:id');

do $$
declare
  v_prozess uuid;
  v_version uuid;
begin
  insert into prozesse (code, name, beschreibung, bereich, modell)
  values ('eingangs_sendung', 'Eingangssendung',
          'Sammelfracht mit einer oder mehreren Bestellungen: verschiffen (die Zahlplan-Raten „bei Verschiffung" werden '
          || 'fällig), verzollen, ankommen, Wareneingänge buchen, abrechnen — Fracht, Zoll und Versicherung als Landed '
          || 'Costs auf die Eingänge verteilt, die EUSt getrennt.',
          'einkauf', 'eingangs_sendung')
  returning id into v_prozess;

  insert into prozess_versionen (prozess_id, version, status, created_by)
  values (v_prozess, 1, 'entwurf', 'migration:0108')
  returning id into v_version;

  insert into prozess_schritte (version_id, code, name, art, sequence, aktion, zustand, teilprozess, teilprozess_link)
  values
    (v_version, 'start',        'Ware ist bestellt',            'start',   0,  null,                         null,          null,           null),
    (v_version, 'anlegen',      'Sendung anlegen',              'aktion',  10, 'einkauf.sendung_anlegen',     'geplant',     null,           null),
    (v_version, 'verschiffen',  'Verschifft (Raten fällig)',    'aktion',  20, 'einkauf.sendung_verschiffen', 'verschifft',  null,           null),
    (v_version, 'verzollen',    'Verzollt',                     'aktion',  30, 'einkauf.sendung_verzollen',   'verzollt',    null,           null),
    (v_version, 'ankommen',     'Angekommen',                   'aktion',  40, 'einkauf.sendung_ankommen',    'angekommen',  null,           null),
    (v_version, 'wareneingang', 'Wareneingänge buchen',         'prozess', 50, null,                          null,          'wareneingang', '{"spalte": "eingangs_sendung_id"}'::jsonb),
    (v_version, 'abrechnen',    'Abrechnen (Kosten verteilen)', 'aktion',  60, 'einkauf.sendung_abrechnen',   'abgerechnet', null,           null),
    (v_version, 'stornieren',   'Stornieren',                   'aktion',  70, 'einkauf.sendung_stornieren',  'storniert',   null,           null),
    (v_version, 'ende',         'Erledigt',                     'ende',    90, null,                          null,          null,           null);

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
  values
    (v_version, 'start',        'anlegen',      10, null),
    (v_version, 'anlegen',      'verschiffen',  10, null),
    (v_version, 'anlegen',      'stornieren',   20, 'Buchung entfällt'),
    (v_version, 'verschiffen',  'verzollen',    10, 'See/Luft: Spediteur verzollt'),
    (v_version, 'verschiffen',  'ankommen',     20, 'Kurier verzollt selbst'),
    (v_version, 'verschiffen',  'stornieren',   30, null),
    (v_version, 'verzollen',    'ankommen',     10, null),
    (v_version, 'ankommen',     'wareneingang', 10, null),
    (v_version, 'wareneingang', 'abrechnen',    10, 'alle Eingänge gebucht'),
    (v_version, 'abrechnen',    'ende',         10, null),
    (v_version, 'stornieren',   'ende',         10, null);

  perform prozess_version_aktivieren(v_version);
end $$;

insert into prozess_routen (pfad_muster, prozess_code, schritt_code)
values ('/einkauf/sendungen', 'eingangs_sendung', null)
on conflict (pfad_muster) do nothing;

update prozess_pakete
   set prozess_codes = array_append(prozess_codes, 'eingangs_sendung')
 where 'einkaufsprojekt' = any(prozess_codes)
   and not ('eingangs_sendung' = any(prozess_codes));

-- --- 7. prozess_beleg_daten: Felder für Pflichtdokumente --------------------------

-- Voller Körper aus 0107; neu für Bestellungen drittland, hat_anzahlung,
-- ware_eingegangen, eingang_am und für Eingangssendungen zoll_noetig — die
-- Bedingungen der Pflichtdokument-Regeln lesen sie.
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

    -- Einkauf (0108): Grundlagen der Pflichtdokument-Regeln.
    v_daten := v_daten || jsonb_build_object(
      'drittland', coalesce((select land_drittland(pa.country_code) from partners pa
                             where pa.id = (v_daten ->> 'vendor_id')::uuid), false),
      'hat_anzahlung', exists (select 1 from zahlplan_raten r
                               where r.purchase_order_id = p_id and r.ausloeser = 'bestellung'),
      'ware_eingegangen', exists (select 1 from stock_pickings sp
                                  where sp.origin_model = 'purchase_order' and sp.origin_id = p_id
                                    and sp.state = 'done'),
      'eingang_am', (select max(sp.date_done)::date from stock_pickings sp
                     where sp.origin_model = 'purchase_order' and sp.origin_id = p_id and sp.state = 'done'));
  end if;

  -- Einkauf (0107): liegt das Golden Sample des gewählten Lieferanten vor?
  if p_modell = 'einkaufsprojekt' then
    v_daten := v_daten || jsonb_build_object('golden_sample',
      coalesce(einkaufsprojekt_golden_sample(p_id, (v_daten ->> 'gewaehltes_angebot_id')::uuid), false));
  end if;

  -- Einkauf (0108): braucht die Sendung einen Zollbescheid (Ware aus einem Drittland)?
  if p_modell = 'eingangs_sendung' then
    v_daten := v_daten || jsonb_build_object('zoll_noetig', exists (
      select 1 from eingangs_sendung_bestellungen b
      join purchase_orders po on po.id = b.purchase_order_id
      join partners pa on pa.id = po.vendor_id
      where b.sendung_id = p_id and land_drittland(pa.country_code)));
  end if;

  return v_daten;
end $$;

-- --- 8. Pflichtdokumente ------------------------------------------------------------

create table pflichtdokument_regeln (
  id             uuid primary key default gen_random_uuid(),
  modell         text not null check (modell in ('purchase_order', 'eingangs_sendung')),
  art            dokument_art not null,
  bezeichnung    text not null,
  -- Bedingungssprache (bedingung_pruefen) über prozess_beleg_daten(modell, id).
  bedingung      jsonb not null,
  -- Feld aus prozess_beleg_daten, ab dem die Frist läuft (Datum/Zeitpunkt).
  stichtag_feld  text,
  frist_tage     int not null default 0 check (frist_tage between 0 and 365),
  aktiv          boolean not null default true,
  -- Belege, die vor diesem Tag angelegt wurden, prüft die Regel nicht —
  -- sonst fehlte nach dem Einspielen jeder Altbestellung jedes Dokument.
  gilt_ab        date not null default current_date,
  sequence       int not null default 10,
  geaendert_von  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz,
  unique (modell, art)
);
select attach_touch_trigger('pflichtdokument_regeln');

comment on table pflichtdokument_regeln is
  'Pflichtdokumente als Daten (0108): je Beleg (Bestellung, Eingangssendung) und Dokumentart eine Bedingung über '
  'prozess_beleg_daten, Stichtag + Frist; gilt für Belege ab gilt_ab. Einrichtung (übersteht „Betriebsdaten löschen")';

insert into pflichtdokument_regeln (modell, art, bezeichnung, bedingung, stichtag_feld, frist_tage, sequence) values
  ('purchase_order', 'pi', 'Proforma Invoice (vor der Anzahlung)',
   '{"alle": [{"feld": "state", "op": "in", "wert": ["purchase", "done"]},
              {"feld": "hat_anzahlung", "op": "=", "wert": true}]}', 'confirmed_at', 0, 10),
  ('purchase_order', 'ci', 'Commercial Invoice (ab Verschiffung)',
   '{"alle": [{"feld": "state", "op": "in", "wert": ["purchase", "done"]},
              {"feld": "drittland", "op": "=", "wert": true},
              {"feld": "verschifft_am", "op": "nicht_leer"}]}', 'verschifft_am', 0, 20),
  ('purchase_order', 'packing_list', 'Packing List (ab Verschiffung)',
   '{"alle": [{"feld": "state", "op": "in", "wert": ["purchase", "done"]},
              {"feld": "drittland", "op": "=", "wert": true},
              {"feld": "verschifft_am", "op": "nicht_leer"}]}', 'verschifft_am', 0, 30),
  ('purchase_order', 'rechnung', 'Endrechnung (ab Wareneingang)',
   '{"alle": [{"feld": "state", "op": "in", "wert": ["purchase", "done"]},
              {"eine": [{"feld": "ware_eingegangen", "op": "=", "wert": true},
                        {"feld": "hat_lagerware", "op": "=", "wert": false}]}]}', 'eingang_am', 7, 40),
  ('eingangs_sendung', 'rechnung', 'Spediteursrechnung (ab Ankunft)',
   '{"alle": [{"feld": "status", "op": "in", "wert": ["angekommen", "abgerechnet"]},
              {"feld": "spediteur_id", "op": "nicht_leer"}]}', 'angekommen_am', 14, 50),
  ('eingangs_sendung', 'zollbescheid', 'Zollbescheid (ab Ankunft)',
   '{"alle": [{"feld": "status", "op": "in", "wert": ["angekommen", "abgerechnet"]},
              {"feld": "zoll_noetig", "op": "=", "wert": true}]}', 'angekommen_am', 7, 60);

-- Welches Pflichtdokument fehlt an welchem Beleg (fällig = Stichtag + Frist
-- erreicht)? Ein Dokument zählt, wenn es in der passenden Art verknüpft ist:
-- an der Bestellung selbst, an einer ihrer Rechnungen, an einer ihrer
-- Sendungen (dann nur vom selben Lieferanten); an der Sendung selbst oder an
-- einer Rechnung ihrer Kostenpositionen.
create or replace view einkauf_offene_pflichtdokumente as
with kandidaten as materialized (
  select 'purchase_order'::text as modell, po.id as record_id, po.number as nummer, po.vendor_id as partner_id,
         coalesce(po.user_id, pa.einkaeufer_id) as zustaendig_id, po.created_at,
         prozess_beleg_daten('purchase_order', po.id) as daten
  from purchase_orders po
  join partners pa on pa.id = po.vendor_id
  where po.state in ('purchase', 'done')
    and po.created_at::date >= (select min(r.gilt_ab) from pflichtdokument_regeln r
                                where r.modell = 'purchase_order' and r.aktiv)
  union all
  select 'eingangs_sendung', s.id, s.nummer, s.spediteur_id, s.zustaendig_id, s.created_at,
         prozess_beleg_daten('eingangs_sendung', s.id)
  from eingangs_sendungen s
  where s.status in ('angekommen', 'abgerechnet')
    and s.created_at::date >= (select min(r.gilt_ab) from pflichtdokument_regeln r
                               where r.modell = 'eingangs_sendung' and r.aktiv)
),
faellig as (
  select k.modell, k.record_id, k.nummer, k.partner_id, k.zustaendig_id,
         r.id as regel_id, r.art, r.bezeichnung, r.sequence,
         (case when r.stichtag_feld is not null and k.daten ->> r.stichtag_feld is not null
               then (left(k.daten ->> r.stichtag_feld, 10))::date + r.frist_tage end) as faellig_am
  from kandidaten k
  join pflichtdokument_regeln r on r.modell = k.modell and r.aktiv and k.created_at::date >= r.gilt_ab
  where bedingung_pruefen(k.daten, r.bedingung)
)
select f.regel_id, f.modell, f.record_id, f.nummer, f.partner_id, f.zustaendig_id,
       f.art::text as art, f.bezeichnung, f.faellig_am,
       einkauf_beleg_link(f.modell, f.record_id) as link
from faellig f
where coalesce(f.faellig_am, current_date) <= current_date
  and not exists (
    select 1
    from dokument_verweise v
    join dokumente d on d.id = v.dokument_id
    where d.art::text = f.art::text
      and (
        (v.modell = f.modell and v.record_id = f.record_id)
        or (f.modell = 'purchase_order' and v.modell = 'vendor_bill'
            and v.record_id in (select vb.id from vendor_bills vb
                                where vb.purchase_order_id = f.record_id and vb.state <> 'cancel'))
        or (f.modell = 'purchase_order' and v.modell = 'eingangs_sendung'
            and (d.partner_id is null or d.partner_id = f.partner_id)
            and v.record_id in (select b.sendung_id from eingangs_sendung_bestellungen b
                                where b.purchase_order_id = f.record_id))
        or (f.modell = 'eingangs_sendung' and v.modell = 'vendor_bill'
            and v.record_id in (select k2.vendor_bill_id from sendung_kosten k2
                                where k2.sendung_id = f.record_id and k2.storniert_am is null
                                  and k2.vendor_bill_id is not null))
      ));

comment on view einkauf_offene_pflichtdokumente is
  'Fehlende Pflichtdokumente (0108): je Beleg und Regel, wenn die Bedingung greift, Stichtag + Frist erreicht ist und kein '
  'Dokument der Art verknüpft ist (an Bestellung, ihrer Rechnung, ihrer Sendung bzw. an Sendung und Kostenrechnung)';

-- Mail-Vorlage „Fehlende Dokumente nachfragen" in drei Sprachen.
-- DESTRUKTIV: Check-Constraint mail_vorlagen_anlass_check wird nur um 'dokumente_nachfragen' erweitert — keine Zeile geht verloren.
alter table mail_vorlagen drop constraint mail_vorlagen_anlass_check;
alter table mail_vorlagen add constraint mail_vorlagen_anlass_check
  check (anlass in ('anfrage', 'pi_anfordern', 'liefertermin', 'muster_feedback', 'bestellung', 'dokumente_nachfragen'));

insert into mail_vorlagen (anlass, sprache, betreff, text) values
  ('dokumente_nachfragen', 'de', 'Fehlende Dokumente zu {{bestellnummer}}',
   E'Guten Tag {{ansprechpartner}},\n\nzu {{bestellnummer}} fehlen uns noch folgende Dokumente:\n\n{{dokumente}}\n\nBitte senden Sie sie uns als PDF per Mail. Ohne diese Unterlagen können wir Zahlung, Verzollung bzw. Buchhaltung nicht abschließen.\n\nVielen Dank und freundliche Grüße\n{{einkaeufer}}\n{{firma}}'),
  ('dokumente_nachfragen', 'en', 'Missing documents for {{bestellnummer}}',
   E'Dear {{ansprechpartner}},\n\nfor {{bestellnummer}} we are still missing the following documents:\n\n{{dokumente}}\n\nPlease send them to us as PDF by email. Without them we cannot complete payment, customs clearance or accounting.\n\nThank you and best regards\n{{einkaeufer}}\n{{firma}}'),
  ('dokumente_nachfragen', 'zh', '{{bestellnummer}} 缺少的单据',
   E'{{ansprechpartner}}，您好！\n\n关于 {{bestellnummer}}，我们还缺少以下单据：\n\n{{dokumente}}\n\n请将以上单据以 PDF 格式通过邮件发送给我们。缺少这些单据，我们无法完成付款、清关或记账。\n\n谢谢！\n{{einkaeufer}}\n{{firma}}')
on conflict (anlass, sprache) do nothing;

-- --- 9. Telegram: tägliche Einkaufs-Zusammenfassung ------------------------------

-- DESTRUKTIV: Check-Constraint benachrichtigungen_art_check wird nur um 'einkauf' erweitert — keine Zeile geht verloren.
alter table benachrichtigungen drop constraint benachrichtigungen_art_check;
alter table benachrichtigungen add constraint benachrichtigungen_art_check
  check (art in ('login', 'fehlversuch', 'sperre', 'job', 'dienst', 'test', 'einkauf'));

-- --- 10. Regelbasierte Wiedervorlagen: überfällige ETA ---------------------------

-- Voller Körper aus 0107; neu: Bestellungen, deren (bestätigtes) ETA
-- verstrichen ist, während der Wareneingang noch offen ist — von Stufe 2a
-- angekündigt („ETA überfällig kommt mit dem Cockpit"). Verschwindet mit dem
-- Eingang oder einem neuen ETA (auch aus der Sendung).
create or replace view einkauf_regel_wiedervorlagen as
select 'vertrag_frist'::text                                   as regel,
       'lieferantenvertrag'::text                              as modell,
       v.id                                                    as record_id,
       v.partner_id,
       (s.stichtag - v.erinnerung_tage)                        as faellig_am,
       s.stichtag                                              as frist,
       case
         when s.ende < current_date then
           format('%s „%s" ist am %s abgelaufen — verlängern oder beenden', a.label, v.titel, to_char(s.ende, 'DD.MM.YYYY'))
         when v.verlaengerung_monate is not null then
           format('%s „%s" verlängert sich am %s um %s Monate — kündigen bis %s', a.label, v.titel,
                  to_char(s.ende, 'DD.MM.YYYY'), v.verlaengerung_monate, to_char(s.stichtag, 'DD.MM.YYYY'))
         when v.kuendigungsfrist_monate > 0 then
           format('%s „%s" läuft am %s aus — Kündigungsfrist bis %s', a.label, v.titel,
                  to_char(s.ende, 'DD.MM.YYYY'), to_char(s.stichtag, 'DD.MM.YYYY'))
         else
           format('%s „%s" läuft am %s aus', a.label, v.titel, to_char(s.ende, 'DD.MM.YYYY'))
       end                                                     as grund,
       p.einkaeufer_id                                         as zustaendig_id
from lieferantenvertraege v
join partners p on p.id = v.partner_id
cross join lateral (select lieferantenvertrag_ende(v) as ende, lieferantenvertrag_stichtag(v) as stichtag) s
cross join lateral (select case v.art when 'nda' then 'NDA' when 'qsv' then 'QSV'
                                      when 'rahmenvertrag' then 'Rahmenvertrag' else 'Preisliste' end as label) a
where v.status = 'aktiv'
  and s.ende is not null
  and s.stichtag - v.erinnerung_tage <= current_date
union all
select 'werkzeug_lebensdauer',
       'werkzeug',
       w.id,
       w.partner_id,
       current_date,
       null::date,
       format('Werkzeug %s „%s" hat %s von %s Schuss (%s %%) — Ersatz oder Überholung planen',
              w.nummer, w.bezeichnung, w.schuss_zaehler, w.lebensdauer_schuss,
              floor(100.0 * w.schuss_zaehler / w.lebensdauer_schuss)),
       p.einkaeufer_id
from werkzeuge w
join partners p on p.id = w.partner_id
where w.status = 'aktiv'
  and w.lebensdauer_schuss is not null
  and w.schuss_zaehler >= 0.9 * w.lebensdauer_schuss
union all
select 'eta_ueberfaellig',
       'purchase_order',
       po.id,
       po.vendor_id,
       e.eta + 1,
       e.eta,
       format('%s: Liefertermin %s überschritten, Wareneingang offen — Tracking und neuen Termin erfragen',
              po.number, to_char(e.eta, 'DD.MM.YYYY')),
       coalesce(po.user_id, p.einkaeufer_id)
from purchase_orders po
join partners p on p.id = po.vendor_id
cross join lateral (select coalesce(po.eta_confirmed, po.expected_arrival::date) as eta) e
where po.state = 'purchase'
  and e.eta < current_date
  and exists (select 1 from stock_pickings sp
              where sp.origin_model = 'purchase_order' and sp.origin_id = po.id
                and sp.state not in ('done', 'cancel'));

comment on view einkauf_regel_wiedervorlagen is
  'Regelbasierte Wiedervorlagen des Einkaufs (0107/0108): ablaufende Lieferantenverträge (Stichtag − Vorlauf ≤ heute), '
  'Werkzeuge ab 90 % ihrer Schuss-Lebensdauer und Bestellungen mit überschrittenem ETA bei offenem Wareneingang. '
  'Berechnet; verschwinden von selbst, wenn der Grund behoben ist';

-- --- 11. Einkaufs-Cockpit ---------------------------------------------------------------

-- Kurzbezeichnung eines Einkaufsbelegs (Cockpit, Digest).
create or replace function einkauf_beleg_text(p_modell text, p_id uuid)
returns text
language sql stable
set search_path = public, pg_temp as $$
  select case p_modell
    when 'mail_thread' then (select coalesce(t.betreff, '(ohne Betreff)') || coalesce(' · ' || p.name, '')
                             from mail_threads t left join partners p on p.id = t.partner_id where t.id = p_id)
    when 'partner' then (select name from partners where id = p_id)
    when 'purchase_order' then (select po.number || ' · ' || p.name from purchase_orders po
                                join partners p on p.id = po.vendor_id where po.id = p_id)
    when 'vendor_bill' then (select vb.number || ' · ' || p.name from vendor_bills vb
                             join partners p on p.id = vb.vendor_id where vb.id = p_id)
    when 'einkaufsprojekt' then (select ep.nummer || ' · ' || ep.titel from einkaufsprojekte ep where ep.id = p_id)
    when 'bemusterung' then (select ep.nummer || ' · Runde ' || b.runde || ' · ' || p.name
                             from bemusterungen b join einkaufsprojekte ep on ep.id = b.projekt_id
                             join partners p on p.id = b.partner_id where b.id = p_id)
    when 'werkzeug' then (select wz.nummer || ' · ' || wz.bezeichnung from werkzeuge wz where wz.id = p_id)
    when 'lieferantenvertrag' then (select v.titel || ' · ' || p.name from lieferantenvertraege v
                                    join partners p on p.id = v.partner_id where v.id = p_id)
    when 'eingangs_sendung' then (select s.nummer || coalesce(' · ' || s.bezeichnung, '')
                                  from eingangs_sendungen s where s.id = p_id)
  end
$$;

-- Was im Einkauf ansteht, je Kategorie und Zuständigem — die eine Quelle
-- für /einkauf/cockpit und die tägliche Telegram-Zusammenfassung. Fällige
-- Zahlplan-Raten stehen bewusst NICHT hier (Finanzdaten, eigene Abfrage mit
-- Rechteprüfung in einkauf/cockpit.ts).
create or replace view einkauf_cockpit as
select case when w.faellig_am < current_date then 'ueberfaellig' else 'heute' end as kategorie,
       w.modell,
       w.record_id,
       w.grund                                              as titel,
       einkauf_beleg_text(w.modell, w.record_id)            as detail,
       einkauf_beleg_link(w.modell, w.record_id)            as link,
       w.faellig_am,
       w.zustaendig_id,
       null::uuid                                           as partner_id
from wiedervorlagen w
where w.erledigt_am is null and w.faellig_am <= current_date
union all
select case r.regel
         when 'werkzeug_lebensdauer' then 'werkzeuge'
         when 'eta_ueberfaellig' then 'eta_ueberfaellig'
         else case when coalesce(r.frist, r.faellig_am) < current_date then 'ueberfaellig' else 'heute' end
       end,
       r.modell, r.record_id, r.grund, pa.name, einkauf_beleg_link(r.modell, r.record_id),
       coalesce(r.frist, r.faellig_am), r.zustaendig_id, r.partner_id
from einkauf_regel_wiedervorlagen r
join partners pa on pa.id = r.partner_id
where r.faellig_am <= current_date
union all
select case
         when t.partner_id is null and t.purchase_order_id is null and t.einkaufsprojekt_id is null then 'unzugeordnet'
         when t.letzte_richtung = 'ausgang' then 'wartet_lieferant'
         else 'wartet_uns'
       end,
       'mail_thread', t.id, coalesce(t.betreff, '(ohne Betreff)'), pa.name, '/einkauf/posteingang/' || t.id,
       t.letzte_am::date, t.zustaendig_id, t.partner_id
from mail_threads t
left join partners pa on pa.id = t.partner_id
where t.status = 'offen'
union all
select 'dokumente', d.modell, d.record_id, d.nummer || ': ' || d.bezeichnung || ' fehlt', pa.name, d.link,
       d.faellig_am, d.zustaendig_id, d.partner_id
from einkauf_offene_pflichtdokumente d
left join partners pa on pa.id = d.partner_id
union all
select 'rechnungen', 'purchase_order', po.id, po.number || ': Lieferantenrechnung fehlt', pa.name, '/einkauf/' || po.id,
       (select max(sp.date_done)::date from stock_pickings sp
        where sp.origin_model = 'purchase_order' and sp.origin_id = po.id and sp.state = 'done'),
       coalesce(po.user_id, pa.einkaeufer_id), po.vendor_id
from purchase_orders po
join partners pa on pa.id = po.vendor_id
where po.state in ('purchase', 'done') and po.billing_status = 'waiting'
  and prozessschritt_aktiv('einkauf_wareneingang_rechnung', 'rechnung')
union all
select 'sendungen', 'eingangs_sendung', s.id, s.nummer || coalesce(' · ' || s.bezeichnung, ''),
       (case s.status when 'geplant' then 'geplant' when 'verschifft' then 'unterwegs'
                      when 'verzollt' then 'verzollt' else 'angekommen — Eingang buchen und abrechnen' end)
         || case s.modus when 'see' then ' · See' when 'luft' then ' · Luft' else ' · Express' end
         || coalesce(' · ETA ' || to_char(s.eta, 'DD.MM.YYYY'), ''),
       '/einkauf/sendungen/' || s.id, s.eta, s.zustaendig_id, s.spediteur_id
from eingangs_sendungen s
where s.status in ('geplant', 'verschifft', 'verzollt', 'angekommen')
union all
select 'muster', 'bemusterung', b.id, ep.nummer || ' · Runde ' || b.runde || coalesce(' · ' || b.bezeichnung, ''),
       pa.name || case when b.erhalten_am is not null then ' · eingegangen, wartet auf Bewertung' else ' · unterwegs' end,
       '/einkauf/muster/' || b.id, coalesce(b.erhalten_am, b.bestellt_am), coalesce(ep.verantwortlich_id, pa.einkaeufer_id),
       b.partner_id
from bemusterungen b
join einkaufsprojekte ep on ep.id = b.projekt_id
join partners pa on pa.id = b.partner_id
where b.status = 'offen';

comment on view einkauf_cockpit is
  'Einkaufs-Cockpit (0108): kategorie ueberfaellig|heute|wartet_lieferant|wartet_uns|unzugeordnet|dokumente|rechnungen|'
  'eta_ueberfaellig|sendungen|muster|werkzeuge je Beleg (modell, record_id, link) und zustaendig_id. Raten separat (Finanzen)';

-- --- 12. Lernende Schätzwerte ------------------------------------------------------------

-- Aus abgerechneten Sendungen: echte Fracht in EUR je kg (und je cbm, zur
-- Info) je Modus; echte Zollsätze je HS-Präfix (der längste vorhandene
-- Tarif-Präfix, sonst die ersten vier Ziffern). Vorschlag nur bei
-- spürbarer Abweichung (Fracht > 5 %, Zoll ≥ 0,1 Prozentpunkte) — übernommen
-- wird per Aktion, nie still.
create or replace view einkauf_einstand_vorschlaege as
with fracht as (
  select s.modus,
         count(*)::int as sendungen,
         sum(s.gewicht_kg) as kg,
         sum(s.volumen_cbm) filter (where s.volumen_cbm > 0) as cbm,
         sum(f.eur) as eur
  from eingangs_sendungen s
  cross join lateral (
    select sum(k.betrag * coalesce(k.kurs, exchange_rate_at(k.waehrung, coalesce(k.belegdatum, s.angekommen_am, current_date)))) as eur
    from sendung_kosten k
    where k.sendung_id = s.id and k.art = 'fracht' and not k.schaetzung
      and k.storniert_am is null and k.ersetzt_durch_id is null
  ) f
  where s.status = 'abgerechnet' and s.gewicht_kg > 0 and f.eur > 0
  group by s.modus
),
zoll as (
  select x.praefix,
         count(distinct x.sendung_id)::int as sendungen,
         sum(x.zollwert_eur) as zollwert,
         sum(x.zoll_eur) as zoll
  from (
    select z.sendung_id, z.zollwert_eur, z.zoll_eur,
           coalesce((select t.hs_praefix from zolltarife t
                     where z.hs_code like t.hs_praefix || '%'
                     order by length(t.hs_praefix) desc limit 1), left(z.hs_code, 4)) as praefix
    from sendung_zoll z
    join eingangs_sendungen s on s.id = z.sendung_id and s.status = 'abgerechnet'
  ) x
  group by x.praefix
  having sum(x.zollwert_eur) > 0
)
select 'fracht'::text                                    as art,
       f.modus                                           as schluessel,
       f.sendungen,
       round(f.kg, 3)                                    as basis,
       round(f.eur / f.kg, 4)                            as ist_wert,
       fs.eur_je_kg                                      as soll_wert,
       round(f.eur / nullif(f.cbm, 0), 2)                as eur_je_cbm,
       format('%s abgerechnete Sendung(en), %s kg, Fracht %s €', f.sendungen,
              to_char(round(f.kg, 1), 'FM999G999G990D0'), to_char(round(f.eur, 2), 'FM999G999G990D00')) as grundlage
from fracht f
left join frachtsaetze fs on fs.modus = f.modus
where fs.eur_je_kg is null or abs(f.eur / f.kg - fs.eur_je_kg) > 0.05 * fs.eur_je_kg
union all
select 'zoll',
       z.praefix,
       z.sendungen,
       round(z.zollwert, 2),
       round(100 * z.zoll / z.zollwert, 2),
       zt.satz_pct,
       null::numeric,
       format('%s abgerechnete Sendung(en), Zollwert %s €, Zoll %s €', z.sendungen,
              to_char(round(z.zollwert, 2), 'FM999G999G990D00'), to_char(round(z.zoll, 2), 'FM999G999G990D00'))
from zoll z
left join zolltarife zt on zt.hs_praefix = z.praefix
where z.praefix ~ '^[0-9]{2,10}$'
  and (zt.satz_pct is null or abs(round(100 * z.zoll / z.zollwert, 2) - zt.satz_pct) >= 0.1);

comment on view einkauf_einstand_vorschlaege is
  'Vorschläge für frachtsaetze (EUR/kg je Modus) und zolltarife (Satz je HS-Präfix) aus abgerechneten Eingangssendungen (0108) — '
  'art fracht|zoll, schluessel, sendungen, basis (kg bzw. Zollwert), ist_wert, soll_wert, eur_je_cbm, grundlage';

-- --- 13. DATEV-Vorbereitung (kein Versand) ------------------------------------------------

-- Was an DATEV ginge: gebuchte Lieferantenrechnungen mit verknüpfter
-- Rechnungsdatei → „bereit", ohne Datei → „fehlt_beleg", schon übergeben →
-- „uebergeben" (dokumente.datev_uebergeben_am). Versendet wird (noch) nichts
-- — Betreiber 2026-10-01: erst nach Klärung mit dem Steuerberater.
create or replace view einkauf_datev_vorbereitung as
select b.id                     as vendor_bill_id,
       b.number,
       b.vendor_id,
       b.purchase_order_id,
       b.bill_date,
       b.state::text            as rechnung_status,
       d.id                     as dokument_id,
       d.name                   as dokument_name,
       d.groesse,
       d.datev_uebergeben_am,
       case when d.id is null then 'fehlt_beleg'
            when d.datev_uebergeben_am is not null then 'uebergeben'
            else 'bereit' end   as status
from vendor_bills b
left join lateral (
  select dok.id, dok.name, dok.groesse, dok.datev_uebergeben_am
  from dokument_verweise v
  join dokumente dok on dok.id = v.dokument_id
  where v.modell = 'vendor_bill' and v.record_id = b.id and dok.art = 'rechnung'
) d on true
where b.state in ('posted', 'paid');

comment on view einkauf_datev_vorbereitung is
  'DATEV-Vorbereitung (0108): gebuchte Lieferantenrechnungen je Rechnungsdatei mit status bereit|fehlt_beleg|uebergeben — '
  'nur Übersicht, kein Versand';

-- --- 14. Betriebsdaten löschen: Pflichtdokument-Regeln sind Einrichtung -------------

-- Voller Körper aus 0097, Behalten-Liste um pflichtdokument_regeln erweitert.
create or replace function demodaten_loeschen()
returns void language plpgsql
set search_path = public, pg_temp as $$
declare
  v_behalten constant text[] := array[
    'schema_migrations', 'settings', 'users', 'sessions',
    -- Zweiter Faktor (0083): gehört zum Konto, nicht zu den Betriebsdaten.
    'backup_codes', 'vertraute_geraete',
    'uom_categories', 'uoms', 'currencies', 'exchange_rates',
    'warehouses', 'stock_locations', 'operation_types',
    'taxes', 'payment_terms', 'incoterms', 'product_categories',
    'sequences', 'tags',
    'prozesse', 'prozess_versionen', 'prozess_schritte', 'prozess_uebergaenge',
    'prozess_modelle', 'prozess_routen', 'prozess_overrides',
    'feld_definitionen', 'prozess_pakete',
    'shipping_rules',
    'nutzungs_zaehler',
    -- Finanz-Konfiguration (0058): Konten bleiben, Bewegungen fallen.
    'bankkonten',
    -- Vertriebseingang der öffentlichen Startseite (0066): kein
    -- Betriebsdatum, keine zweite Quelle.
    'registrierungen',
    -- Arbeitsplätze mit Druckern (0087): die Einrichtung der Tische bleibt.
    'work_centers', 'drucker', 'arbeitsplatz_druckwege',
    -- Mail-Vorlagen des Einkaufs (0094): Texte je Sprache sind Einrichtung.
    'mail_vorlagen',
    -- Einstand (0097): Frachtsätze und Zolltarife sind Einrichtung.
    'frachtsaetze', 'zolltarife',
    -- Pflichtdokumente (0108): die Regeln sind Einrichtung.
    'pflichtdokument_regeln'
  ];
  v_liste text;
  r record;
begin
  select string_agg(format('%I', tablename), ', ' order by tablename)
    into v_liste
  from pg_tables
  where schemaname = current_schema()
    and tablename <> all (v_behalten);

  if v_liste is not null then
    execute 'truncate table ' || v_liste;
  end if;

  delete from sessions where user_id in (
    select id from users
    where lower(email) in ('lager@example.com', 'fertigung@example.com'));
  delete from users
  where lower(email) in ('lager@example.com', 'fertigung@example.com');

  update sequences set next_number = 1;
  for r in select code from sequences loop
    execute format('alter sequence %I restart with 1', 'seq_' || r.code);
  end loop;

  insert into settings (key, value)
  values ('demo', jsonb_build_object('geloescht', true, 'zeitpunkt', now()))
  on conflict (key) do update set value = excluded.value;

  perform refresh_analytics('demodaten-loeschen');
end $$;
