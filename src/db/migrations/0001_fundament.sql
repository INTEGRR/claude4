-- ===========================================================================
-- Fundament: Hilfsfunktionen, Nummernkreise, Audit-Log, Outbox, Benutzer
-- ===========================================================================

create extension if not exists pgcrypto;

-- --- updated_at automatisch pflegen ----------------------------------------
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Hängt den updated_at-Trigger an eine Tabelle (spart Wiederholung je Tabelle).
create or replace function attach_touch_trigger(target regclass) returns void
language plpgsql as $$
declare
  tbl text := target::text;
begin
  execute format(
    'create trigger touch_updated_at before update on %s
       for each row execute function touch_updated_at()', tbl);
end $$;


-- --- Nummernkreise ---------------------------------------------------------
create table sequences (
  code        text primary key,
  prefix      text not null,
  padding     int  not null default 5,
  next_number int  not null default 1
);

comment on table sequences is
  'Belegnummernkreise. Vergabe ausschließlich über next_sequence() (row lock).';

-- Zieht die nächste Belegnummer. Der Row Lock serialisiert konkurrierende
-- Aufrufe, damit keine Nummer doppelt vergeben wird.
create or replace function next_sequence(p_code text) returns text
language plpgsql as $$
declare
  s sequences%rowtype;
begin
  select * into s from sequences where code = p_code for update;
  if not found then
    raise exception 'Unbekannter Nummernkreis: %', p_code;
  end if;

  update sequences set next_number = next_number + 1 where code = p_code;

  return s.prefix || lpad(s.next_number::text, s.padding, '0');
end $$;

insert into sequences (code, prefix, padding) values
  ('sale',      'S',         5),
  ('purchase',  'P',         5),
  ('receipt',   'WH/IN/',    5),
  ('delivery',  'WH/OUT/',   5),
  ('internal',  'WH/INT/',   5),
  ('repair_op', 'WH/REP/',   5),
  ('mo',        'MO/',       5),
  ('unbuild',   'UB/',       5),
  ('repair',    'RMA/',      5),
  ('bill',      'BILL/',     5);


-- --- Audit-Log (schlanker "Chatter": Statuswechsel + Notizen) ---------------
create table audit_log (
  id         bigserial primary key,
  model      text not null,          -- 'sales_order', 'purchase_order', …
  record_id  uuid not null,
  kind       text not null,          -- 'state', 'note', 'email', 'error'
  message    text not null,
  actor      text,                   -- Benutzername oder 'system'
  created_at timestamptz not null default now()
);
create index audit_log_record_idx on audit_log (model, record_id, created_at desc);

create or replace function log_event(
  p_model text, p_record uuid, p_kind text, p_message text, p_actor text default 'system'
) returns void
language sql as $$
  insert into audit_log (model, record_id, kind, message, actor)
  values (p_model, p_record, p_kind, p_message, coalesce(p_actor, 'system'));
$$;


-- --- Outbox für ausgehende Integrationen -----------------------------------
create type job_status as enum ('pending', 'running', 'done', 'failed');

create table integration_jobs (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,     -- 'shopify_fulfillment_create', 'send_po_email', …
  payload     jsonb not null default '{}'::jsonb,
  status      job_status not null default 'pending',
  attempts    int not null default 0,
  max_attempts int not null default 10,
  last_error  text,
  next_run_at timestamptz not null default now(),
  dedupe_key  text unique,       -- verhindert doppelte Jobs für denselben Vorgang
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);
create index integration_jobs_due_idx on integration_jobs (status, next_run_at);
select attach_touch_trigger('integration_jobs');

-- Reiht einen Job ein. Gleicher dedupe_key => kein zweiter Job.
create or replace function enqueue_job(
  p_kind text, p_payload jsonb, p_dedupe_key text default null
) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  insert into integration_jobs (kind, payload, dedupe_key)
  values (p_kind, coalesce(p_payload, '{}'::jsonb), p_dedupe_key)
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  return v_id;
end $$;


-- --- Benutzer & Sitzungen --------------------------------------------------
-- Bewusst eigenständig gehalten (kein externer Auth-Anbieter), damit das
-- System vollständig lokal lauffähig und testbar ist. Die Schnittstelle ist
-- auf src/modules/auth begrenzt und dort austauschbar.
create type user_role as enum ('admin', 'mitarbeiter');

create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  name          text not null,
  password_hash text not null,       -- scrypt: salt:hash (hex)
  role          user_role not null default 'mitarbeiter',
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz
);
select attach_touch_trigger('users');

create table sessions (
  token      text primary key,       -- sha256 des Cookie-Werts
  user_id    uuid not null references users on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index sessions_user_idx on sessions (user_id);


-- --- Anwendungseinstellungen (Key/Value) -----------------------------------
create table settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz
);
select attach_touch_trigger('settings');

insert into settings (key, value) values
  ('company', '{"name":"Meine Firma GmbH","street":"Musterstraße","house":"1","zip":"10115","city":"Berlin","country":"DEU","email":"info@example.com","phone":""}'::jsonb),
  ('shopify', '{"push_status_tag":false,"status_tag":"in-fertigung"}'::jsonb),
  ('dhl',     '{"default_product":"V01PAK","print_format":"910-300-700"}'::jsonb);
