'use server'
import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { sql } from '@/db/client'
import { cookieOptionen, requireUser } from '@/modules/auth'
import { ARBEITSPLATZ_COOKIE, ARBEITSPLATZ_TAGE } from '@/modules/druck/arbeitsplatz'
import { idOderNull } from '@/modules/druck/routing'
import { type ActionResult, actionError, actionInfo } from '@/modules/shared/action'

/**
 * Arbeitsplatz dieses PCs wählen — Rahmen-Aktion (Geräteeinstellung wie
 * „Gerät merken", keine Fachaktion; tests/prozess-registry.test.ts,
 * RAHMEN_AKTIONEN). Setzt nur das Cookie des Browsers und protokolliert den
 * Wechsel am Benutzer. Leer = Bindung aufheben.
 */
export async function arbeitsplatzWaehlen(id: string | null): Promise<ActionResult> {
  const user = await requireUser()
  const jar = await cookies()

  if (!id) {
    jar.delete(ARBEITSPLATZ_COOKIE)
    await sql`select log_event('user', ${user.id}::uuid, 'state',
      'Arbeitsplatz dieses Geräts aufgehoben', ${user.name})`
    revalidatePath('/', 'layout')
    return actionInfo('Dieser PC hat keinen Arbeitsplatz mehr — gedruckt wird auf den Ersatzdruckern.')
  }

  const gueltig = idOderNull(id)
  if (!gueltig) return actionError('Unbekannter Arbeitsplatz.')
  const [platz] = await sql<{ id: string; name: string }[]>`
    select id, name from work_centers where id = ${gueltig} and active`
  if (!platz) return actionError('Diesen Arbeitsplatz gibt es nicht (mehr) oder er ist abgeschaltet.')

  jar.set(ARBEITSPLATZ_COOKIE, platz.id, cookieOptionen(ARBEITSPLATZ_TAGE * 24 * 60 * 60))
  await sql`select log_event('user', ${user.id}::uuid, 'state',
    ${`Arbeitsplatz dieses Geräts: ${platz.name}`}, ${user.name})`
  revalidatePath('/', 'layout')
  return actionInfo(`Dieser PC gehört jetzt zu „${platz.name}" — gedruckt wird auf dessen Druckern.`)
}
