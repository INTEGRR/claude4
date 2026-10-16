-- 0116: Einrichtungsaufgaben — Betreiber-Todos, die jeden Daten-Reset überleben
-- (Entscheidungslog 2026-10-16).
--
-- Was vor dem Stichtag zu tun ist (Nummernkreise setzen, Firmendaten prüfen,
-- Shopify-Rechnungs-App abschalten, DATEV-Konten abstimmen …) stand bisher im
-- Chat und im Go-Live-Plan — und war nach „Betriebsdaten löschen" weg. Jetzt
-- ist die Liste Struktur (Tabelle einrichtungsaufgaben, bleibt beim Reset) und
-- jede Zeile wird eine normale Aufgabe für das Team Verwaltung (Rolle admin):
-- erledigt bleibt erledigt, bis der nächste Reset die Aufgaben leert — dann
-- legt demodaten_loeschen() sie neu an. Neue Einträge kommen per Migration
-- dazu und werden am Ende mit einrichtungsaufgaben_anlegen() angelegt.

create table einrichtungsaufgaben (
  schluessel   text primary key check (schluessel ~ '^[a-z][a-z0-9_]*$'),
  titel        text not null check (length(btrim(titel)) between 1 and 200),
  beschreibung text,
  -- Seite in KRNL, auf der die Aufgabe erledigt wird (relativ, z. B. /einstellungen/belege).
  link         text check (link is null or link ~ '^/'),
  rolle        user_role not null default 'admin',
  -- Fällig so viele Tage nach dem Anlegen (Stichtag ist eine Frist, kein Datum).
  frist_tage   int not null default 14 check (frist_tage between 0 and 365),
  sortierung   int not null default 100,
  aktiv        boolean not null default true,
  created_at   timestamptz not null default now()
);
comment on table einrichtungsaufgaben is
  'Betreiber-Todos (Einrichtung, Stichtag) als Struktur: werden als Aufgaben angelegt und nach jedem Daten-Reset neu erzeugt.';

alter table aufgaben
  add column einrichtung_schluessel text references einrichtungsaufgaben on delete set null,
  add column link text check (link is null or link ~ '^/');
comment on column aufgaben.einrichtung_schluessel is 'Herkunft aus einrichtungsaufgaben — je Schlüssel höchstens eine Aufgabe je Datengeneration.';
comment on column aufgaben.link is 'Seite in KRNL, auf der die Aufgabe erledigt wird (Knopf „Öffnen" in der Liste).';

-- Je Schlüssel höchstens eine Aufgabe, solange der Datensatz lebt (auch erledigte zählen).
create unique index aufgaben_einrichtung_idx on aufgaben (einrichtung_schluessel)
  where einrichtung_schluessel is not null;

/*
 * Legt für jede aktive Einrichtungsaufgabe, zu der es noch keine Aufgabe gibt,
 * eine offene Aufgabe an. Idempotent: ein zweiter Aufruf legt nichts doppelt
 * an, eine erledigte bleibt erledigt. Liefert die Anzahl neuer Aufgaben.
 */
create or replace function einrichtungsaufgaben_anlegen(p_actor text default 'system')
returns int
language plpgsql
set search_path = public, pg_temp as $$
declare
  v_neu int;
begin
  insert into aufgaben (titel, beschreibung, rolle, faellig_am, erstellt_von, einrichtung_schluessel, link)
  select e.titel, e.beschreibung, e.rolle, current_date + e.frist_tage, p_actor, e.schluessel, e.link
  from einrichtungsaufgaben e
  where e.aktiv
    and not exists (select 1 from aufgaben a where a.einrichtung_schluessel = e.schluessel)
  order by e.sortierung, e.schluessel;
  get diagnostics v_neu = row_count;
  return v_neu;
end $$;

-- --- Betriebsdaten löschen: die Liste bleibt, die Aufgaben kommen wieder ----------
-- Voller Körper aus 0108, Behalten-Liste um einrichtungsaufgaben erweitert und
-- am Ende einrichtungsaufgaben_anlegen().
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
    'pflichtdokument_regeln',
    -- Einrichtungsaufgaben (0116): die Todo-Liste des Betreibers ist Struktur.
    'einrichtungsaufgaben'
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

  -- Die Betreiber-Todos stehen nach jedem Reset wieder offen.
  perform einrichtungsaufgaben_anlegen('system');

  perform refresh_analytics('demodaten-loeschen');
end $$;

-- --- Die Liste vor dem Stichtag (Kundenrechnungen aus KRNL, 0115) ------------------
insert into einrichtungsaufgaben (schluessel, titel, beschreibung, link, sortierung) values
  ('rechnung_nummernkreis',
   'Nummernkreise RE-/GU- auf die nächste freie Shopify-Nummer setzen',
   'KRNL nummeriert Rechnungen und Gutschriften ab dem Stichtag selbst. Damit die Nummern lückenlos an Shopify anschließen: im Shop die letzte Rechnung und Gutschrift nachsehen (zuletzt bekannt RE-7812 und GU-1416) und unter Einstellungen → Belege → Nummernkreise die nächste Nummer eintragen (z. B. 7813 und 1417).',
   '/einstellungen/belege', 10),
  ('firma_pflichtangaben',
   'Firmendaten für den Rechnungsfuß prüfen',
   'Registergericht, Handelsregister-Nummer, Steuernummer und USt-IdNr., Geschäftsführung, Web, IBAN/BIC und Bank unter Einstellungen → Firma eintragen — sie stehen im Fuß jeder Rechnung, Gutschrift und Mahnung.',
   '/einstellungen', 20),
  ('shopify_rechnungsapp',
   'Shopify-Rechnungs-App abschalten',
   'Ab dem Stichtag entsteht die Rechnung in KRNL mit der Lieferung. Die Rechnungs-App im Shop deaktivieren, sonst bekommt der Kunde zwei Rechnungen mit zwei Nummernkreisen.',
   '/verkauf/rechnungen', 30),
  ('datev_konten',
   'DATEV-Konten mit der Steuerberatung abstimmen',
   'Kontenrahmen (SKR03 vorbelegt, SKR04 möglich), Debitoren-Sammelkonto und Erlöskonten je Steuersatz unter Einstellungen → Belege → Kundenrechnungen eintragen; danach den ersten Buchungsstapel (Verkauf → Rechnungen → DATEV) zur Probe übergeben.',
   '/einstellungen/belege', 40),
  ('rechnung_mailversand',
   'Rechnungsversand per E-Mail: Vorgehen festlegen',
   'Noch nicht gebaut — die Rechnung gibt es als PDF zum Abruf (Verkauf → Rechnungen → PDF). Bis dahin das PDF von Hand an Firmenkunden senden (Shop-Kunden bekommen die Bestellbestätigung aus Shopify) oder den Mailversand als Ausbau beauftragen.',
   '/verkauf/rechnungen', 50);

select einrichtungsaufgaben_anlegen('system');
