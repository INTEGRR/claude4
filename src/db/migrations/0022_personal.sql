-- ===========================================================================
-- Personal: Mitarbeiter, Zeiterfassung, Schichtplan, Abwesenheiten
-- ===========================================================================
-- Vier Bausteine, die aufeinander aufbauen:
--
--   1. Mitarbeiter — Stammsatz mit Personalnummer, Ausweis-Barcode und
--      Personalkostensatz. Optional an ein Benutzerkonto gekoppelt.
--
--   2. Zeiterfassung — Kommen/Gehen an der Stempeluhr plus Auftragszeit auf
--      einen Arbeitsgang. Nur ein offener Eintrag je Mitarbeiter und Art;
--      gebuchte Auftragszeit fließt direkt in die Herstellkosten (0021).
--
--   3. Schichtplan — Vorlagen (Frühschicht 06:00-14:00) und Zuweisungen je
--      Mitarbeiter. Überschneidungen sind auf Datenbankebene ausgeschlossen,
--      genehmigte Abwesenheiten blockieren die Zuweisung.
--
--   4. Abwesenheiten — Urlaub, Krankheit, Schulung mit Genehmigung. Auch
--      hier verhindert die Datenbank Doppelbuchungen im selben Zeitraum.

-- Wird für die Überschneidungsprüfung gebraucht: erlaubt uuid-Gleichheit
-- innerhalb eines GiST-Ausschlusses.
create extension if not exists btree_gist;

insert into sequences (code, prefix, padding) values ('employee', 'MA', 4);


-- ---------------------------------------------------------------------------
-- 1. Mitarbeiter (hr.employee)
-- ---------------------------------------------------------------------------
create type employment_type as enum ('full_time', 'part_time', 'mini_job', 'temp', 'apprentice');

create table employees (
  id              uuid primary key default gen_random_uuid(),
  number          text unique not null,
  name            text not null,
  user_id         uuid references users on delete set null,
  barcode         text unique,                       -- Ausweis für die Stempeluhr
  job_title       text,
  department      text,
  employment_type employment_type not null default 'full_time',
  -- Personalkostensatz: was die Stunde das Unternehmen kostet (inkl. Nebenkosten)
  hourly_cost     numeric(16,4) not null default 0 check (hourly_cost >= 0),
  weekly_hours    numeric(6,2) not null default 40 check (weekly_hours >= 0),
  vacation_days   numeric(5,1) not null default 30 check (vacation_days >= 0),
  hire_date       date,
  exit_date       date,
  email           text,
  phone           text,
  note            text,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz,
  check (exit_date is null or hire_date is null or exit_date >= hire_date)
);
select attach_touch_trigger('employees');
create index employees_user_idx on employees (user_id);

comment on table employees is
  'Mitarbeiterstammsatz. hourly_cost ist der Personalkostensatz, der über die '
  'Zeiterfassung in die Herstellkosten eines Fertigungsauftrags einfließt.';


-- ---------------------------------------------------------------------------
-- 2. Zeiterfassung (hr.attendance + Auftragszeit)
-- ---------------------------------------------------------------------------
create type time_entry_kind as enum ('attendance', 'production');

create table time_entries (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references employees on delete cascade,
  kind            time_entry_kind not null default 'attendance',
  mo_operation_id uuid references mo_operations on delete set null,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  break_minutes   numeric(10,2) not null default 0 check (break_minutes >= 0),
  -- Nettodauer in Minuten, beim Abstempeln festgeschrieben
  minutes         numeric(10,2) not null default 0 check (minutes >= 0),
  -- Kostensatz zum Zeitpunkt der Buchung (spätere Tariferhöhung ändert nichts)
  hourly_cost     numeric(16,4) not null default 0,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz,
  check (ended_at is null or ended_at >= started_at)
);
select attach_touch_trigger('time_entries');
create index time_entries_employee_idx on time_entries (employee_id, started_at desc);
create index time_entries_operation_idx on time_entries (mo_operation_id) where mo_operation_id is not null;

-- Je Mitarbeiter und Art höchstens ein laufender Eintrag: sonst stempelt
-- jemand zweimal an und die Zeiten sind wertlos.
create unique index time_entries_open_idx
  on time_entries (employee_id, kind) where ended_at is null;

