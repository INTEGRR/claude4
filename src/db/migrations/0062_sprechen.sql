-- ===========================================================================
-- 0062  Sprachmodus /sprechen: Sitzungsprotokolle + Sammel-Transaktion
-- ===========================================================================
-- Der Echtzeit-Sprachmodus (OpenAI Realtime, WebRTC) hinterlässt je Sitzung
-- ein Protokoll: das Transkript beider Seiten, jede Werkzeug-Ausführung und
-- die GESAMMELTEN Schreib-Absichten. Gebucht wird während des Sprechens
-- nichts — die Vorgänge warten mit Status 'offen' auf die tabellarische
-- Sichtprüfung und die Bulk-Buchung (Torwächter-Weg, /api/sprechen/buchen).
--
-- Bewegungsdaten: demodaten_loeschen() (0031) räumt alle drei Tabellen
-- automatisch mit ab, weil sie nicht auf der Behalten-Liste stehen.

create table sprachprotokolle (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  begonnen_am     timestamptz not null default now(),
  beendet_am      timestamptz,
  modell          text not null,
  zusammenfassung text
);

create index sprachprotokolle_user_idx on sprachprotokolle (user_id, begonnen_am desc);

comment on table sprachprotokolle is
  'Sitzungen des Echtzeit-Sprachmodus (/sprechen). Eine Zeile je Verbindung; beendet_am setzt der Client beim Trennen (sendBeacon) oder die Bulk-Buchung.';

create table sprachprotokoll_eintraege (
  id           uuid primary key default gen_random_uuid(),
  protokoll_id uuid not null references sprachprotokolle(id) on delete cascade,
  zeit         timestamptz not null default now(),
  rolle        text not null check (rolle in ('nutzer', 'assistent', 'werkzeug')),
  text         text not null,
  aktion       text,      -- Werkzeugname (nur rolle = 'werkzeug')
  ergebnis     jsonb      -- kompaktes Werkzeug-Ergebnis bzw. Fehler
);

create index sprachprotokoll_eintraege_idx on sprachprotokoll_eintraege (protokoll_id, zeit);

comment on table sprachprotokoll_eintraege is
  'Transkript (nutzer/assistent, vom Client gepuffert) und Werkzeug-Ausführungen (serverseitig geschrieben — die Nachvollziehbarkeit hängt nicht am Browser).';

-- Die Sammel-Transaktion: Schreib-Absichten aus dem Gespräch. Die Stimme
-- quittiert nur („Notiert"), gebucht wird erst nach Sichtprüfung im Bulk.
create table sprach_vorgaenge (
  id              uuid primary key default gen_random_uuid(),
  protokoll_id    uuid not null references sprachprotokolle(id) on delete cascade,
  seq             int not null,
  aktion          text not null,        -- Registry-Name (mit Punkt) oder KI-Katalog-Name
  parameter       jsonb not null,
  record_id       uuid,
  zusammenfassung text not null,        -- was die Stimme angesagt hat
  status          text not null default 'offen'
                  check (status in ('offen', 'gebucht', 'verworfen', 'fehler')),
  ergebnis_text   text,
  gebucht_am      timestamptz,
  unique (protokoll_id, seq)
);

create index sprach_vorgaenge_idx on sprach_vorgaenge (protokoll_id, seq);

comment on table sprach_vorgaenge is
  'Gesammelte Schreib-Absichten einer Sprachsitzung. Beim Sammeln bereits gegen Schema und Rechte geprüft (aktionPruefen/aktionErlaubt), ausgeführt aber erst nach Sichtprüfung über aktionAusfuehrenGeprueft — Zählungen dort als Kette erfassen → buchen.';
