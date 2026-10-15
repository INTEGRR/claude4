-- 0112: Sendungsverfolgung im Zulauf über 17TRACK (Entscheidungslog 2026-10-15)
--
-- Bislang wurden Carrier, Sendungsnummer und Link an Bestellung und
-- Eingangssendung nur GESPEICHERT — abgefragt hat sie niemand. Jetzt meldet
-- KRNL jede Zulauf-Sendung bei 17TRACK an (ein Dienst für alle Carrier),
-- bekommt Statuswechsel per Webhook und fragt stündlich nach. Eine Zeile je
-- (Beleg, Sendungsnummer); „zuletzt abgefragt" steht sichtbar an der Zeile.

create table sendungsverfolgung (
  id                     uuid primary key default gen_random_uuid(),
  -- Beleg, an dem die Sendung hängt: Bestellung (tracking_number) oder
  -- Eingangssendung (hbl_awb).
  modell                 text not null check (modell in ('purchase_order', 'eingangs_sendung')),
  record_id              uuid not null,
  nummer                 text not null,
  -- 17TRACK-Carrier-Code (apicarrier.all.json); null = automatisch erkennen.
  carrier_code           int,
  -- Anzeigename: unser Carrier-Text, nach der Anmeldung der erkannte Carrier.
  carrier                text,
  status                 text not null default 'registriert' check (status in (
                           'registriert', 'nicht_verfolgbar', 'nicht_gefunden', 'angekuendigt',
                           'unterwegs', 'abholbereit', 'in_zustellung', 'zustellung_fehlgeschlagen',
                           'zugestellt', 'problem', 'abgelaufen')),
  -- Rohwerte des Dienstes (z. B. InTransit / InTransit_CustomsProcessing).
  status_quelle          text,
  sub_status             text,
  -- {zeit, text, ort} des jüngsten Ereignisses; ereignisse = die letzten 50.
  letztes_ereignis       jsonb,
  ereignisse             jsonb not null default '[]'::jsonb,
  registriert_am         timestamptz,
  registrierung_fehler   text,
  zuletzt_abgefragt_am   timestamptz,
  zuletzt_abgefragt_via  text check (zuletzt_abgefragt_via in ('registrierung', 'abruf', 'webhook', 'manuell')),
  -- wann sich Status oder Ereignis zuletzt geändert haben (laut Dienst)
  zuletzt_geaendert_am   timestamptz,
  zugestellt_am          timestamptz,
  -- false: zugestellt, abgelaufen, nicht verfolgbar oder Nummer am Beleg
  -- ersetzt — wird nicht mehr abgefragt.
  aktiv                  boolean not null default true,
  erstellt_von           text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz,
  unique (modell, record_id, nummer)
);
select attach_touch_trigger('sendungsverfolgung');
create index sendungsverfolgung_abruf_idx on sendungsverfolgung (aktiv, zuletzt_abgefragt_am);
create index sendungsverfolgung_nummer_idx on sendungsverfolgung (nummer);
create index sendungsverfolgung_beleg_idx on sendungsverfolgung (modell, record_id);

comment on table sendungsverfolgung is
  'Zulauf-Sendungsverfolgung über 17TRACK (0112): eine Zeile je Beleg (purchase_order.tracking_number bzw. '
  'eingangs_sendung.hbl_awb) und Sendungsnummer — Status, letztes Ereignis, Anmeldung, zuletzt abgefragt (wann/wie), aktiv';

-- DESTRUKTIV: Constraint wird nur um 'track17' erweitert (Muster 0084/0092), keine Zeile wird ungültig.
alter table api_transactions drop constraint api_transactions_system_check;
alter table api_transactions
  add constraint api_transactions_system_check
  check (system in ('shopify', 'dhl', 'mail', 'telegram', 'google', 'ezb', 'track17'));
