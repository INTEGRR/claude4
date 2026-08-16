-- ===========================================================================
-- Chamäleon: eigene Felder ohne Migration, generische Vorgänge, Pakete
-- ===========================================================================
--
-- Ein Pivot heißt „andere Prozesse aktivieren", nicht „Code umschreiben":
--
--  * feld_definitionen + `zusatz jsonb` auf den Kernobjekten — eigene Felder
--    entstehen zur Laufzeit, erscheinen in den GENERIERTEN Masken und sind
--    über die Bedingungssprache (Pfade wie 'zusatz.budget') sofort
--    prozessfähig.
--  * vorgaenge — der generische Beleg (VG/…): eine neue Business-Linie ist
--    ein DESIGNTER Prozess auf Vorgängen statt einer entwickelten
--    Fachtabelle. Die Zustände kommen aus der Prozessdefinition (state ist
--    Text, kein Enum). Bei Erfolg „graduiert" die Linie zur Fachtabelle.
--  * prozess_pakete — Geschäftsmodell-Vorlagen als aktivierbare Bündel.
--
-- Als Muster wird der Vorgangs-Prozess „anfrage" gesät — er beweist im
-- Prozesstest, dass ein reiner Laufzeit-Prozess ohne Fachtabelle
-- durchspielbar ist.

-- --- Eigene Felder ----------------------------------------------------------

create table feld_definitionen (
  id         uuid primary key default gen_random_uuid(),
  modell     text not null,               -- Schlüssel aus prozess_modelle bzw. Kernobjekt
  name       text not null,               -- technischer Name im zusatz-jsonb
  label      text not null,
  typ        text not null check (typ in ('text', 'nummer', 'schalter', 'auswahl', 'datum')),
  pflicht    boolean not null default false,
  auswahl    text[],                      -- Werte für typ 'auswahl'
  sichtbar_in text[] not null default array['formular'],
  sequence   int not null default 10,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  unique (modell, name)
);
select attach_touch_trigger('feld_definitionen');

comment on table feld_definitionen is
  'Eigene Felder ohne Migration: landen im zusatz-jsonb des Modells, erscheinen in generierten Masken und sind über Bedingungspfade (zusatz.<name>) prozessfähig.';

alter table partners          add column zusatz jsonb not null default '{}';
alter table product_templates add column zusatz jsonb not null default '{}';
alter table sales_orders      add column zusatz jsonb not null default '{}';
alter table repair_orders     add column zusatz jsonb not null default '{}';

-- --- Generische Vorgänge -----------------------------------------------------

create table vorgaenge (
  id           uuid primary key default gen_random_uuid(),
  number       text unique not null,
  prozess_code text not null references prozesse (code),
  titel        text,
  state        text not null default 'neu',  -- Zustände definiert der Prozess, kein Enum
  partner_id   uuid references partners on delete set null,
  zusatz       jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz
);
select attach_touch_trigger('vorgaenge');
create index vorgaenge_prozess_idx on vorgaenge (prozess_code, state);

insert into sequences (code, prefix, padding, next_number) values ('vorgang', 'VG/', 5, 1);
create sequence if not exists seq_vorgang;

insert into prozess_modelle (modell, tabelle, status_spalte, routen_muster)
values ('vorgang', 'vorgaenge', 'state', '/vorgaenge/:id');

-- --- Geschäftsmodell-Vorlagen ------------------------------------------------

create table prozess_pakete (
  code          text primary key,
  name          text not null,
  beschreibung  text,
  prozess_codes text[] not null,
  created_at    timestamptz not null default now()
);

insert into prozess_pakete (code, name, beschreibung, prozess_codes) values
  ('d2c_hersteller', 'D2C-Hersteller',
   'Fertigen, über den Shop verkaufen, versenden, reparieren.',
   array['artikel_anlegen', 'shopify_bestellung_versand', 'fertigung',
         'einkauf_wareneingang_rechnung', 'lieferantenrechnung', 'reparatur', 'bug_ticket']),
  ('haendler', 'Händler',
   'Einkaufen und über den Shop verkaufen — ohne eigene Fertigung.',
   array['artikel_anlegen', 'shopify_bestellung_versand',
         'einkauf_wareneingang_rechnung', 'lieferantenrechnung', 'bug_ticket']),
  ('werkstatt', 'Werkstatt/Service',
   'Reparieren und Anfragen abwickeln — Verkauf nachrangig.',
   array['reparatur', 'anfrage', 'artikel_anlegen', 'bug_ticket']);

-- --- Bedingungssprache: Pfade (zusatz.budget) --------------------------------

create or replace function bedingung_pruefen(p_daten jsonb, p_bedingung jsonb)
returns boolean
language plpgsql immutable as $$
declare
  teil jsonb;
  v_feld text;
  v_op text;
  v_wert jsonb;
  ist jsonb;
  ist_text text;
  soll_text text;
