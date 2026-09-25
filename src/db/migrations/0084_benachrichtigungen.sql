-- ============================================================================
-- 0084  Benachrichtigungen: Outbox für den Telegram-Kanal
-- ----------------------------------------------------------------------------
-- Anmeldungen, Fehlversuche, endgültig fehlgeschlagene Jobs und (0085)
-- Dienststörungen gehen als Nachricht an den Telegram-Bot des Betreibers.
-- Nichts auf dem Login-Pfad wartet auf einen Drittanbieter: Ereignisse landen
-- hier mit NATÜRLICHEM Schlüssel (Bündelung, Entprellung), der Cron `jobs`
-- sendet sie jede Minute. Entscheidungslog 2026-09-25.
-- ============================================================================

-- --- 1. Transaktionslog kennt Telegram --------------------------------------
-- DESTRUKTIV: Check-Constraint api_transactions_system_check wird nur um 'telegram' erweitert — keine Zeile geht verloren.
alter table api_transactions drop constraint api_transactions_system_check;
alter table api_transactions
  add constraint api_transactions_system_check
  check (system in ('shopify', 'dhl', 'mail', 'telegram'));

-- --- 2. Outbox -------------------------------------------------------------
create table benachrichtigungen (
  id          uuid primary key default gen_random_uuid(),
  art         text not null check (art in ('login', 'fehlversuch', 'sperre', 'job', 'dienst', 'test')),
  -- Natürlicher Schlüssel: 'login:<sitzung>', 'fehlversuch:<konto>:<15-min-Bucket>',
  -- 'job:<id>:<versuch>', 'dienst:<name>:<zustand>:<seit>' — ein Ereignis, eine Zeile.
  schluessel  text not null unique,
  text        text not null,
  status      text not null default 'offen'
              check (status in ('offen', 'gesendet', 'fehlgeschlagen', 'uebersprungen')),
  versuche    int not null default 0,
  fehler      text,
  -- Frühester Sendezeitpunkt: Fehlversuche warten zwei Minuten, damit ein
  -- Schwall EINE Nachricht mit dem Endstand ergibt.
  nicht_vor   timestamptz not null default now(),
  erstellt_at timestamptz not null default now(),
  gesendet_at timestamptz
);
create index benachrichtigungen_offen_idx on benachrichtigungen (nicht_vor) where status = 'offen';
create index benachrichtigungen_erstellt_idx on benachrichtigungen (erstellt_at desc);
comment on table benachrichtigungen is
  'Outbox des Telegram-Kanals: Ereignis mit natürlichem Schlüssel, Text wird bis zum Versand aktualisiert';

-- Einreihen: gleicher Schlüssel und noch offen → Text und Frist erneuern
-- (Bündelung); schon gesendet → nichts (der Schlüssel blockiert sein Zeitfenster).
create or replace function benachrichtigung_einreihen(
  p_art text, p_schluessel text, p_text text, p_nicht_vor timestamptz default now()
) returns uuid language sql
set search_path = public, pg_temp as $$
  insert into benachrichtigungen (art, schluessel, text, nicht_vor)
  values (p_art, p_schluessel, p_text, p_nicht_vor)
  on conflict (schluessel) do update
    set text = excluded.text, nicht_vor = excluded.nicht_vor
    where benachrichtigungen.status = 'offen'
  returning id
$$;
