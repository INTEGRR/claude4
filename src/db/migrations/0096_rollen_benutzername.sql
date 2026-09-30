-- ============================================================================
-- 0096  Mehrere Rollen je Benutzer, Anmeldung ohne E-Mail
-- ----------------------------------------------------------------------------
-- Wer im Lager UND in der Fertigung arbeitet, bekommt beide Rollen: die
-- Hauptrolle bleibt `role`, dazu kommen Zusatzrollen; die Rechte sind die
-- Vereinigung (permissions.ts). Administrator bleibt Hauptrolle.
-- Lager- und Fertigungsleute haben oft keine E-Mail-Adresse: Anmeldename
-- ist künftig E-Mail ODER Benutzername. Entscheidungslog 2026-09-30.
-- ============================================================================

alter table users add column zusatz_rollen user_role[] not null default '{}';
alter table users add constraint users_zusatz_rollen_ohne_admin
  check (not ('admin' = any (zusatz_rollen)));

alter table users add column benutzername text;
alter table users add constraint users_benutzername_format
  check (benutzername is null or benutzername ~ '^[a-z0-9][a-z0-9._-]{1,39}$');
create unique index users_benutzername_idx on users (lower(benutzername)) where benutzername is not null;

-- E-Mail wird optional (nicht destruktiv: lockert nur); eine Kennung muss sein.
alter table users alter column email drop not null;
alter table users add constraint users_kennung
  check (email is not null or benutzername is not null);

comment on column users.zusatz_rollen is
  'Weitere Rollen neben der Hauptrolle (0096) — Rechte = Vereinigung; Administrator nur als Hauptrolle';
comment on column users.benutzername is
  'Anmeldename ohne E-Mail (0096) — klein, a–z/0–9/._-, eindeutig ohne Groß/Klein';
