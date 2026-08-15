-- ===========================================================================
-- Fehlermeldungen: der Bugtracker im System selbst
-- ===========================================================================
--
-- Wer im ERP auf einen Fehler läuft, meldet ihn dort, wo er auftritt — mit
-- Seite, Beschreibung und Schweregrad direkt in die Datenbank. Die
-- Entwicklung (der KI-Agent auf Zuruf) liest die offenen Meldungen aus
-- derselben Datenbank, arbeitet sie ab und schreibt den Bearbeitungsstand
-- zurück. Kein externes Werkzeug, keine Zettel.
--
-- Kommentare/Verlauf laufen wie überall über log_event('bug_report', id, …)
-- — die Kommentarleiste am Datensatz gibt es damit umsonst.

create type bug_status as enum ('offen', 'in_arbeit', 'behoben', 'verworfen');
create type bug_schwere as enum ('kritisch', 'stoerend', 'kosmetisch');

insert into sequences (code, prefix, padding, next_number)
values ('bug', 'BUG/', 5, 1);

create table bug_reports (
  id          uuid primary key default gen_random_uuid(),
  number      text unique not null,
  titel       text not null,
  -- Was ist passiert, was war erwartet? Freitext des Melders.
  beschreibung text,
  -- Wo: der Pfad im ERP (/versand, /lager/<id>, …) — vorbelegt von der
  -- meldenden Seite, damit die Entwicklung den Ort nicht raten muss.
  seite       text,
  schwere     bug_schwere not null default 'stoerend',
  status      bug_status not null default 'offen',
  gemeldet_von text not null,
  -- Bearbeitungsvermerk der Entwicklung: was war die Ursache, was wurde
  -- geändert (Commit), was ist zu prüfen.
  aufloesung  text,
  behoben_am  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);
select attach_touch_trigger('bug_reports');
create index bug_reports_status_idx on bug_reports (status, created_at desc);

comment on table bug_reports is
  'Fehlermeldungen aus dem laufenden Betrieb. Offene Meldungen werden von '
  'der Entwicklung auf Zuruf direkt aus der Datenbank gelesen und der '
  'Bearbeitungsstand (status, aufloesung) zurückgeschrieben.';
