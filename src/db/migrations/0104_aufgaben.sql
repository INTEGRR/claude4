-- ============================================================================
-- 0104  Aufgaben für Mitarbeiter
-- ----------------------------------------------------------------------------
-- Was nicht aus einem Beleg kommt, sondern aus dem Kopf des Chefs: „feg mal
-- bitte hinten das Lager durch", „bereite die Gehäuse für Montag vor". Eine
-- Aufgabe hat einen Titel, einen Zuständigen — eine Person ODER ein Team
-- (Rolle, z. B. alle aus dem Lager) —, einen Termin (Tag, optional Uhrzeit)
-- und eine geschätzte Dauer. Sie erscheint beim Zuständigen in der Übersicht
-- und wird dort abgehakt.
--
-- Bewusst prozessfrei (wie die Wiedervorlagen, 0093): eine Aufgabe ist ein
-- Zettel mit Haken, kein Ablauf — der Status hier ist die einzige Wahrheit.
-- Angelegt wird über die Registry (aufgaben.anlegen), auch per Sprechen.
-- Entscheidungslog 2026-10-01, „Aufgaben für Mitarbeiter".
-- ============================================================================

create type aufgabe_status as enum ('offen', 'erledigt', 'verworfen');

create table aufgaben (
  id              uuid primary key default gen_random_uuid(),
  titel           text not null check (length(btrim(titel)) between 1 and 200),
  beschreibung    text,
  -- Zuständig: eine Person, sonst das Team der Rolle (Haupt- oder Zusatzrolle).
  zustaendig_id   uuid references users(id) on delete set null,
  rolle           user_role,
  faellig_am      date not null,
  uhrzeit         time,
  -- Termin als Zeitpunkt (Ortszeit Berlin; ohne Uhrzeit = Tagesende) — für
  -- Sortierung und „überfällig", ohne dass jede Abfrage es nachrechnet.
  faellig_um      timestamptz generated always as
                    ((faellig_am + coalesce(uhrzeit, time '23:59')) at time zone 'Europe/Berlin') stored,
  dauer_min       integer check (dauer_min between 1 and 1440),
  status          aufgabe_status not null default 'offen',
  erstellt_von    text not null,
  erstellt_von_id uuid references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  erledigt_am     timestamptz,
  erledigt_von    text,
  -- Rückmeldung beim Abhaken („Regal 4 war voll, Rest morgen").
  notiz           text,
  check ((status = 'offen') = (erledigt_am is null))
);

create index aufgaben_offen_idx on aufgaben (faellig_um) where status = 'offen';
create index aufgaben_zustaendig_idx on aufgaben (zustaendig_id) where status = 'offen';

comment on table aufgaben is
  'Aufgaben für Mitarbeiter (0104): Titel, Zuständig (Person oder Rolle), Termin, Dauer; '
  'erscheinen beim Zuständigen in der Übersicht. Prozessfrei — Status ist die Wahrheit.';
