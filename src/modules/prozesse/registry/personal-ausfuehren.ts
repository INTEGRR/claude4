import { sql } from '@/db/client'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung der Personal-Aktionen — Fachlogik unverändert aus personal/actions.ts. */

export async function mitarbeiterAnlegen(p: {
  name: string
  barcode?: string
  job_title?: string
  department?: string
  employment_type: string
  hourly_cost: number
  weekly_hours: number
  vacation_days: number
  hire_date?: string
  email?: string
  phone?: string
}): Promise<AktionsErgebnis> {
  const [row] = await sql<{ id: string }[]>`
    insert into employees (
      number, name, barcode, job_title, department, employment_type,
      hourly_cost, weekly_hours, vacation_days, hire_date, email, phone)
    values (
      next_sequence('employee'), ${p.name}, ${p.barcode ?? null},
      ${p.job_title ?? null}, ${p.department ?? null},
      ${p.employment_type}::employment_type,
      ${p.hourly_cost}, ${p.weekly_hours}, ${p.vacation_days},
      ${p.hire_date ?? null}, ${p.email ?? null}, ${p.phone ?? null})
    returning id`
  return { text: `${p.name} angelegt.`, link: `/personal/${row.id}`, recordId: row.id }
}

export async function mitarbeiterAendern(
  p: {
    name: string
    barcode?: string
    user_id?: string
    job_title?: string
    department?: string
    employment_type: string
    hourly_cost: number
    weekly_hours: number
    vacation_days: number
    hire_date?: string
    exit_date?: string
    email?: string
    phone?: string
    note?: string
    active: boolean
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    update employees set
      name = ${p.name},
      barcode = ${p.barcode ?? null},
      user_id = ${p.user_id ?? null},
      job_title = ${p.job_title ?? null},
      department = ${p.department ?? null},
      employment_type = ${p.employment_type}::employment_type,
      hourly_cost = ${p.hourly_cost},
      weekly_hours = ${p.weekly_hours},
      vacation_days = ${p.vacation_days},
      hire_date = ${p.hire_date ?? null},
      exit_date = ${p.exit_date ?? null},
      email = ${p.email ?? null},
      phone = ${p.phone ?? null},
      note = ${p.note ?? null},
      active = ${p.active}
    where id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}

// --- Stempeluhr ------------------------------------------------------------

export async function stempeln(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select * from time_clock_toggle(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function stempelnBarcode(
  p: { barcode: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [employee] = await sql<{ id: string; name: string }[]>`
    select id, name from employees where barcode = ${p.barcode} and active`
  if (!employee) throw new Error(`Kein aktiver Mitarbeiter mit dem Ausweis „${p.barcode}"`)
  await sql`select * from time_clock_toggle(${employee.id}, ${ctx.actor})`
  return { text: `${employee.name} gestempelt.`, recordId: employee.id }
}

export async function buchungBeenden(
  p: { break_minutes?: number },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`select time_entry_stop(${ctx.recordId!}, ${p.break_minutes ?? null}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function zeitNachtragen(p: {
  employee_id: string
  started_at: string
  ended_at: string
  break_minutes: number
  note?: string
}): Promise<AktionsErgebnis> {
  await sql`
    insert into time_entries (employee_id, kind, started_at, ended_at, break_minutes,
                              minutes, hourly_cost, note)
    select ${p.employee_id}, 'attendance', ${p.started_at}::timestamptz, ${p.ended_at}::timestamptz,
           ${p.break_minutes},
           greatest(extract(epoch from (${p.ended_at}::timestamptz - ${p.started_at}::timestamptz)) / 60.0
                    - ${p.break_minutes}, 0),
           e.hourly_cost, ${p.note ?? null}
    from employees e where e.id = ${p.employee_id}`
  return { recordId: p.employee_id }
}

export async function zeitLoeschen(
  p: { entry_id: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  // Produktionszeiten hängen am Arbeitsgang und bleiben unantastbar.
  await sql`delete from time_entries where id = ${p.entry_id} and mo_operation_id is null`
  return { recordId: ctx.recordId }
}

// --- Schichtplan -----------------------------------------------------------

export async function schichtPlanen(p: {
  employee_id: string
  template_id: string
  day: string
  work_center_id?: string
  note?: string
}): Promise<AktionsErgebnis> {
  try {
    await sql`
      insert into shift_assignments (
        employee_id, template_id, work_center_id, starts_at, ends_at, state, note)
      select ${p.employee_id}, t.id, ${p.work_center_id ?? null},
             (${p.day}::date + t.start_time) at time zone 'Europe/Berlin',
             (${p.day}::date + t.end_time
              + case when t.end_time <= t.start_time then interval '1 day'
                     else interval '0' end) at time zone 'Europe/Berlin',
             'published', ${p.note ?? null}
      from shift_templates t where t.id = ${p.template_id}`
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/exclusion constraint|conflicting key value/i.test(message)) {
      throw new Error('Für diesen Mitarbeiter ist im Zeitraum bereits eine Schicht geplant')
    }
    throw err
  }
  return {}
}

export async function schichtLoeschen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`delete from shift_assignments where id = ${ctx.recordId!}`
  return {}
}

// --- Abwesenheiten ---------------------------------------------------------

export async function abwesenheitBeantragen(p: {
  employee_id: string
  kind: string
  starts_on: string
  ends_on: string
  half_day: boolean
  reason?: string
}): Promise<AktionsErgebnis> {
  try {
    await sql`
      insert into absences (employee_id, kind, starts_on, ends_on, half_day, reason)
      values (${p.employee_id}, ${p.kind}::absence_kind,
              ${p.starts_on}::date, ${p.half_day ? p.starts_on : p.ends_on}::date,
              ${p.half_day}, ${p.reason ?? null})`
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/exclusion constraint|conflicting key value/i.test(message)) {
      throw new Error('Für diesen Zeitraum liegt bereits ein Antrag vor')
    }
    throw err
  }
  return { recordId: p.employee_id }
}

export async function abwesenheitEntscheiden(
  p: { state: 'approved' | 'rejected' | 'cancel' },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`select absence_decide(${ctx.recordId!}, ${p.state}::absence_state, null,
                                  ${ctx.userId ?? null}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}
