-- 0114: Telegram-Meldung bei Zulauf-Status (Entscheidungslog 2026-10-15)
--
-- „Das Paket ist heute angekommen — warum keine Telegram-Nachricht?"
-- Die Zulauf-Sendungsverfolgung (0112) meldet Abholbereit, Zugestellt,
-- fehlgeschlagene Zustellung und Probleme jetzt über die Benachrichtigungs-
-- Outbox (Art 'zulauf', Schalter unter Einstellungen → Benachrichtigungen).

-- DESTRUKTIV: Check-Constraint benachrichtigungen_art_check wird nur um 'zulauf' erweitert — keine Zeile geht verloren.
alter table benachrichtigungen drop constraint benachrichtigungen_art_check;
alter table benachrichtigungen add constraint benachrichtigungen_art_check
  check (art in ('login', 'fehlversuch', 'sperre', 'job', 'dienst', 'test', 'einkauf', 'zulauf'));
