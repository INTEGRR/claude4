'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { sql } from '@/db/client'
import { currentUser, requireWrite } from '@/modules/auth'
import { actionError, actionFail } from '@/modules/shared/action'

export async function fehlerMelden(formData: FormData) {
  await requireWrite('fehler')
  const user = await currentUser()
  const titel = String(formData.get('titel') ?? '').trim()
  const beschreibung = String(formData.get('beschreibung') ?? '').trim()
  const seite = String(formData.get('seite') ?? '').trim()
  const schwere = String(formData.get('schwere') ?? 'stoerend')
  if (!titel) return actionError('Bitte kurz benennen, was schiefgeht.')

  let id: string
  try {
    const [row] = await sql<{ id: string }[]>`
      insert into bug_reports (number, titel, beschreibung, seite, schwere, gemeldet_von)
      values (next_sequence('bug'), ${titel}, ${beschreibung || null}, ${seite || null},
              ${schwere}::bug_schwere, ${user?.name ?? 'unbekannt'})
      returning id`
    id = row.id
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/fehler')
  redirect(`/fehler/${id}`)
}

export async function statusSetzen(id: string, status: string, formData: FormData) {
  await requireWrite('fehler')
  const user = await currentUser()
  const aufloesung = String(formData.get('aufloesung') ?? '').trim()
  try {
    await sql`
      update bug_reports set
        status = ${status}::bug_status,
        aufloesung = coalesce(${aufloesung || null}, aufloesung),
        behoben_am = case when ${status} in ('behoben', 'verworfen') then now() else null end
      where id = ${id}`
    await sql`select log_event('bug_report', ${id}::uuid, 'state',
      ${`Status: ${status}${aufloesung ? ` — ${aufloesung.slice(0, 300)}` : ''}`},
      ${user?.name ?? 'system'})`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/fehler')
  revalidatePath(`/fehler/${id}`)
}
