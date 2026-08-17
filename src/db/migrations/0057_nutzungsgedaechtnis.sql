-- Lernendes Benutzer-Gedächtnis fürs Daily-Routine-Dashboard: was jemand oft
-- benutzt (Aktionen, Seiten), steht vorn — je Benutzer, nicht global. Gezählt
-- wird serverseitig (Torwächter je ausgeführter Aktion, Befehlsfeld je
-- geöffneter Seite); gelesen wird nur die eigene Zeile.

create table nutzungs_zaehler (
  user_id    uuid not null references users on delete cascade,
  art        text not null check (art in ('aktion', 'seite')),
  schluessel text not null,
  anzahl     int  not null default 0,
  zuletzt    timestamptz not null default now(),
  primary key (user_id, art, schluessel)
);

comment on table nutzungs_zaehler is
  'Nutzungshäufigkeit je Benutzer (Aktionen und Seiten) — speist „Häufig genutzt" auf der Übersicht und das Ranking im Befehlsfeld.';

create or replace function nutzung_zaehlen(p_user uuid, p_art text, p_schluessel text)
returns void
language sql as $$
  insert into nutzungs_zaehler (user_id, art, schluessel, anzahl)
  values (p_user, p_art, p_schluessel, 1)
  on conflict (user_id, art, schluessel)
  do update set anzahl = nutzungs_zaehler.anzahl + 1, zuletzt = now();
$$;

-- Das Gedächtnis hängt am Benutzer, nicht an den Demodaten — es überlebt den
-- Neustart (Benutzer bleiben ja auch). Deshalb auf die BEHALTEN-Liste.
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
    -- Benutzergebundenes Lern-Gedächtnis (0057): bleibt mit den Benutzern.
    'nutzungs_zaehler'
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
