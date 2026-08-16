'use server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/modules/auth'
import { type Area, canWrite } from '@/modules/auth/permissions'
import { sql } from '@/db/client'
import { type ActionResult, actionFail } from '@/modules/shared/action'

/**
 * Rahmenaktionen der beleglosen Assistenten (/p): Starten und Abschließen.
 * Die eigentlichen Schritte laufen über /api/aktion (Torwächter) und
 * prozess_instanz_weiter — hier steht nur, was keinen Registry-Aufruf hat.
 */

export async function instanzStarten(code: string): Promise<ActionResult> {
  const user = await requireUser()
  const [prozess] = await sql<{ bereich: Area }[]>`
    select bereich from prozesse where code = ${code} and aktiv and modell is null`
  if (!prozess) return actionFail(new Error('Unbekannter Assistent'))
  if (!canWrite(user.role, prozess.bereich)) {
    return actionFail(new Error('Ihrer Rolle fehlt die Berechtigung für diesen Assistenten'))
  }
  const [neu] = await sql<{ id: string }[]>`
    select prozess_instanz_starten(${code}, ${user.name}) as id`
  redirect(`/p/${code}/${neu.id}`)
}

export async function instanzAbschliessen(
  instanzId: string,
  endeCode: string,
): Promise<ActionResult> {
  const user = await requireUser()
  const [instanz] = await sql<
    { id: string; code: string; bereich: Area; schritt_code: string; version_id: string }[]
  >`
    select i.id, p.code, p.bereich, i.schritt_code, i.version_id
    from prozess_instanzen i join prozesse p on p.id = i.prozess_id
    where i.id = ${instanzId} and i.status = 'laufend'`
  if (!instanz) return actionFail(new Error('Der Assistent läuft nicht mehr.'))
  if (!canWrite(user.role, instanz.bereich)) {
    return actionFail(new Error('Ihrer Rolle fehlt die Berechtigung'))
  }

  // Abschließen geht nur, wenn vom aktuellen Schritt eine Kante zum Ende führt.
  const [kante] = await sql<{ ok: boolean }[]>`
    select exists(
      select 1 from prozess_uebergaenge u
      join prozess_schritte z on z.version_id = u.version_id and z.code = u.nach_code
      where u.version_id = ${instanz.version_id}
        and u.von_code = ${instanz.schritt_code}
        and u.nach_code = ${endeCode} and z.art = 'ende'
    ) as ok`
  if (!kante.ok) return actionFail(new Error('Von hier führt kein Weg direkt zum Abschluss.'))

  await sql`select prozess_instanz_weiter(${instanzId}, ${endeCode}, '{}'::jsonb, ${user.name})`
  revalidatePath(`/p/${instanz.code}/${instanzId}`)
}
