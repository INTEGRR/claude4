-- ===========================================================================
-- 0069  Werkszustand: der zweite, größere Reset
-- ===========================================================================
-- Bisher gab es genau EINEN Knopf in der Gefahrenzone, und der heißt „alle
-- Daten löschen (Neustart)". Er tut das auch — aber nur für BETRIEBSdaten:
-- Belege, Produkte, Partner, Bestände, Protokolle. Bewusst erhalten bleiben
-- Konfiguration, Benutzerkonten, Firmendaten und vor allem das ganze
-- Prozessmodell.
--
-- Für den Pilotbetrieb fehlt die Stufe darüber: „so, als wäre die Instanz
-- gerade frisch provisioniert worden". Wer eine Woche lang Prozesse
-- ausprobiert hat, sitzt sonst auf vier Versionen des Verkaufsprozesses,
-- einer halb umgestellten Navigation und einer Ersteinrichtung, die nie
-- wiederkommt.
--
-- Zwei Stufen, klar benannt:
--   demodaten_loeschen()     — Betriebsdaten weg, Einrichtung bleibt
--   werkszustand_herstellen()— zusätzlich alles, was diese Instanz zu DIESER
--                              Instanz gemacht hat
--
-- Was der Werkszustand NICHT anfasst, steht ausdrücklich unten: technische
-- Konfiguration (DHL-Absender, Freigabe-Limits, Finanz-Quoten) ist Einrichtung
-- des Betreibers, nicht Kundendatenbestand — und Zugangsdaten stehen ohnehin
-- in Umgebungsvariablen.
--
-- Rein additiv (zwei Funktionen).

-- --- Stufe 1: Registrierungen überleben den Betriebsdaten-Reset ------------
-- Interessenten von der öffentlichen Startseite sind keine Betriebsdaten der
-- Firma, sondern der Vertriebseingang des Betreibers. Sie fielen bisher
-- stillschweigend mit — unwiederbringlich, weil es keine zweite Quelle gibt.
create or replace function demodaten_loeschen()
returns void language plpgsql as $$
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

-- --- Stufe 2: Werkszustand --------------------------------------------------
create or replace function werkszustand_herstellen(p_admin uuid, p_actor text default 'system')
returns void language plpgsql as $$
declare
  v_rolle text;
  v_geloescht int;
begin
  -- Der Ausführende bleibt als einziges Konto stehen. Ohne ihn wäre die
  -- Instanz nach dem Reset für niemanden mehr erreichbar.
  select role into v_rolle from users where id = p_admin;
  if v_rolle is null then
    raise exception 'Unbekanntes Konto — der Werkszustand braucht das Konto, das ihn auslöst';
  end if;
  if v_rolle <> 'admin' then
    raise exception 'Nur Administratoren können den Werkszustand herstellen';
  end if;

  -- Stufe 1 zuerst: Betriebsdaten weg (inkl. Nummernkreise auf 1).
  perform demodaten_loeschen();

  -- Alles, was diese Instanz zu DIESER Instanz gemacht hat:

  -- 1. Eigene Prozessversionen. Was aus einer Migration stammt, ist
  --    Auslieferungsstand und bleibt; Entwürfe und selbst gebaute Versionen
  --    fallen. Prozesse, von denen danach keine Version übrig ist, waren
  --    komplett selbst gebaut und verschwinden mit.
  delete from prozess_versionen
  where coalesce(created_by, '') not like 'migration:%'
    and coalesce(created_by, '') <> 'system';
  delete from prozesse p
  where not exists (select 1 from prozess_versionen v where v.prozess_id = p.id);

  -- 2. Laufzeit-Anpassungen: abgeschaltete Schritte, eigene Felder.
  delete from prozess_overrides;
  delete from feld_definitionen;

  -- 3. Navigation zurück auf Auslieferung: ohne Paketwahl ist ALLES aktiv.
  update prozesse set aktiv = true;

  -- 4. Benutzerkonten außer dem Ausführenden.
  delete from sessions where user_id <> p_admin;
  get diagnostics v_geloescht = row_count;
  delete from users where id <> p_admin;

  -- 5. Firmendaten auf den Auslieferungsstand (Migration 0001).
  update settings
     set value = '{"name":"Meine Firma GmbH","street":"Musterstraße","house":"1",
                   "zip":"10115","city":"Berlin","country":"DEU",
                   "email":"info@example.com","phone":""}'::jsonb
   where key = 'company';

  -- 6. Die Ersteinrichtung kommt wieder. Genau das ist der Unterschied zu
  --    Stufe 1, wo der Schlüssel bewusst überlebt.
  delete from settings where key in ('einrichtung', 'demo');

  -- NICHT angefasst: technische Konfiguration (DHL-Absender, Freigabe-Limits,
  -- Finanz-Quoten, Kartonagen-/Versandregeln), Lagerorte, Einheiten, Steuern,
  -- Zahlungsbedingungen — das ist Einrichtung des Betreibers, kein
  -- Kundendatenbestand. Und die Registrierungen der Startseite.

  perform log_event('system', gen_random_uuid(), 'state',
    'Werkszustand hergestellt — Betriebsdaten, eigene Prozessversionen, ' ||
    'Firmendaten und Konten zurückgesetzt', p_actor);
end $$;

comment on function werkszustand_herstellen(uuid, text) is
  'Zweite Stufe der Gefahrenzone: Instanz wie frisch provisioniert (Ersteinrichtung erscheint wieder).';
