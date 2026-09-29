-- ============================================================================
-- 0087  Arbeitsplätze mit Druckern — jeder Druck kommt am richtigen Platz raus
-- ----------------------------------------------------------------------------
-- ANVIL hat zwei Versandtische mit je einem Labeldrucker (unterschiedliche
-- Formate), dazu in der Fertigung einen Etikettendrucker für
-- Fertigungsaufträge und einen A4-Drucker. Die Druckbrücke kannte bisher nur
-- zwei feste Ziele („labeldrucker", „zetteldrucker"): bei zwei Tischen
-- druckte der Agent, der zuerst abholte, und das DHL-Format galt global.
--
-- Entscheidungen (Interview 2026-09-29, Entscheidungslog):
--   * Packtische, Montagetische … SIND die Arbeitsplätze der Fertigung
--     (work_centers: Stundensatz, Arbeitsgänge, Schichtplan) — erweitert um
--     eine Art. Eine Liste für alles.
--   * Drucker stehen an Arbeitsplätzen und tragen ihr Format (Maße, DHL-
--     Druckformat). Je Arbeitsplatz und Druckart ein Druckweg; ein Weg ohne
--     Arbeitsplatz ist der Ersatz für alle Plätze.
--   * Der PC merkt sich seinen Arbeitsplatz (Cookie) — das Modell hier kennt
--     davon nichts; der Druckauftrag hält fest, von welchem Platz er kam.
--
-- Arbeitsplätze, Drucker und Wege sind Konfiguration: „Betriebsdaten löschen"
-- behält sie jetzt (bisher fielen die Arbeitsplätze mit), der Werkszustand
-- räumt sie weiterhin ab.
-- ============================================================================

-- --- 1. Arbeitsplätze bekommen eine Art ------------------------------------
alter table work_centers add column art text not null default 'fertigung'
  check (art in ('fertigung', 'versand', 'lager', 'sonstiges'));
comment on column work_centers.art is
  'Art des Arbeitsplatzes: fertigung (Montagetisch …), versand (Packtisch), lager, sonstiges';

-- --- 2. Drucker --------------------------------------------------------------
create table drucker (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,
  -- Wo er steht — zur Anzeige; welcher Platz auf ihm druckt, sagen die Wege.
  work_center_id  uuid references work_centers on delete set null,
  -- Name des Druckers unter Windows (für SumatraPDF); leer = Standarddrucker.
  druckername     text,
  typ             text not null check (typ in ('label', 'a4')),
  breite_mm       numeric(6,1) check (breite_mm is null or breite_mm > 0),
  hoehe_mm        numeric(6,1) check (hoehe_mm is null or hoehe_mm > 0),
  -- DHL-Druckformat für Versandlabels auf diesem Drucker (sonst der Standard
  -- aus settings.dhl.print_format).
  dhl_format      text,
  aktiv           boolean not null default true,
  -- Letzter Abruf seines Agenten.
  zuletzt_gesehen timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz,
  check (typ = 'a4' or (breite_mm is not null and hoehe_mm is not null))
);
select attach_touch_trigger('drucker');
comment on table drucker is
  'Drucker der Druckbrücke: Standort, Windows-Name, Typ (label/a4), Maße, DHL-Format, letzter Agent-Abruf';

-- --- 3. Druckwege: Arbeitsplatz × Druckart → Drucker -------------------------
create table arbeitsplatz_druckwege (
  id             uuid primary key default gen_random_uuid(),
  -- null = Ersatz für alle Arbeitsplätze ohne eigenen Weg.
  work_center_id uuid references work_centers on delete cascade,
  druckart       text not null check (druckart in (
                   'versandlabel', 'packzettel', 'fertigungszettel',
                   'fertigungsetikett', 'artikeletikett')),
  drucker_id     uuid not null references drucker on delete cascade,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz,
  unique nulls not distinct (work_center_id, druckart)
);
select attach_touch_trigger('arbeitsplatz_druckwege');
comment on table arbeitsplatz_druckwege is
  'Druckweg je Arbeitsplatz und Druckart; work_center_id null = Ersatzdrucker für alle Plätze';

