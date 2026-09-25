-- ============================================================================
-- 0085  Dienste-Wächter: Zustand der externen Dienste
-- ----------------------------------------------------------------------------
-- Der Cron `wache` (alle fünf Minuten) prüft jeden konfigurierten Dienst
-- aktiv (DHL-Token, Shopify-Abfrage, Resend, Anthropic, OpenAI, Telegram,
-- Druckbrücken-Heartbeat) und hält hier den Zustand. Störung erst beim
-- zweiten Fehlschlag in Folge (kein Flattern), Entstörung beim ersten Erfolg
-- — beides als Telegram-Meldung über die Outbox (0084). Header-Status und
-- Ereignis-Monitor projizieren diese Tabelle. Entscheidungslog 2026-09-25.
--
-- Betriebsdatum, keine Konfiguration: darf bei „Betriebsdaten löschen" fallen.
-- ============================================================================

create table dienst_status (
  dienst       text primary key,
  status       text not null default 'unbekannt'
               check (status in ('ok', 'gestoert', 'unbekannt')),
  fehler       text,
  -- seit wann gilt der aktuelle Zustand (ok seit … / gestört seit …)
  seit         timestamptz,
  geprueft_at  timestamptz,
  -- Fehlschläge in Folge; ab zwei gilt der Dienst als gestört
  fehlversuche int not null default 0,
  dauer_ms     int
);
comment on table dienst_status is
  'Dienste-Wächter: Zustand je externem Dienst (ok/gestoert/unbekannt), gepflegt vom Cron wache';
