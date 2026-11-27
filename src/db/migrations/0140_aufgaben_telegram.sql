-- ===========================================================================
-- 0140  Telegram-Erinnerung für fällige Aufgaben der Verwaltung
-- ===========================================================================
-- Aufgaben (0104) standen bisher nur in der Übersicht und unter /aufgaben.
-- Wer am Fälligkeitstag nicht in KRNL schaut, verpasst sie. Neu: am
-- Fälligkeitstag geht je Aufgabe der Verwaltung (Rolle admin oder einem
-- Admin zugeteilt) eine Telegram-Nachricht — zur Uhrzeit der Aufgabe, ohne
-- Uhrzeit um 8 Uhr (Entscheidungslog 2026-11-27). Die Outbox kennt dafür
-- die neue Art „aufgabe"; der Schlüssel aufgabe:<id>:<Tag> hält es bei
-- einer Nachricht je Aufgabe und Termin.

-- DESTRUKTIV: Check-Constraint benachrichtigungen_art_check wird nur um 'aufgabe' erweitert — keine Zeile geht verloren.
alter table benachrichtigungen drop constraint benachrichtigungen_art_check;
alter table benachrichtigungen add constraint benachrichtigungen_art_check
  check (art in ('login', 'fehlversuch', 'sperre', 'job', 'dienst', 'test', 'einkauf', 'zulauf', 'sicherheit', 'ueberverkauf', 'aufgabe'));