-- --- 4. Druckaufträge: Drucker, Herkunft, neue Arten (Expand) ----------------
alter table druckauftraege
  add column drucker_id uuid references drucker on delete set null,
  add column arbeitsplatz_id uuid references work_centers on delete set null,
  add column angefordert_von text,
  add column picking_id uuid references stock_pickings on delete cascade,
  add column variant_id uuid references product_variants on delete cascade,
  add column anzahl int not null default 1 check (anzahl between 1 and 500),
  -- Beim Abholen gesetzt; ohne Quittung nach zwei Minuten erneut angeboten.
  add column abgeholt_am timestamptz;

-- DESTRUKTIV: nur die Checks für Art und Beleg fallen — beide werden direkt darunter breiter neu angelegt; keine Daten gehen verloren.
alter table druckauftraege drop constraint druckauftraege_art_check;
alter table druckauftraege add constraint druckauftraege_art_check
  check (art in ('label', 'zettel', 'packzettel', 'fertigungsetikett', 'artikeletikett'));
alter table druckauftraege drop constraint druckauftraege_beleg_check;
alter table druckauftraege add constraint druckauftraege_beleg_check
  check ((art = 'label' and shipment_id is not null)
      or (art in ('zettel', 'fertigungsetikett') and mo_id is not null)
      or (art = 'packzettel' and picking_id is not null)
      or (art = 'artikeletikett' and variant_id is not null));

create index druckauftraege_drucker_offen_idx on druckauftraege (drucker_id, created_at)
  where status = 'offen';
comment on column druckauftraege.drucker_id is
  'Zieldrucker (0087) — Agenten mit Drucker-ID holen nur ihre Aufträge; ohne Drucker gilt das alte Ziel';

-- --- 5. Betriebsdaten löschen: Arbeitsplätze, Drucker, Wege sind Konfiguration
-- Voller Körper aus 0083, Behalten-Liste um drei Tabellen erweitert.
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
    'work_centers', 'drucker', 'arbeitsplatz_druckwege'
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

-- --- 6. Werkszustand: Arbeitsplätze und Drucker fallen weiterhin ------------
-- Bisher räumte demodaten_loeschen die Arbeitsplätze mit ab; der Werkszustand
-- (neue Instanz für einen neuen Betrieb) soll das weiter tun. Voller Körper
-- aus 0083 plus die drei Löschungen.
create or replace function werkszustand_herstellen(p_admin uuid, p_actor text default 'system')
returns void language plpgsql
set search_path = public, pg_temp as $$
declare
  v_rolle text;
  v_geloescht int;
begin
  select role into v_rolle from users where id = p_admin;
  if v_rolle is null then
    raise exception 'Unbekanntes Konto — der Werkszustand braucht das Konto, das ihn auslöst';
  end if;
  if v_rolle <> 'admin' then
    raise exception 'Nur Administratoren können den Werkszustand herstellen';
  end if;

  perform demodaten_loeschen();

  -- Arbeitsplätze mit Druckern gehören zum Betrieb, nicht zur Auslieferung.
  delete from arbeitsplatz_druckwege;
  delete from drucker;
  delete from work_centers;

  delete from prozess_versionen
  where coalesce(created_by, '') not like 'migration:%'
    and coalesce(created_by, '') <> 'system';
  delete from prozesse p
  where not exists (select 1 from prozess_versionen v where v.prozess_id = p.id);

  delete from prozess_overrides;
  delete from feld_definitionen f
   where f.prozess_code is null
      or not exists (
        select 1 from prozess_versionen v
        join prozesse p on p.id = v.prozess_id
        where p.code = f.prozess_code
          and (coalesce(v.created_by, '') like 'migration:%' or v.created_by = 'system'));

  update prozesse set aktiv = true;

  delete from sessions where user_id <> p_admin;
  get diagnostics v_geloescht = row_count;
  delete from users where id <> p_admin;

  update settings
     set value = '{"name":"Meine Firma GmbH","street":"Musterstraße","house":"1",
                   "zip":"10115","city":"Berlin","country":"DEU",
                   "email":"info@example.com","phone":""}'::jsonb
   where key = 'company';

  delete from settings where key in ('einrichtung', 'demo');

  perform log_event('system', gen_random_uuid(), 'state',
    'Werkszustand hergestellt — Betriebsdaten, eigene Prozessversionen, ' ||
    'Arbeitsplätze, Firmendaten und Konten zurückgesetzt', p_actor);
end $$;
