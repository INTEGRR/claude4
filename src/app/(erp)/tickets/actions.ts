'use server'
import { revalidatePath } from 'next/cache'
import { sql } from '@/db/client'
import { currentUser, requireWrite } from '@/modules/auth'
import { actionError, actionFail, actionInfo } from '@/modules/shared/action'

/**
 * Ticket aus dem Slide-out-Overlay (oder von der Ticketseite) anlegen.
 * Kein Redirect: das Overlay bleibt offen und zeigt Nummer + Link — wer
 * mitten in der Arbeit meldet, will danach weiterarbeiten, nicht springen.
 */
export async function ticketMelden(formData: FormData) {
  await requireWrite('fehler')
  const user = await currentUser()
  const titel = String(formData.get('titel') ?? '').trim()
  const beschreibung = String(formData.get('beschreibung') ?? '').trim()
  const seite = String(formData.get('seite') ?? '').trim()
  const schwere = String(formData.get('schwere') ?? 'stoerend')
  if (!titel) return actionError('Bitte kurz benennen, was schiefgeht.')

  try {
    const [row] = await sql<{ id: string; number: string }[]>`
      insert into bug_reports (number, titel, beschreibung, seite, schwere, gemeldet_von)
      values (next_sequence('bug'), ${titel}, ${beschreibung || null}, ${seite || null},
              ${schwere}::bug_schwere, ${user?.name ?? 'unbekannt'})
      returning id, number`
    revalidatePath('/tickets')
    return actionInfo(`Ticket ${row.number} angelegt — danke!`, `/tickets/${row.id}`)
  } catch (err) {
    return actionFail(err)
  }
}

export async function statusSetzen(id: string, status: string, formData: FormData) {
  await requireWrite('fehler')
  const user = await currentUser()
  const aufloesung = String(formData.get('aufloesung') ?? '').trim()
  const commit = String(formData.get('commit_sha') ?? '').trim()
  try {
    await sql`
      update bug_reports set
        status = ${status}::bug_status,
        aufloesung = coalesce(${aufloesung || null}, aufloesung),
        commit_sha = coalesce(${commit || null}, commit_sha),
        behoben_am = case when ${status} in ('behoben', 'verworfen') then now() else null end
      where id = ${id}`
    await sql`select log_event('bug_report', ${id}::uuid, 'state',
      ${`Status: ${status}${aufloesung ? ` — ${aufloesung.slice(0, 300)}` : ''}${commit ? ` (Commit ${commit.slice(0, 12)})` : ''}`},
      ${user?.name ?? 'system'})`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/tickets')
  revalidatePath(`/tickets/${id}`)
}
