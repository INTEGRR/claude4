'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { sql } from '@/db/client'
import { requireWrite } from '@/modules/auth'
import { actionError, actionFail } from '@/modules/shared/action'

function text(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? '').trim()
  return value === '' ? null : value
}

// --- Mitarbeiterstamm ------------------------------------------------------

export async function createEmployee(formData: FormData) {
  await requireWrite('personal')
  const name = text(formData, 'name')
  if (!name) return actionError('Bitte einen Namen angeben')

  let id: string
  try {
    const [row] = await sql<{ id: string }[]>`
      insert into employees (
        number, name, barcode, job_title, department, employment_type,
        hourly_cost, weekly_hours, vacation_days, hire_date, email, phone)
      values (
        next_sequence('employee'), ${name}, ${text(formData, 'barcode')},
        ${text(formData, 'job_title')}, ${text(formData, 'department')},
        ${String(formData.get('employment_type') ?? 'full_time')}::employment_type,
        ${Number(formData.get('hourly_cost') ?? 0) || 0},
        ${Number(formData.get('weekly_hours') ?? 40) || 0},
        ${Number(formData.get('vacation_days') ?? 30) || 0},
        ${text(formData, 'hire_date')}, ${text(formData, 'email')}, ${text(formData, 'phone')})
      returning id`
    id = row.id
  } catch (err) {
    return actionFail(err)
  }
  redirect(`/personal/${id}`)
}

