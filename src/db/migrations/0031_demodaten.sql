-- ===========================================================================
-- Neustart auf Knopfdruck: alle Bewegungs- und Beispieldaten löschen
-- ===========================================================================
--
-- Ein frisch bereitgestelltes System trägt die Beispieldaten des Seeds. Sobald
-- der echte Betrieb beginnt (Shopify-Erstübernahme), sollen sie restlos weg —
-- samt Buchungshistorie, Bewertungsschichten und Belegnummern.
--
-- Zwei Entwurfsentscheidungen:
--
-- 1. Die Funktion arbeitet mit einer BEHALTEN-Liste statt einer Lösch-Liste:
--    gelöscht wird jede Tabelle des Schemas, die nicht ausdrücklich Struktur
--    oder Konfiguration ist. Neue Tabellen späterer Migrationen sind damit
--    automatisch erfasst — Geschäftsdaten zu vergessen wäre der teurere Fehler.
--
-- 2. Das truncate läuft bewusst OHNE cascade. Die Liste enthält bereits alle
--    abhängigen Tabellen; sollte je eine behaltene Tabelle auf eine gelöschte
--    verweisen, bricht die Funktion laut ab, statt still Konfiguration
--    mitzureißen.
--
-- Der Seed (scripts/seed.ts) prüft den hier gesetzten Merker settings.demo:
-- ohne diese Sperre würde der nächste Vercel-Build (db:seed --demo) die
-- gerade gelöschten Beispieldaten wieder anlegen.

create or replace function demodaten_loeschen() returns void
language plpgsql as $$
declare
  v_behalten constant text[] := array[
    'schema_migrations', 'settings', 'users', 'sessions',
    'uom_categories', 'uoms', 'currencies', 'exchange_rates',
    'warehouses', 'stock_locations', 'operation_types',
    'taxes', 'payment_terms', 'incoterms', 'product_categories',
    'sequences', 'tags'
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

  -- Die beiden Demo-Konten des Seeds. Der Administrator und alle selbst
  -- angelegten Benutzer bleiben — auch ihre laufenden Anmeldungen.
  delete from sessions where user_id in (
    select id from users
    where lower(email) in ('lager@example.com', 'fertigung@example.com'));
  delete from users
  where lower(email) in ('lager@example.com', 'fertigung@example.com');

  -- Belegnummern beginnen wieder bei 1 (Startwert der Sequenz zählt nicht:
  -- der steht auf dem Stand zum Zeitpunkt der Migration 0026).
  update sequences set next_number = 1;
  for r in select code from sequences loop
    execute format('alter sequence %I restart with 1', 'seq_' || r.code);
  end loop;

  insert into settings (key, value)
  values ('demo', jsonb_build_object('geloescht', true, 'zeitpunkt', now()))
  on conflict (key) do update set value = excluded.value;

  -- Kennzahlen sofort leeren — nicht erst beim nächsten Analytics-Cron.
  perform refresh_analytics('demodaten-loeschen');
end $$;

comment on function demodaten_loeschen is
  'Löscht alle Belege, Produkte, Partner, Bestände und Protokolle; Struktur '
  '(Lagerorte, Einheiten, Steuern, Benutzer, Einstellungen) bleibt. Setzt den '
  'Merker settings.demo, damit der Seed keine Beispieldaten mehr anlegt.';
