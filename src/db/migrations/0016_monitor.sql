-- ===========================================================================
-- Ereignis-Monitor: API-Transaktionslog + Härtung von Queue und Webhooks
-- ===========================================================================

-- --- Transaktionslog -------------------------------------------------------
-- Jede Interaktion mit Shopify, DHL und dem Mailversand wird hier
-- festgehalten (Request/Response gekürzt, nie Zugangsdaten). Geschrieben
-- wird fire-and-forget aus src/modules/integrationen/transaktionen.ts —
-- ein Fehler beim Protokollieren darf nie den Geschäftsablauf brechen.
create table api_transactions (
  id          uuid primary key default gen_random_uuid(),
  system      text not null check (system in ('shopify', 'dhl', 'mail')),
  kind        text not null,           -- z. B. 'graphql:fulfillmentCreate', 'label_create'
  reference   text,                    -- Belegnummer o. Ä. für die Suche
  request     jsonb,
  response    jsonb,
  ok          boolean not null,
  status_code int,
  error       text,
  duration_ms int,
  job_id      uuid references integration_jobs on delete set null,
  created_at  timestamptz not null default now()
);
create index api_transactions_system_idx on api_transactions (system, created_at desc);
create index api_transactions_fehler_idx on api_transactions (created_at desc) where not ok;

-- --- Queue-Härtung ---------------------------------------------------------
-- last_error war doppelt belegt (Fehler UND Erfolgsmeldung) — getrennt.
-- started_at erlaubt es, hängengebliebene 'running'-Jobs zu erkennen.
alter table integration_jobs add column last_result text;
alter table integration_jobs add column started_at timestamptz;

-- Holt Jobs zurück, deren Lauf abgebrochen ist (Prozess-/Timeout-Abbruch
-- mitten im Handler). Wird von runDueJobs zu Beginn aufgerufen.
create or replace function reap_stuck_jobs(p_max_minutes int default 10) returns int
language plpgsql as $$
declare
  v_count int;
begin
  update integration_jobs
  set status = 'pending',
      last_error = 'Lauf abgebrochen (Prozess beendet?) — erneut eingeplant',
      next_run_at = now()
  where status = 'running'
    and started_at < now() - make_interval(mins => p_max_minutes);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- --- Aufräumen (täglicher Housekeeping-Lauf) -------------------------------
-- Transaktionen nach 30 Tagen; erledigte Jobs und verarbeitete Webhook-
-- Events (samt Payload — größter Wachstumstreiber) nach 60 Tagen. Events
-- mit offenen, nicht zugeordneten Positionen bleiben stehen, sonst risse
-- das Löschen die offene Zuordnung mit (FK-Cascade).
create or replace function prune_monitor_data() returns jsonb
language plpgsql as $$
declare
  v_tx int; v_jobs int; v_webhooks int;
begin
  delete from api_transactions where created_at < now() - interval '30 days';
  get diagnostics v_tx = row_count;

  delete from integration_jobs
  where status = 'done' and created_at < now() - interval '60 days';
  get diagnostics v_jobs = row_count;

  delete from shopify_webhook_events e
  where e.status in ('done', 'skipped')
    and e.received_at < now() - interval '60 days'
    and not exists (select 1 from shopify_unmatched_lines u
                    where u.event_id = e.id and u.resolved_at is null);
  get diagnostics v_webhooks = row_count;

  return jsonb_build_object(
    'transaktionen', v_tx, 'jobs', v_jobs, 'webhooks', v_webhooks);
end $$;

-- --- Webhook-Backoff -------------------------------------------------------
-- Bisher wurde ein fehlgeschlagener Webhook im Minutentakt sofort erneut
-- versucht; jetzt gilt dieselbe Staffel wie in der Job-Queue.
alter table shopify_webhook_events
  add column next_attempt_at timestamptz not null default now();
create index shopify_webhook_events_due_idx
  on shopify_webhook_events (status, next_attempt_at);
