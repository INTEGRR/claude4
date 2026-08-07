'use server'
import { revalidatePath } from 'next/cache'
import { sql } from '@/db/client'
import { requireWrite } from '@/modules/auth'
import { actionFail } from '@/modules/shared/action'

/**
 * Kennzahlen neu berechnen. Der Cron macht das nachts (task=analytics);
 * dieser Knopf ist für den Fall, dass jemand die Zahlen sofort braucht.
 */
export async function refreshAnalytics() {
  await requireWrite('auswertungen')
  try {
    await sql`select refresh_analytics('manuell')`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/auswertungen/kennzahlen')
  revalidatePath('/auswertungen')
}