export async function updateEmployee(employeeId: string, formData: FormData) {
  await requireWrite('personal')
  const name = text(formData, 'name')
  if (!name) return actionError('Bitte einen Namen angeben')

  try {
    await sql`
      update employees set
        name = ${name},
        barcode = ${text(formData, 'barcode')},
        user_id = ${text(formData, 'user_id')},
        job_title = ${text(formData, 'job_title')},
        department = ${text(formData, 'department')},
        employment_type = ${String(formData.get('employment_type') ?? 'full_time')}::employment_type,
        hourly_cost = ${Number(formData.get('hourly_cost') ?? 0) || 0},
        weekly_hours = ${Number(formData.get('weekly_hours') ?? 0) || 0},
        vacation_days = ${Number(formData.get('vacation_days') ?? 0) || 0},
        hire_date = ${text(formData, 'hire_date')},
        exit_date = ${text(formData, 'exit_date')},
        email = ${text(formData, 'email')},
        phone = ${text(formData, 'phone')},
        note = ${text(formData, 'note')},
        active = ${formData.get('active') === 'on'}
      where id = ${employeeId}`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath(`/personal/${employeeId}`)
  revalidatePath('/personal')
}

// --- Stempeluhr ------------------------------------------------------------

/** Kommen/Gehen per Knopf. */
export async function clockToggle(employeeId: string) {
  const user = await requireWrite('zeiterfassung')
  try {
    await sql`select * from time_clock_toggle(${employeeId}, ${user.name})`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/zeiterfassung')
  revalidatePath('/personal')
}

/** Kommen/Gehen per Ausweis-Barcode — der Normalfall am Terminal. */
export async function clockByBarcode(formData: FormData) {
  const user = await requireWrite('zeiterfassung')
  const code = String(formData.get('barcode') ?? '').trim()
  if (!code) return actionError('Bitte einen Ausweis scannen')

  const [employee] = await sql<{ id: string; name: string }[]>`
    select id, name from employees where barcode = ${code} and active`
  if (!employee) return actionError(`Kein aktiver Mitarbeiter mit dem Ausweis „${code}"`)

  try {
    await sql`select * from time_clock_toggle(${employee.id}, ${user.name})`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/zeiterfassung')
}

/** Laufende Buchung beenden, optional mit Pausenzeit. */
export async function stopEntry(entryId: string, formData: FormData) {
  const user = await requireWrite('zeiterfassung')
  const raw = String(formData.get('break_minutes') ?? '').trim()
  const pause = raw === '' ? null : Number(raw)
  if (pause !== null && (!Number.isFinite(pause) || pause < 0)) {
    return actionError('Bitte eine gültige Pausenzeit in Minuten erfassen')
  }
  try {
    await sql`select time_entry_stop(${entryId}, ${pause}, ${user.name})`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/zeiterfassung')
  revalidatePath('/personal')
}

/** Nachtrag für vergessene Buchungen (nur Büro). */
export async function addTimeEntry(formData: FormData) {
  await requireWrite('personal')
  const employeeId = text(formData, 'employee_id')
  const von = text(formData, 'started_at')
  const bis = text(formData, 'ended_at')
  if (!employeeId) return actionError('Bitte einen Mitarbeiter auswählen')
  if (!von || !bis) return actionError('Bitte Beginn und Ende angeben')

  const pause = Number(formData.get('break_minutes') ?? 0) || 0
  try {
    await sql`
      insert into time_entries (employee_id, kind, started_at, ended_at, break_minutes,
                                minutes, hourly_cost, note)
      select ${employeeId}, 'attendance', ${von}::timestamptz, ${bis}::timestamptz, ${pause},
             greatest(extract(epoch from (${bis}::timestamptz - ${von}::timestamptz)) / 60.0 - ${pause}, 0),
             e.hourly_cost, ${text(formData, 'note')}
      from employees e where e.id = ${employeeId}`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath(`/personal/${employeeId}`)
  revalidatePath('/zeiterfassung')
}

export async function deleteTimeEntry(employeeId: string, entryId: string) {
  await requireWrite('personal')
  await sql`delete from time_entries where id = ${entryId} and mo_operation_id is null`
  revalidatePath(`/personal/${employeeId}`)
  revalidatePath('/zeiterfassung')
}

// --- Schichtplan -----------------------------------------------------------

export async function createShift(formData: FormData) {
  await requireWrite('personal')
  const employeeId = text(formData, 'employee_id')
  const templateId = text(formData, 'template_id')
  const day = text(formData, 'day')
  if (!employeeId) return actionError('Bitte einen Mitarbeiter auswählen')
  if (!templateId) return actionError('Bitte eine Schicht auswählen')
  if (!day) return actionError('Bitte einen Tag auswählen')

  try {
    await sql`
      insert into shift_assignments (
        employee_id, template_id, work_center_id, starts_at, ends_at, state, note)
      select ${employeeId}, t.id, ${text(formData, 'work_center_id')},
             (${day}::date + t.start_time) at time zone 'Europe/Berlin',
             (${day}::date + t.end_time
              + case when t.end_time <= t.start_time then interval '1 day'
                     else interval '0' end) at time zone 'Europe/Berlin',
             'published', ${text(formData, 'note')}
      from shift_templates t where t.id = ${templateId}`
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/exclusion constraint|conflicting key value/i.test(message)) {
      return actionError('Für diesen Mitarbeiter ist im Zeitraum bereits eine Schicht geplant')
    }
    return actionFail(err)
  }
  revalidatePath('/personal/schichtplan')
}

export async function deleteShift(shiftId: string) {
  await requireWrite('personal')
  await sql`delete from shift_assignments where id = ${shiftId}`
  revalidatePath('/personal/schichtplan')
}

// --- Abwesenheiten ---------------------------------------------------------

export async function requestAbsence(formData: FormData) {
  await requireWrite('personal')
  const employeeId = text(formData, 'employee_id')
  const von = text(formData, 'starts_on')
  const bis = text(formData, 'ends_on')
  if (!employeeId) return actionError('Bitte einen Mitarbeiter auswählen')
  if (!von || !bis) return actionError('Bitte den Zeitraum angeben')

  const halbtags = formData.get('half_day') === 'on'
  try {
    await sql`
      insert into absences (employee_id, kind, starts_on, ends_on, half_day, reason)
      values (${employeeId}, ${String(formData.get('kind') ?? 'vacation')}::absence_kind,
              ${von}::date, ${halbtags ? von : bis}::date, ${halbtags},
              ${text(formData, 'reason')})`
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/exclusion constraint|conflicting key value/i.test(message)) {
      return actionError('Für diesen Zeitraum liegt bereits ein Antrag vor')
    }
    return actionFail(err)
  }
  revalidatePath('/personal/abwesenheiten')
  revalidatePath(`/personal/${employeeId}`)
}

export async function decideAbsence(absenceId: string, state: 'approved' | 'rejected' | 'cancel') {
  const user = await requireWrite('personal')
  try {
    await sql`select absence_decide(${absenceId}, ${state}::absence_state, null,
                                    ${user.id}, ${user.name})`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/personal/abwesenheiten')
  revalidatePath('/personal')
}