comment on table time_entries is
  'Zeiterfassung. kind=attendance ist Kommen/Gehen, kind=production ist Zeit '
  'auf einen Arbeitsgang eines Fertigungsauftrags.';

/** Startet eine Zeitbuchung. Liefert den Eintrag. */
create or replace function time_entry_start(
  p_employee uuid,
  p_kind time_entry_kind default 'attendance',
  p_operation uuid default null,
  p_actor text default 'system'
) returns uuid
language plpgsql as $$
declare
  e employees%rowtype;
  v_id uuid;
begin
  select * into e from employees where id = p_employee;
  if e.id is null then raise exception 'Mitarbeiter nicht gefunden'; end if;
  if not e.active then
    raise exception '% ist nicht mehr aktiv', e.name;
  end if;

  if exists (select 1 from time_entries
             where employee_id = p_employee and kind = p_kind and ended_at is null) then
    raise exception '% ist bereits angemeldet (%)', e.name,
      case when p_kind = 'attendance' then 'Anwesenheit' else 'Auftragszeit' end;
  end if;

  if p_kind = 'production' and p_operation is null then
    raise exception 'Für Auftragszeit muss ein Arbeitsgang angegeben werden';
  end if;

  insert into time_entries (employee_id, kind, mo_operation_id, hourly_cost)
  values (p_employee, p_kind, p_operation, e.hourly_cost)
  returning id into v_id;

  if p_operation is not null then
    perform log_event('manufacturing_order',
      (select mo_id from mo_operations where id = p_operation), 'state',
      format('%s hat die Zeiterfassung gestartet', e.name), p_actor);
  end if;
  return v_id;
end $$;

/*
 * Beendet eine Zeitbuchung und schreibt die Nettodauer fest. Auftragszeit
 * landet zusätzlich auf dem Arbeitsgang — von dort holt sie die
 * Kostenrollierung der Fertigmeldung ab.
 */
create or replace function time_entry_stop(
  p_entry uuid,
  p_break_minutes numeric default null,
  p_actor text default 'system'
) returns numeric
language plpgsql as $$
declare
  t time_entries%rowtype;
  v_gross numeric;
  v_net numeric;
  v_name text;
begin
  select * into t from time_entries where id = p_entry for update;
  if t.id is null then raise exception 'Zeitbuchung nicht gefunden'; end if;
  if t.ended_at is not null then raise exception 'Diese Zeitbuchung ist bereits beendet'; end if;

  v_gross := round(extract(epoch from (now() - t.started_at)) / 60.0, 2);
  v_net := greatest(v_gross - coalesce(p_break_minutes, t.break_minutes), 0);

  update time_entries
    set ended_at = now(),
        break_minutes = coalesce(p_break_minutes, break_minutes),
        minutes = v_net
  where id = p_entry;

  if t.mo_operation_id is not null then
    update mo_operations set duration_real = duration_real + v_net
    where id = t.mo_operation_id;
  end if;

  select name into v_name from employees where id = t.employee_id;
  if t.kind = 'attendance' then
    perform log_event('employee', t.employee_id, 'state',
      format('%s hat gestempelt: %s Minuten', v_name, v_net), p_actor);
  else
    perform log_event('manufacturing_order',
      (select mo_id from mo_operations where id = t.mo_operation_id), 'state',
      format('%s hat %s Minuten gebucht', v_name, v_net), p_actor);
  end if;
  return v_net;
end $$;

/** Stempeluhr: meldet an oder ab — je nachdem, was gerade offen ist. */
create or replace function time_clock_toggle(
  p_employee uuid,
  p_actor text default 'system'
) returns table (action text, minutes numeric)
language plpgsql as $$
declare v_open uuid;
begin
  select id into v_open from time_entries
  where employee_id = p_employee and kind = 'attendance' and ended_at is null;

  if v_open is null then
    perform time_entry_start(p_employee, 'attendance', null, p_actor);
    action := 'in';
    minutes := 0;
  else
    minutes := time_entry_stop(v_open, null, p_actor);
    action := 'out';
  end if;
  return next;
end $$;

