'use server'
import { revalidatePath } from 'next/cache'
import { sql } from '@/db/client'
import { requireUser } from '@/modules/auth'
import {
  backupCodesErneuern as codesErneuern,
  codePruefenUndMerken,
  geraetWiderrufen as widerrufen,
} from '@/modules/auth/zweifaktor'
import { type ActionResult, actionError, actionFail, actionInfo } from '@/modules/shared/action'

/**
 * Rahmen-Aktionen des eigenen Kontos (wie login:signIn / layout:signOut):
 * Sitzung und Identität, keine Fachaktion an einem Beleg — deshalb nicht in
 * der Registry, aber mit eigenem Audit-Eintrag am Benutzer. Geschlossene
 * Liste in tests/prozess-registry.test.ts (RAHMEN_AKTIONEN).
 */

export async function backupCodesErneuern(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  const code = String(formData.get('code') ?? '')
  try {
    if (!user.totpAktiv) return actionError('Der zweite Faktor ist noch nicht eingerichtet.')
    // Der aktuelle App-Code bestätigt, dass wirklich der Inhaber neue Codes zieht.
    if (!(await codePruefenUndMerken(sql, user.id, code))) {
      return actionError('Der Code aus der App ist falsch oder schon verbraucht.')
    }
    const codes = await codesErneuern(sql, user.id)
    await sql`select log_event('user', ${user.id}, 'state',
      ${`Backup-Codes neu erzeugt (${codes.length}) — die alten gelten nicht mehr`}, ${user.name})`
    revalidatePath('/konto')
    return actionInfo(
      `Neue Backup-Codes — jetzt sichern, sie erscheinen nie wieder: ${codes.join('  ')}`,
    )
  } catch (err) {
    return actionFail(err)
  }
}

export async function geraetWiderrufen(geraetId: string): Promise<ActionResult> {
  const user = await requireUser()
  try {
    if (!(await widerrufen(sql, user.id, geraetId))) return actionError('Gerät nicht gefunden.')
    await sql`select log_event('user', ${user.id}, 'state', 'Vertrautes Gerät entfernt', ${user.name})`
    revalidatePath('/konto')
    return actionInfo('Gerät entfernt — die nächste Anmeldung dort verlangt wieder den Code.')
  } catch (err) {
    return actionFail(err)
  }
}
