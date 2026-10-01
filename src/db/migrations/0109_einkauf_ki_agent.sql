-- ============================================================================
-- 0109  Einkauf, Stufe 6 — der Agent, NUR Entwürfe
-- ----------------------------------------------------------------------------
-- Betreiber (Interview 2026-09-29): „Agent zuletzt: nur Entwürfe, läuft
-- sofort bei jeder eingehenden Mail." Der Agent sichtet jede eingehende
-- Nachricht (Job ki_mail_triage) und liest PDFs/Bilder (Job
-- ki_dokument_lesen). Er SCHREIBT nur zweierlei:
--
--  1. Vorschläge (`ki_vorschlaege`, Semantik von sprach_vorgaenge 0062):
--     eine Registry-Aktion mit Parametern und Begründung, die erst ein
--     Mensch annimmt — ausgeführt über den Torwächter ALS dieser Mensch
--     (Rechte und Schema wie immer), Ergebnis oder Fehler stehen danach am
--     Vorschlag. Beleg ohne Prozess (wie Mail-Threads): Arbeitsvorrat am
--     Thread, Projekt, an Bestellung und Lieferant.
--  2. Mail-Entwürfe (`mail_entwuerfe`, quelle 'agent', Status 'entwurf') —
--     gesendet wird wie immer erst nach der Freigabe im Prozess mail_versand.
--
-- Dazu: Suchvektor über Name + gelesenen Text der Dokumente, Lesestatus je
-- Dokument (Excel ist ohne Parser „nicht lesbar"), Sichtungsmarke je
-- Nachricht, Cache-Token im Verbrauchsprotokoll und der Schalter der
-- KI-Ebene „einkauf" (standardmäßig AUS — der Betreiber schaltet ihn ein,
-- wenn das Postfach läuft; go-live.md 7b).
--
-- Entscheidungslog 2026-10-01, „Einkauf Stufe 6".
-- ============================================================================

-- --- 1. Vorschläge des Agenten -----------------------------------------------

create type ki_vorschlag_status as enum ('offen', 'angenommen', 'verworfen', 'fehler');

create table ki_vorschlaege (
  id                  uuid primary key default gen_random_uuid(),
  -- Registry-Aktion (mit Punkt), die beim Annehmen läuft — nur aus der
  -- geschlossenen Liste des Agenten (src/modules/ki/einkauf-prompt.ts).
  aktion              text not null,
  parameter           jsonb not null default '{}'::jsonb,
  record_id           uuid,
  art                 text not null default 'sonstiges'
                      check (art in ('zuordnung', 'angebot', 'wiedervorlage', 'entscheidungsvorlage', 'dokument', 'sonstiges')),
  titel               text not null,
  begruendung         text not null,
  -- Worauf sich der Vorschlag stützt: [{art: 'nachricht'|'dokument'|'angebot'|'bestellung', id, titel}]
  belege              jsonb not null default '[]'::jsonb,
  modell              text,
  status              ki_vorschlag_status not null default 'offen',
  -- Auslöser: die gesichtete Nachricht bzw. das gelesene Dokument.
  quelle              text not null check (quelle in ('mail_nachricht', 'dokument')),
  quelle_id           uuid,
  -- Wo der Vorschlag erscheint (Thread, Projekt, Bestellung, Lieferantenakte).
  thread_id           uuid references mail_threads on delete set null,
  partner_id          uuid references partners on delete set null,
  einkaufsprojekt_id  uuid references einkaufsprojekte on delete set null,
  purchase_order_id   uuid references purchase_orders on delete set null,
  erstellt_am         timestamptz not null default now(),
  geaendert_von       text,
  geaendert_am        timestamptz,
  entschieden_von     text,
  entschieden_am      timestamptz,
  ergebnis            text,
  ergebnis_link       text,
  fehler              text,
  updated_at          timestamptz
);
select attach_touch_trigger('ki_vorschlaege');
create index ki_vorschlaege_offen_idx on ki_vorschlaege (erstellt_am desc) where status in ('offen', 'fehler');
create index ki_vorschlaege_thread_idx on ki_vorschlaege (thread_id);
create index ki_vorschlaege_projekt_idx on ki_vorschlaege (einkaufsprojekt_id);
create index ki_vorschlaege_bestellung_idx on ki_vorschlaege (purchase_order_id);
create index ki_vorschlaege_partner_idx on ki_vorschlaege (partner_id);
create index ki_vorschlaege_quelle_idx on ki_vorschlaege (quelle, quelle_id);

comment on table ki_vorschlaege is
  'Vorschläge des Einkaufs-Agenten (0109): Registry-Aktion + Parameter + Begründung + Belege; ausgeführt erst, wenn ein Mensch annimmt (Torwächter, als dieser Mensch). Status offen|angenommen|verworfen|fehler';

-- Beleg ohne Prozess (wie mail_thread): der Existenz-Check des Torwächters
-- für einkauf.vorschlag_annehmen/_verwerfen/_aendern greift damit.
insert into prozess_modelle (modell, tabelle, status_spalte, routen_muster)
values ('ki_vorschlag', 'ki_vorschlaege', 'status', null)
on conflict (modell) do nothing;

-- --- 2. Sichtung je Nachricht, Lesestatus und Suche je Dokument --------------

alter table mail_nachrichten add column ki_gesichtet_am timestamptz;

comment on column mail_nachrichten.ki_gesichtet_am is
  'Wann der Einkaufs-Agent die Nachricht gesichtet hat (0109) — eine zweite Sichtung derselben Nachricht gibt es nicht';

alter table dokumente
  add column text_status text check (text_status in ('gelesen', 'nicht_lesbar', 'fehler')),
  add column text_gelesen_am timestamptz;

-- Volltext über Dateiname und gelesenen Text ('simple' wie mail_nachrichten:
-- Lieferanten schreiben deutsch, englisch und chinesisch durcheinander).
alter table dokumente
  add column suche tsvector generated always as
    (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(text_auszug, ''))) stored;
create index dokumente_suche_idx on dokumente using gin (suche);

comment on column dokumente.text_status is
  'Lesestatus des Agenten (0109): gelesen (text_auszug gefüllt), nicht_lesbar (z. B. Excel ohne Parser, zu groß), fehler';

-- --- 3. Verbrauch: Cache-Token getrennt ----------------------------------------

-- Der Agent nutzt Prompt-Caching (Schema-Doku, Werkzeuge); gelesene
-- Cache-Token kosten einen Bruchteil — für die Verbrauchsanzeige getrennt.
alter table ki_verbrauch
  add column cache_lesen_tokens int not null default 0,
  add column cache_schreiben_tokens int not null default 0;

-- --- 4. KI-Ebene „einkauf": standardmäßig aus ----------------------------------

insert into settings (key, value)
values ('ki_einkauf', '{"aktiv": false}'::jsonb)
on conflict (key) do nothing;