/** Erfasste Nettominuten eines Mitarbeiters im Zeitraum (Anwesenheit). */
create or replace function employee_minutes(
  p_employee uuid,
  p_from date,
  p_to date
) returns numeric
language sql stable as $$
  select coalesce(sum(minutes), 0)
  from time_entries
  where employee_id = p_employee and kind = 'attendance' and ended_at is not null
    and started_at >= p_from::timestamptz
    and started_at < (p_to + 1)::timestamptz;
$$;


-- ---------------------------------------------------------------------------
-- 3. Schichtplan (planning.slot)
-- ---------------------------------------------------------------------------
create table shift_templates (
  id            uuid primary key default gen_random_uuid(),
  code          text unique not null,
  name          text not null,
  start_time    time not null,
  end_time      time not null,
  break_minutes numeric(10,2) not null default 0 check (break_minutes >= 0),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz
);
select attach_touch_trigger('shift_templates');

insert into shift_templates (code, name, start_time, end_time, break_minutes) values
  ('FRUEH', 'Frühschicht', '06:00', '14:00', 30),
  ('SPAET', 'Spätschicht', '14:00', '22:00', 30),
  ('TAG',   'Tagschicht',  '08:00', '17:00', 60);

create type shift_state as enum ('draft', 'published', 'cancel');

