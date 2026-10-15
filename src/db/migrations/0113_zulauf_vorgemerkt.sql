-- 0113: Zulauf-Sendungsverfolgung — Anmeldung von Hand als Standard
-- (Entscheidungslog 2026-10-15, „Kontingent schonen").
--
-- Das 17TRACK-Kontingent zählt angemeldete Sendungen (200 im Jahr). Eine
-- Sendungsnummer am Beleg wird deshalb nur noch VORGEMERKT; angemeldet wird
-- per „Verfolgen" — oder automatisch, wenn die Einstellung (settings key
-- 'track17', automatisch = true) es erlaubt und die Reserve nicht
-- angebrochen ist.

-- DESTRUKTIV: Check-Constraint wird nur um 'vorgemerkt' erweitert (Muster 0084/0092), keine Zeile wird ungültig.
alter table sendungsverfolgung drop constraint sendungsverfolgung_status_check;
alter table sendungsverfolgung
  add constraint sendungsverfolgung_status_check
  check (status in (
    'vorgemerkt', 'registriert', 'nicht_verfolgbar', 'nicht_gefunden', 'angekuendigt',
    'unterwegs', 'abholbereit', 'in_zustellung', 'zustellung_fehlgeschlagen',
    'zugestellt', 'problem', 'abgelaufen'));

comment on table sendungsverfolgung is
  'Zulauf-Sendungsverfolgung über 17TRACK (0112/0113): eine Zeile je Beleg (purchase_order.tracking_number bzw. '
  'eingangs_sendung.hbl_awb) und Sendungsnummer — vorgemerkt (nicht angemeldet, kostet nichts) oder angemeldet: Status, '
  'letztes Ereignis, Anmeldung, zuletzt abgefragt (wann/wie), aktiv';
