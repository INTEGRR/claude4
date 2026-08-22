-- ===========================================================================
-- 0071  Eigene Felder gehören zum PROZESS, nicht zum Modell
-- ===========================================================================
-- Das Chamäleon-Versprechen lautet: der Kunde beschreibt seinen Ablauf, und
-- daraus entsteht die Oberfläche — Navigation, Maske, Liste. Bei den Feldern
-- war das bisher nicht eingelöst.
--
-- `feld_definitionen` hing am MODELL. Alle Laufzeit-Prozesse teilen sich das
-- Modell 'vorgang', also sahen sie zwangsläufig dieselben Felder: wer für die
-- Angebotsaufnahme ein Feld „Budget" anlegt, bekommt es auch im
-- Reklamationsablauf und im Bewerbungsablauf. Und ein zweiter Prozess konnte
-- „budget" gar nicht erst anlegen — unique (modell, name) stand im Weg.
--
-- Dazu kam: Felder entstanden NUR über einen eigenen Handgriff
-- (einstellungen.feld_anlegen). Der Prozessentwurf kannte keine Felder. Wer
-- seinen Prozess im Onboarding oder in der Werkstatt aufnimmt, bekam also
-- Schritte und Zustände geschenkt — und musste die Datenfelder danach von
-- Hand nachtragen, an einer Stelle, die er nie findet.
--
-- Deshalb zwei Spalten:
--
--   prozess_code  null = gilt für das ganze Modell (bisheriges Verhalten,
--                 z. B. ein Feld an ALLEN Kontakten).
--                 gesetzt = gehört zu genau diesem Prozess.
--   schritte      null/leer = in jedem Schritt sichtbar.
--                 gesetzt = nur in diesen Schritt-Codes — so erfasst die
--                 Maske je Schritt genau das, was dort anfällt.
--
-- Die Felder hängen bewusst am PROZESS und nicht an der VERSION: sie sind
-- Datenstruktur, keine Ablaufdefinition. Die erfassten Werte stehen im
-- zusatz-jsonb der Belege und überleben jeden Versionswechsel — ein Feld, das
-- eine neue Version nicht mehr nennt, wird deshalb NICHT gelöscht (sonst
-- verlöre die Liste rückwirkend ihre Spalten). Expand-Contract auch hier:
-- Aufräumen ist ein bewusster eigener Schritt (einstellungen.feld_loeschen).
--
-- Rein additiv bis auf den Unique-Constraint, der die Prozess-Trennung
-- verhindert.

alter table feld_definitionen
  add column prozess_code text references prozesse (code) on delete cascade,
  add column schritte     text[];

comment on column feld_definitionen.prozess_code is
  'null = Feld gilt für das ganze Modell; gesetzt = nur für diesen Prozess (Laufzeit-Prozesse teilen sich das Modell vorgang).';
comment on column feld_definitionen.schritte is
  'null/leer = in jedem Schritt sichtbar; sonst nur in diesen Schritt-Codes.';

-- DESTRUKTIV: unique (modell, name) verhindert, dass zwei Prozesse desselben
-- Modells ein gleichnamiges Feld führen ("budget" im Angebots- UND im
-- Anfrageablauf). Genau das ist der Zweck dieser Migration. Es gehen keine
-- Daten verloren — der Constraint wird durch einen engeren ersetzt, der
-- zusätzlich den Prozess einbezieht; bestehende Zeilen (prozess_code null)
-- bleiben dadurch weiterhin eindeutig.
alter table feld_definitionen drop constraint feld_definitionen_modell_name_key;

create unique index feld_definitionen_eindeutig
  on feld_definitionen (modell, coalesce(prozess_code, ''), name);

create index feld_definitionen_prozess_idx
  on feld_definitionen (prozess_code) where prozess_code is not null;

-- Aufräumen beim Werkszustand: die Felder fallen ohnehin komplett
-- (0069 leert feld_definitionen); der Fremdschlüssel oben sorgt jetzt
-- zusätzlich dafür, dass ein gelöschter Prozess seine Felder mitnimmt.
