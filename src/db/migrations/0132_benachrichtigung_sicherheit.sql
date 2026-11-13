-- 0132: Telegram-Meldung des täglichen Sicherheits-Checks (Entscheidungslog 2026-11-13)
--
-- „Bei Problemen muss das per Telegram an mich." Der Sicherheits-Check
-- (Job sicherheits_check, Cron sicherheit) meldet bekannte Lücken in
-- Abhängigkeiten, Konten ohne zweiten Faktor und auffällige Fehlversuche
-- über die Benachrichtigungs-Outbox (Art 'sicherheit', Schalter unter
-- Einstellungen → Benachrichtigungen).

-- DESTRUKTIV: Check-Constraint benachrichtigungen_art_check wird nur um 'sicherheit' erweitert — keine Zeile geht verloren.
alter table benachrichtigungen drop constraint benachrichtigungen_art_check;
alter table benachrichtigungen add constraint benachrichtigungen_art_check
  check (art in ('login', 'fehlversuch', 'sperre', 'job', 'dienst', 'test', 'einkauf', 'zulauf', 'sicherheit'));
