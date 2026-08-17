-- Finanzen, Teil 1: das Zahlungsfundament. Bisher kannte das System kein
-- Geld — pay_vendor_bill war ein Statusflip, Teilzahlungen, Zahlpläne und
-- Kontostände existierten nicht. Hier entsteht das zentrale Ist-Register
-- (zahlungen), der Zahlplan je Bestellung (30 % Anzahlung / 70 % bei
-- Verschiffung — üblich im Asien-Einkauf) und der manuelle Kontostands-
-- Anker, von dem später die Cashflow-Prognose losläuft.
--
-- Rechte: Bereich 'finanzen' verlangt die persönliche Befugnis
-- 'finanzen:zugriff' (oder Admin) — geregelt in permissions.ts, nicht hier.
-- Ausbauoption (bewusst nicht in v1): ein Zahlungs-Freigabelimit nach dem
-- Muster der Bestellfreigabe (0056) — settings 'freigaben'.zahlung_limit
-- plus Befugnis 'finanzen:zahlung_freigeben', Riegel als Trigger.

-- --- Stammdaten: Bankkonten + manueller Saldo-Anker -------------------------

create table bankkonten (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  iban       text,
  waehrung   text not null default 'EUR' references currencies (code),
  sequence   int  not null default 10,
  aktiv      boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
select attach_touch_trigger('bankkonten');
comment on table bankkonten is
  'Bankkonten der Firma — Konfiguration (übersteht demodaten_loeschen). Salden kommen als manuelle Anker in kontostaende.';

create table kontostaende (
  id           uuid primary key default gen_random_uuid(),
  bankkonto_id uuid not null references bankkonten on delete cascade,
  stichtag     date not null,
  saldo        numeric(16,2) not null,
  notiz        text,
  erfasst_von  text not null default 'system',
  created_at   timestamptz not null default now(),
  unique (bankkonto_id, stichtag)
);
comment on table kontostaende is
  'Manuell erfasste Kontostände mit Stichtag — der Anker: ab hier rechnet finanz_saldo() mit den Zahlungen weiter. Kein Bankimport (bewusst).';

-- --- Das zentrale Ist-Register ---------------------------------------------

insert into sequences (code, prefix, padding) values ('zahlung', 'ZA/', 5)
on conflict (code) do nothing;

create table zahlungen (
  id               uuid primary key default gen_random_uuid(),
  nummer           text not null unique,
  richtung         text not null check (richtung in ('ein', 'aus')),
  betrag           numeric(16,2) not null check (betrag > 0),
  waehrung         text not null default 'EUR' references currencies (code),
  kurs             numeric(16,6) not null default 1,
  -- Hauswährung ist die Rechen-Wahrheit: Salden, Prognose und Deckungs-
  -- vergleiche laufen ausschließlich über betrag_eur.
  betrag_eur       numeric(16,2) not null,
  gezahlt_am       date not null default current_date,
  bankkonto_id     uuid references bankkonten on delete set null,
  -- text + check statt Enum: spätere Migrationen erweitern die Werteliste
  -- per Constraint-Tausch (Verträge, Steuern, Darlehen) — 'alter type add
  -- value' ist im transaktionalen Runner heikel.
  quelle           text not null default 'manuell'
                   check (quelle in ('vendor_bill', 'po_rate', 'manuell')),
  vendor_bill_id   uuid references vendor_bills on delete set null,
  zahlplan_rate_id uuid,   -- FK folgt nach der Tabellendefinition unten
  partner_id       uuid references partners on delete set null,
  verwendungszweck text,
  storniert_am     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz
);
select attach_touch_trigger('zahlungen');
create index zahlungen_datum_idx on zahlungen (gezahlt_am desc);
create index zahlungen_bill_idx on zahlungen (vendor_bill_id) where vendor_bill_id is not null;
create index zahlungen_rate_idx on zahlungen (zahlplan_rate_id) where zahlplan_rate_id is not null;
comment on table zahlungen is
  'Zentrales Register aller Ist-Zahlungen (ein/aus, alle Quellen). Storno statt Löschen (storniert_am) — das Register ist die Zahlungshistorie.';

-- --- Zahlplan je Bestellung -------------------------------------------------

create table zahlplan_raten (
  id                uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references purchase_orders on delete cascade,
  sequence          int not null default 10,
  bezeichnung       text not null,
  anteil_pct        numeric(5,2) check (anteil_pct > 0 and anteil_pct <= 100),
  betrag            numeric(16,2) check (betrag > 0),
  ausloeser         text not null
                    check (ausloeser in ('bestellung', 'verschiffung', 'ankunft', 'termin')),
  versatz_tage      int not null default 0,
  termin            date,
  bezahlt_am        date,
  notiz             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz,
  -- Genau eine Betragsangabe: Prozent vom Brutto ODER fester Betrag.
  check ((anteil_pct is null) <> (betrag is null)),
  check (ausloeser <> 'termin' or termin is not null)
);
select attach_touch_trigger('zahlplan_raten');
create index zahlplan_raten_po_idx on zahlplan_raten (purchase_order_id);
comment on table zahlplan_raten is
  'Zahlplan je Bestellung: Raten mit Auslöser (bei Bestellung / Verschiffung / Ankunft / festem Termin). Beträge in Bestellwährung, EUR über den eingefrorenen Bestellkurs.';

alter table zahlungen
  add constraint zahlungen_rate_fk
  foreign key (zahlplan_rate_id) references zahlplan_raten on delete set null;

-- Der Verschiffungs-Auslöser braucht den Fakt am Beleg (neben eta/0055).
alter table purchase_orders add column verschifft_am date;
comment on column purchase_orders.verschifft_am is
  'Tatsächlicher Verschiffungstag — Auslöser für Zahlplan-Raten (z. B. „70 % bei Verschiffung").';

-- Phase-1-Schlüssel der Finanz-Einstellungen; bestehende Werte gewinnen,
-- fehlende werden ergänzt (rechter Operand von || gewinnt).
insert into settings (key, value)
values ('finanzen', jsonb_build_object('transit_tage', 30))
on conflict (key) do update set value = excluded.value || settings.value;

-- --- Rechenfunktionen -------------------------------------------------------

-- Ratenbetrag in EUR: fester Betrag oder Anteil vom Bestellbrutto, beides
-- über den beim Bestätigen eingefrorenen Kurs (Konvention der Bewertung).
create or replace function zahlplan_betrag(r zahlplan_raten)
returns numeric
language sql stable as $$
  select round(
    coalesce(r.betrag,
             (select t.gross from purchase_order_total(r.purchase_order_id) t)
               * r.anteil_pct / 100)
    * coalesce((select po.exchange_rate from purchase_orders po where po.id = r.purchase_order_id), 1),
  2);
$$;

-- Fälligkeit je Auslöser. Solange der echte Fakt fehlt, wird geschätzt:
-- Verschiffung = ETA minus Transitzeit (settings), Ankunft = bestätigte ETA
-- bzw. erwartete Ankunft. Ohne jede Datumsgrundlage: heute (steht damit als
-- „sofort fällig" in der Liste statt unsichtbar zu sein).
create or replace function zahlplan_faelligkeit(r zahlplan_raten)
returns date
language sql stable as $$
  select (case r.ausloeser
    when 'termin'       then r.termin
    when 'bestellung'   then coalesce((select po.confirmed_at::date from purchase_orders po where po.id = r.purchase_order_id), current_date)
    when 'verschiffung' then coalesce(
      (select po.verschifft_am from purchase_orders po where po.id = r.purchase_order_id),
      (select coalesce(po.eta_confirmed, po.expected_arrival::date)
         from purchase_orders po where po.id = r.purchase_order_id)
        - coalesce((select (value->>'transit_tage')::int from settings where key = 'finanzen'), 30),
      current_date)
    when 'ankunft'      then coalesce(
      (select coalesce(po.eta_confirmed, po.expected_arrival::date)
         from purchase_orders po where po.id = r.purchase_order_id),
      current_date)
  end) + r.versatz_tage;
$$;

-- Weiche Plausibilitätswarnung — bewusst kein Constraint: ein Zahlplan darf
-- während der Pflege vorübergehend „schief" sein.
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
    return format('Zahlplan-Summe %s € liegt über dem Bestellbrutto %s €.', v_summe, v_gross);
  end if;
  return null;
end $$;

-- Offener Rechnungsbetrag in EUR — mit Anrechnungsregel: Zahlungen auf
-- Zahlplan-Raten DERSELBEN Bestellung mindern den offenen Betrag. So passt
-- der Standardfall Asien-Einkauf: 30 % Anzahlung als Rate, später kommt die
-- 100-%-Rechnung — offen sind dann nur noch 70 %.
create or replace function vendor_bill_offen(p_bill uuid)
returns numeric
language sql stable as $$
  select case when b.is_credit_note then 0 else greatest(0, round(
    t.gross * exchange_rate_at(b.currency, b.bill_date)
    - coalesce((select sum(z.betrag_eur) from zahlungen z
                where z.vendor_bill_id = b.id and z.storniert_am is null), 0)
    - coalesce((select sum(z.betrag_eur)
                from zahlungen z
                join zahlplan_raten r on r.id = z.zahlplan_rate_id
                where r.purchase_order_id = b.purchase_order_id
                  and b.purchase_order_id is not null
                  and z.storniert_am is null), 0)
  , 2)) end
  from vendor_bills b, vendor_bill_total(b.id) t
  where b.id = p_bill;
$$;

-- Die eine Buchungsfunktion des Registers: validiert, friert den Kurs ein,
-- zieht Seiteneffekte nach (Rechnung voll gedeckt → paid; Rate → bezahlt).
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
  elsif p_quelle <> 'manuell' then
    raise exception 'Unbekannte Zahlungsquelle: %', p_quelle;
  end if;

  insert into zahlungen (nummer, richtung, betrag, waehrung, kurs, betrag_eur,
                         gezahlt_am, bankkonto_id, quelle,
                         vendor_bill_id, zahlplan_rate_id, partner_id, verwendungszweck)
  values (next_sequence('zahlung'), p_richtung, p_betrag, p_waehrung, v_kurs,
          round(p_betrag * v_kurs, 2), p_datum, p_bankkonto, p_quelle,
          case when p_quelle = 'vendor_bill' then p_ref end,
          case when p_quelle = 'po_rate' then p_ref end,
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
  end if;

  return v_id;
end $$;

-- Storno statt Löschen: die Zahlung bleibt sichtbar, Seiteneffekte werden
-- zurückgenommen (paid → posted, Rate wieder offen).
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
end $$;

-- Der Altpfad („Rechnung bezahlen" im Prozess) schreibt ab jetzt ins
-- Register: eine Zahlung über den offenen Rest. Nach außen unverändert.
create or replace function pay_vendor_bill(p_bill uuid, p_actor text default 'system')
returns void
language plpgsql as $$
declare
  v_bill vendor_bills;
  v_offen numeric;
begin
  select * into v_bill from vendor_bills where id = p_bill;
  if v_bill.id is null or v_bill.state <> 'posted' then return; end if;
  v_offen := vendor_bill_offen(p_bill);
  if v_offen <= 0 then
    -- Bereits über Anzahlungen/Raten gedeckt: nur der Statusflip fehlt noch.
    update vendor_bills set state = 'paid', paid_at = now() where id = p_bill;
    perform log_event('vendor_bill', p_bill, 'state', 'Als bezahlt markiert (über Raten gedeckt)', p_actor);
  else
    perform zahlung_erfassen('aus', v_offen, 'EUR', current_date, null,
                             'vendor_bill', p_bill, 'Rechnung vollständig bezahlt', p_actor);
  end if;
end $$;

-- Saldo je Konto: letzter Anker + alle nicht stornierten Zahlungen danach.
-- Zahlungen ohne Konto erscheinen als eigene Zeile (bankkonto_id null),
-- damit die Summe über alle Zeilen immer die volle Wahrheit ist.
create or replace function finanz_saldo()
returns table (bankkonto_id uuid, name text, saldo numeric, stichtag date)
language sql stable as $$
  select k.id, k.name,
         coalesce(a.saldo, 0) + coalesce((
           select sum(case z.richtung when 'ein' then z.betrag_eur else -z.betrag_eur end)
           from zahlungen z
           where z.bankkonto_id = k.id and z.storniert_am is null
             and z.gezahlt_am > coalesce(a.stichtag, '1900-01-01'::date)
         ), 0),
         a.stichtag
  from bankkonten k
  left join lateral (
    select s.saldo, s.stichtag from kontostaende s
    where s.bankkonto_id = k.id order by s.stichtag desc limit 1
  ) a on true
  where k.aktiv
  union all
  select null, 'Ohne Konto',
         sum(case z.richtung when 'ein' then z.betrag_eur else -z.betrag_eur end),
         null
  from zahlungen z
  where z.bankkonto_id is null and z.storniert_am is null
  having count(*) > 0;
$$;

-- Was steht an: offene Zahlplan-Raten + gebuchte Rechnungen ohne Zahlplan
-- (exists-Weiche — je Bestellung zählt ENTWEDER der Zahlplan ODER die
-- Rechnung, nie beides). Wächst in 0059/0060 um Verträge, Steuern, Darlehen.
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
  order by faellig_am;
$$;

-- --- Einkaufs-Prozess: optionaler Zahlplan-Schritt --------------------------
-- Neue Version nach dem 0056-Muster: der Schritt macht den Zahlplan im
-- Prozess-Panel sichtbar, erzwingt aber nichts (optional, kein Zustand).

do $$
declare
  v_neu uuid;
begin
  v_neu := prozess_version_kopieren('einkauf_wareneingang_rechnung', 'migration:0058');

  insert into prozess_schritte (version_id, code, name, art, sequence, aktion, optional)
  values (v_neu, 'zahlplan', 'Zahlplan festlegen', 'aktion', 27,
          'finanzen.po_zahlplan_setzen', true);

  insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence)
  values
    (v_neu, 'anlegen',    'zahlplan',    35),
    (v_neu, 'beschaffen', 'zahlplan',    35),
    (v_neu, 'position',   'zahlplan',    20),
    (v_neu, 'freigeben',  'zahlplan',    15),
    (v_neu, 'zahlplan',   'bestaetigen', 10);

  perform prozess_version_aktivieren(v_neu);
end $$;

-- --- Demodaten-Reset --------------------------------------------------------
-- Komplett neu geschrieben (Muster 0031→0057): bankkonten sind Konfiguration
-- und bleiben; Kontostände, Zahlungen und Zahlpläne sind Bewegungsdaten und
-- werden mitgewiped. Künftige Finanztabellen (Verträge, Darlehen, Steuern)
-- sind ebenfalls Bewegungs-/Stammdaten und brauchen hier keinen Eintrag.

create or replace function demodaten_loeschen() returns void
language plpgsql as $$
declare
  v_behalten constant text[] := array[
    'schema_migrations', 'settings', 'users', 'sessions',
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
    'bankkonten'
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
