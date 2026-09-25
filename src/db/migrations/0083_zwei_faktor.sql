-- ============================================================================
-- 0083  Zweiter Faktor (TOTP): Sitzungszustand, Backup-Codes, vertraute Geräte
-- ----------------------------------------------------------------------------
-- Der zweite Faktor ist ein ZUSTAND DER SITZUNG, kein zweites Token-Modell:
-- eine neue Sitzung ist „wartend" (zweiter_faktor_ok = false, zehn Minuten),
-- bis der Code aus der Authenticator-App sie bestätigt. currentUser() sieht
-- nur bestätigte Sitzungen — damit sind alle Seiten und API-Routen ohne
-- eigene Änderung geschützt. Bestandssitzungen bleiben gültig (Default
-- true); die Pflicht greift über das Layout-Tor trotzdem sofort.
--
-- Nur Struktur; die Logik lebt in src/modules/auth/{totp,geheimnis,
-- zweifaktor}.ts. Entscheidungslog 2026-09-25.
-- ============================================================================

-- --- 1. Benutzer: TOTP-Geheimnis (verschlüsselt) und Replay-Schutz ---------
alter table users
  add column totp_secret text,
  add column totp_aktiviert_at timestamptz,
  add column totp_letzter_schritt bigint;

comment on column users.totp_secret is
  'TOTP-Geheimnis, AES-256-GCM-verschlüsselt (auth/geheimnis.ts) — nie im Klartext';
comment on column users.totp_letzter_schritt is
  'zuletzt akzeptierter 30-Sekunden-Schritt: derselbe Code gilt nur einmal';

-- --- 2. Sitzungen: wartend bis zum zweiten Faktor ---------------------------
alter table sessions
  add column zweiter_faktor_ok boolean not null default true,
  add column entwurf text,
  add column einmal text;

comment on column sessions.zweiter_faktor_ok is
  'false = Passwort geprüft, Code fehlt noch; solche Sitzungen laufen nach zehn Minuten ab';
comment on column sessions.entwurf is
  'verschlüsseltes TOTP-Geheimnis während der Einrichtung (bis zur Bestätigung)';
comment on column sessions.einmal is
  'verschlüsselte Einmal-Anzeige (frische Backup-Codes), wird beim Lesen gelöscht';

-- --- 3. Backup-Codes und vertraute Geräte -----------------------------------
create table backup_codes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users on delete cascade,
  code_hash    text not null,
  verwendet_at timestamptz,
  created_at   timestamptz not null default now()
);
create index backup_codes_user_idx on backup_codes (user_id);
comment on table backup_codes is
  'Einmal-Codes für den Notfall ohne Telefon; nur als Hash, jeder gilt einmal';

create table vertraute_geraete (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users on delete cascade,
  token_hash   text not null unique,
  bezeichnung  text not null default '',
  erstellt_at  timestamptz not null default now(),
  laeuft_ab_at timestamptz not null,
  zuletzt_at   timestamptz
);
create index vertraute_geraete_user_idx on vertraute_geraete (user_id);
comment on table vertraute_geraete is
  'Browser, die nach „Dieses Gerät 30 Tage merken" ohne Code auskommen; Cookie erp_geraet, hier nur der Hash';

-- --- 4. Betriebsdaten löschen: die Auth-Tabellen sind Konfiguration --------
-- 0069 truncated alles außerhalb der Behalten-Liste — ohne diesen Nachtrag
-- wäre der zweite Faktor nach „Betriebsdaten löschen" für alle still weg.
-- Neu deklariert mit festem search_path (0080).
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
    'registrierungen'
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

-- --- 5. Werkszustand: unverändert aus 0082, jetzt mit festem search_path ----
-- (0082 hatte den search_path bei der Neudeklaration nicht gesetzt.) Die
-- neuen Tabellen hängen per Cascade an users — „delete from users" räumt
-- sie mit.
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
    'Firmendaten und Konten zurückgesetzt', p_actor);
end $$;
