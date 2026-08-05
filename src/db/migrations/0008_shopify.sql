-- ===========================================================================
-- Shopify-Integration: Webhook-Eingang (idempotent) und SKU-Klärliste
-- ===========================================================================

create type webhook_status as enum ('pending', 'done', 'failed', 'skipped');

create table shopify_webhook_events (
  id               uuid primary key default gen_random_uuid(),
  webhook_id       text unique not null,   -- X-Shopify-Webhook-Id: Idempotenzschlüssel
  topic            text not null,
  shopify_order_id text,
  payload          jsonb not null,
  status           webhook_status not null default 'pending',
  attempts         int not null default 0,
  error            text,
  received_at      timestamptz not null default now(),
  processed_at     timestamptz
);
create index shopify_events_pending_idx on shopify_webhook_events (status, received_at);
create index shopify_events_order_idx on shopify_webhook_events (shopify_order_id);

create table shopify_sync_state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into shopify_sync_state (key, value)
values ('last_reconciliation_at', to_jsonb((now() - interval '1 day')::text));

-- Zeilen, deren SKU keinem Produkt zugeordnet werden konnte. Die Zuordnung
-- erfolgt manuell in der UI und wird dann dauerhaft an der Variante gespeichert.
create table shopify_unmatched_lines (
  id               uuid primary key default gen_random_uuid(),
  event_id         uuid references shopify_webhook_events on delete cascade,
  shopify_order_id text not null,
  order_name       text,
  sku              text,
  title            text,
  variant_gid      text,
  qty              numeric(16,4),
  resolved_at      timestamptz,
  resolved_variant uuid references product_variants on delete set null,
  created_at       timestamptz not null default now()
);
create index shopify_unmatched_open_idx on shopify_unmatched_lines (resolved_at) where resolved_at is null;