begin
  if p_bedingung is null or p_bedingung = 'null'::jsonb then return true; end if;

  if p_bedingung ? 'alle' then
    for teil in select * from jsonb_array_elements(p_bedingung -> 'alle') loop
      if not bedingung_pruefen(p_daten, teil) then return false; end if;
    end loop;
    return true;
  end if;

  if p_bedingung ? 'eine' then
    for teil in select * from jsonb_array_elements(p_bedingung -> 'eine') loop
      if bedingung_pruefen(p_daten, teil) then return true; end if;
    end loop;
    return false;
  end if;

  if p_bedingung ? 'nicht' then
    return not bedingung_pruefen(p_daten, p_bedingung -> 'nicht');
  end if;

  v_feld := p_bedingung ->> 'feld';
  v_op   := p_bedingung ->> 'op';
  if v_feld is null or v_op is null then
    raise exception 'Ungültige Bedingung: %', p_bedingung;
  end if;

  -- Eigene Felder liegen verschachtelt (zusatz.budget) — ein Punkt im
  -- Feldnamen wird als Pfad gelesen.
  if position('.' in v_feld) > 0 then
    ist := p_daten #> string_to_array(v_feld, '.');
    ist_text := p_daten #>> string_to_array(v_feld, '.');
  else
    ist := p_daten -> v_feld;
    ist_text := p_daten ->> v_feld;
  end if;
  v_wert := p_bedingung -> 'wert';
  soll_text := p_bedingung ->> 'wert';

  if v_op = 'leer' then
    return ist is null or ist = 'null'::jsonb or ist_text = '';
  elsif v_op = 'nicht_leer' then
    return not (ist is null or ist = 'null'::jsonb or ist_text = '');
  elsif v_op = 'beginnt_mit' then
    return ist_text is not null and ist_text like soll_text || '%';
  elsif v_op = 'in' then
    return v_wert is not null
      and jsonb_typeof(v_wert) = 'array'
      and exists (select 1 from jsonb_array_elements_text(v_wert) w where w = ist_text);
  elsif v_op in ('=', '!=') then
    if (v_op = '=') = (ist_text is not distinct from soll_text) then return true; end if;
    -- „1" und „1.0" sollen gleich sein: numerischer Zweitversuch.
    if ist_text ~ '^-?[0-9]+(\.[0-9]+)?$' and soll_text ~ '^-?[0-9]+(\.[0-9]+)?$' then
      return (v_op = '=') = (ist_text::numeric = soll_text::numeric);
    end if;
    return false;
  elsif v_op in ('>', '>=', '<', '<=') then
    if ist_text is null or soll_text is null
       or ist_text !~ '^-?[0-9]+(\.[0-9]+)?$' or soll_text !~ '^-?[0-9]+(\.[0-9]+)?$' then
      return false;
    end if;
    return case v_op
      when '>'  then ist_text::numeric >  soll_text::numeric
      when '>=' then ist_text::numeric >= soll_text::numeric
      when '<'  then ist_text::numeric <  soll_text::numeric
      else           ist_text::numeric <= soll_text::numeric
    end;
  end if;

  raise exception 'Unbekannter Operator: %', v_op;
end $$;

-- --- Neustart: neue Strukturtabellen behalten --------------------------------

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
    -- Chamäleon-Struktur: Felddefinitionen und Pakete sind Konfiguration;
    -- vorgaenge sind Bewegungsdaten und fallen weg.
    'feld_definitionen', 'prozess_pakete',
    -- Versandregeln sind Konfiguration ohne Fremdschlüssel und bleiben.
    -- Kartonagen NICHT: sie verweisen auf Produktvarianten — blieben sie
    -- stehen, ließe sich product_variants nicht mehr leeren.
    'shipping_rules'
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

-- --- Muster-Vorgangsprozess „anfrage" ---------------------------------------
-- Beweist end-to-end: eine neue Business-Linie ist ein designter Prozess auf
-- Vorgängen — kein Enum, keine Fachtabelle, keine Codeänderung.

with p as (
  insert into prozesse (code, name, beschreibung, bereich, modell)
  values ('anfrage', 'Anfrage (Muster-Vorgang)',
          'Eine eingehende Anfrage prüfen und anbieten oder ablehnen — komplett als Laufzeit-Prozess auf generischen Vorgängen.',
          'verkauf', 'vorgang')
  returning id
), v as (
  insert into prozess_versionen (prozess_id, version, status, aktiviert_am)
  select id, 1, 'aktiv', now() from p
  returning id
), s as (
  insert into prozess_schritte (version_id, code, name, art, sequence, aktion, zustand, params)
  select v.id, t.code, t.name, t.art::prozess_schritt_art, t.seq, t.aktion, t.zustand,
         coalesce(t.params::jsonb, '{}'::jsonb)
  from v, (values
    ('start',    'Anfrage eingegangen', 'start',  0,  null,                    null,        null),
    ('anlegen',  'Anfrage erfassen',    'aktion', 10, 'vorgang.anlegen',       'neu',       '{"prozess_code": "anfrage"}'),
    ('pruefen',  'Prüfen',              'aktion', 20, 'vorgang.status_setzen', 'geprueft',  '{"state": "geprueft"}'),
    ('angebot',  'Anbieten',            'aktion', 30, 'vorgang.status_setzen', 'angeboten', '{"state": "angeboten"}'),
    ('ablehnen', 'Ablehnen',            'aktion', 40, 'vorgang.status_setzen', 'abgelehnt', '{"state": "abgelehnt"}'),
    ('ende',     'Erledigt',            'ende',   90, null,                    null,        null)
  ) as t(code, name, art, seq, aktion, zustand, params)
  returning version_id
)
insert into prozess_uebergaenge (version_id, von_code, nach_code, sequence, beschriftung)
select distinct s.version_id, t.von, t.nach, t.seq, t.text
from s, (values
  ('start',    'anlegen',  10, null),
  ('anlegen',  'pruefen',  10, null),
  ('pruefen',  'angebot',  10, 'passt'),
  ('pruefen',  'ablehnen', 20, 'passt nicht'),
  ('angebot',  'ende',     10, null),
  ('ablehnen', 'ende',     10, null)
) as t(von, nach, seq, text);

insert into prozess_routen (pfad_muster, prozess_code, schritt_code)
values ('/vorgaenge', 'anfrage', null);