create table shift_assignments (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references employees on delete cascade,
  template_id    uuid references shift_templates on delete set null,
  work_center_id uuid references work_centers on delete set null,
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  state          shift_state not null default 'draft',
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz,
  check (ends_at > starts_at),
  -- Kein Mitarbeiter steht zweimal gleichzeitig im Plan.
  exclude using gist (
    employee_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (state <> 'cancel')
);
select attach_touch_trigger('shift_assignments');
create index shift_assignments_zeit_idx on shift_assignments (starts_at);

comment on constraint shift_assignments_employee_id_tstzrange_excl on shift_assignments is
  'Verhindert überschneidende Schichten je Mitarbeiter (btree_gist).';


-- ---------------------------------------------------------------------------
-- 4. Abwesenheiten (hr.leave)
-- ---------------------------------------------------------------------------
create type absence_kind as enum ('vacation', 'sick', 'training', 'unpaid', 'other');
create type absence_state as enum ('requested', 'approved', 'rejected', 'cancel');

create table absences (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees on delete cascade,
  kind        absence_kind not null default 'vacation',
  starts_on   date not null,
  ends_on     date not null,
  half_day    boolean not null default false,
  state       absence_state not null default 'requested',
  reason      text,
  decided_by  uuid references users on delete set null,
  decided_at  timestamptz,
  decision_note text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz,
  check (ends_on >= starts_on),
  check (not half_day or starts_on = ends_on),
  -- Ein Zeitraum, ein Antrag: offene und genehmigte dürfen sich nicht überlappen.
  exclude using gist (
    employee_id with =,
    daterange(starts_on, ends_on, '[]') with &&
  ) where (state in ('requested', 'approved'))
);
select attach_touch_trigger('absences');
create index absences_zeit_idx on absences (starts_on);

comment on constraint absences_employee_id_daterange_excl on absences is
  'Verhindert überschneidende Urlaubs-/Krankmeldungen je Mitarbeiter.';

/** Arbeitstage einer Abwesenheit (Mo-Fr, halber Tag zählt 0,5). */
create or replace function absence_days(p_absence uuid) returns numeric
language sql stable as $$
  select case when a.half_day then 0.5 else (
    select count(*)::numeric
    from generate_series(a.starts_on, a.ends_on, interval '1 day') d
    where extract(isodow from d) < 6
  ) end
  from absences a where a.id = p_absence;
$$;

/*
 * Genehmigt einen Antrag. Erst hier wird geprüft, ob im Zeitraum schon
 * Schichten geplant sind — der Planer soll das sehen, bevor jemand fehlt.
 */
create or replace function absence_approve(
  p_absence uuid, p_user uuid default null, p_actor text default 'system')
returns void
language plpgsql as $$
declare
  a absences%rowtype;
  v_shifts int;
  v_name text;
begin
  select * into a from absences where id = p_absence for update;
  if a.id is null then raise exception 'Antrag nicht gefunden'; end if;
  if a.state <> 'requested' then
    raise exception 'Nur offene Anträge können genehmigt werden';
  end if;

  select count(*) into v_shifts from shift_assignments s
  where s.employee_id = a.employee_id and s.state <> 'cancel'
    and s.starts_at < (a.ends_on + 1)::timestamptz
    and s.ends_at > a.starts_on::timestamptz;

  update absences
    set state = 'approved', decided_by = p_user, decided_at = now()
  where id = p_absence;

  select name into v_name from employees where id = a.employee_id;
  perform log_event('employee', a.employee_id, 'state',
    format('Abwesenheit genehmigt: %s bis %s', a.starts_on, a.ends_on)
    || case when v_shifts > 0
            then format(' — Achtung: %s geplante Schicht(en) im Zeitraum', v_shifts)
            else '' end, p_actor);
end $$;

create or replace function absence_decide(
  p_absence uuid, p_state absence_state, p_note text default null,
  p_user uuid default null, p_actor text default 'system')
returns void
language plpgsql as $$
declare a absences%rowtype;
begin
  select * into a from absences where id = p_absence for update;
  if a.id is null then raise exception 'Antrag nicht gefunden'; end if;
  if p_state = 'approved' then
    perform absence_approve(p_absence, p_user, p_actor);
    return;
  end if;
  if p_state not in ('rejected', 'cancel') then
    raise exception 'Ungültige Entscheidung';
  end if;

  update absences
    set state = p_state, decision_note = p_note, decided_by = p_user, decided_at = now()
  where id = p_absence;

  perform log_event('employee', a.employee_id, 'state',
    case when p_state = 'rejected' then 'Abwesenheit abgelehnt' else 'Abwesenheit zurückgezogen' end
    || coalesce(': ' || p_note, ''), p_actor);
end $$;

/*
 * Eine Schicht darf nicht in eine genehmigte Abwesenheit fallen — sonst
 * steht am Montag jemand im Plan, der im Urlaub ist.
 */
create or replace function trg_shift_absence_check() returns trigger
language plpgsql as $$
declare v_kollision text;
begin
  if new.state = 'cancel' then return new; end if;

  select format('%s bis %s', a.starts_on, a.ends_on) into v_kollision
  from absences a
  where a.employee_id = new.employee_id and a.state = 'approved'
    and a.starts_on <= new.ends_at::date and a.ends_on >= new.starts_at::date
  limit 1;

  if v_kollision is not null then
    raise exception '% ist im Zeitraum abwesend (%)',
      (select name from employees where id = new.employee_id), v_kollision;
  end if;
  return new;
end $$;

create trigger shift_assignments_absence
  before insert or update of employee_id, starts_at, ends_at, state on shift_assignments
  for each row execute function trg_shift_absence_check();


-- ---------------------------------------------------------------------------
-- 5. Herstellkosten mit Personalkostensatz
-- ---------------------------------------------------------------------------
/*
 * Lohnkosten eines Arbeitsgangs. Minuten, die über die Zeiterfassung gebucht
 * wurden, zählen mit dem Personalkostensatz des Mitarbeiters; alles Übrige
 * (Vorgabezeit, Uhr am Arbeitsgang) mit dem Stundensatz des Arbeitsplatzes.
 *
 * Diese eine Funktion ist die Quelle für Auftrag, Arbeitsplatz und Anzeige —
 * damit steht in der Zeile dieselbe Zahl wie in der Kostenkarte.
 */
create or replace function mo_operation_cost(p_op uuid) returns numeric
language sql stable as $$
  select coalesce((select sum(round(t.minutes / 60.0 * t.hourly_cost, 4))
                   from time_entries t
                   where t.mo_operation_id = p_op and t.ended_at is not null), 0)
       + round(greatest(o.duration_real - coalesce(
           (select sum(t.minutes) from time_entries t
            where t.mo_operation_id = p_op and t.ended_at is not null), 0), 0)
         / 60.0 * o.cost_per_hour, 4)
  from mo_operations o where o.id = p_op;
$$;

/** Lohnkosten eines Fertigungsauftrags aus seinen erledigten Arbeitsgängen. */
create or replace function mo_labor_cost(p_mo uuid) returns numeric
language sql stable as $$
  select coalesce(sum(mo_operation_cost(o.id)), 0)
  from mo_operations o
  where o.mo_id = p_mo and o.state = 'done';
$$;

/*
 * Arbeitsgang beenden. Neu gegenüber 0021: wurde die Zeit bereits über die
 * Zeiterfassung gebucht, wird sie nicht noch einmal aus der Uhr gerechnet.
 */
create or replace function mo_operation_finish(
  p_op uuid,
  p_minutes numeric default null,
  p_actor text default 'system'
) returns numeric
language plpgsql as $$
declare
  op mo_operations%rowtype;
  v_minutes numeric;
begin
  select * into op from mo_operations where id = p_op for update;
  if op.id is null then raise exception 'Arbeitsgang nicht gefunden'; end if;
  if op.state = 'done' then raise exception 'Arbeitsgang % ist bereits erledigt', op.name; end if;
  if p_minutes is not null and p_minutes < 0 then
    raise exception 'Die Dauer darf nicht negativ sein';
  end if;

  -- Offene Auftragszeit erst abstempeln — sie erhöht duration_real.
  perform time_entry_stop(t.id, null, p_actor)
  from time_entries t where t.mo_operation_id = p_op and t.ended_at is null;
  select * into op from mo_operations where id = p_op;

  v_minutes := coalesce(
    p_minutes,
    -- schon über die Zeiterfassung gebucht: nichts mehr dazurechnen
    case when op.duration_real > 0 then 0 end,
    case when op.date_start is not null
         then round(extract(epoch from (now() - op.date_start)) / 60.0, 2) end,
    op.duration_expected);

  update mo_operations
    set duration_real = op.duration_real + v_minutes,
        state = 'done',
        date_start = coalesce(date_start, now() - make_interval(secs => v_minutes * 60)),
        date_done = now()
  where id = p_op;

  perform log_event('manufacturing_order', op.mo_id, 'state',
    format('Arbeitsgang "%s" erledigt (%s Min.)', op.name, op.duration_real + v_minutes),
    p_actor);
  return v_minutes;
end $$;


/*
 * Bei der Fertigmeldung offene Arbeitsgänge schließen. Neu gegenüber 0021:
 * eine noch laufende Auftragszeit wird zuerst abgestempelt, damit die
 * tatsächlich gearbeitete Zeit in die Herstellkosten eingeht — und niemand
 * am Feierabend eine offene Uhr stehen lässt.
 */
create or replace function mo_operations_finalize(
  p_mo uuid,
  p_factor numeric default 1,
  p_actor text default 'system'
) returns void
language plpgsql as $$
begin
  perform time_entry_stop(t.id, null, p_actor)
  from time_entries t
  join mo_operations o on o.id = t.mo_operation_id
  where o.mo_id = p_mo and t.ended_at is null;

  update mo_operations
    set duration_real = case
          when duration_real > 0 then duration_real
          else round(duration_expected * p_factor, 2) end,
        state = 'done',
        date_done = now()
  where mo_id = p_mo and state <> 'done' and state <> 'cancel';
end $$;


-- ---------------------------------------------------------------------------
-- 6. Sichten für Auswertung und Oberfläche
-- ---------------------------------------------------------------------------
/** Wer ist gerade angemeldet? */
create or replace view employees_present as
  select e.id as employee_id, e.number, e.name, e.department,
         t.id as entry_id, t.started_at,
         round(extract(epoch from (now() - t.started_at)) / 60.0, 0) as minutes_so_far
  from time_entries t
  join employees e on e.id = t.employee_id
  where t.kind = 'attendance' and t.ended_at is null;

/** Erfasste Zeit je Mitarbeiter und Tag — die Grundlage des Stundenzettels. */
create or replace view time_sheet as
  select t.employee_id, e.number, e.name,
         (t.started_at at time zone 'Europe/Berlin')::date as day,
         t.kind,
         sum(t.minutes) as minutes,
         sum(round(t.minutes / 60.0 * t.hourly_cost, 4)) as cost
  from time_entries t
  join employees e on e.id = t.employee_id
  where t.ended_at is not null
  group by t.employee_id, e.number, e.name,
           (t.started_at at time zone 'Europe/Berlin')::date, t.kind;

comment on view time_sheet is
  'Stundenzettel je Mitarbeiter und Tag, getrennt nach Anwesenheit und Auftragszeit.';
