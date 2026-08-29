import { sql } from '@/db/client'
import { canAccess } from '@/modules/auth/permissions'
import { KOMMENTAR_MODELLE, type KommentarModell } from './notizen.ts'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung der Notiz-Aktion — Fachlogik unverändert aus comments-action.ts. */

export async function notizAnlegen(
  p: { model: KommentarModell; text: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const ziel = KOMMENTAR_MODELLE[p.model]

  // Kommentieren darf, wer den Bereich des Datensatzes SEHEN kann (auch die
  // Lese-Rollen) — deshalb die canAccess-Prüfung hier statt der
  // canWrite-Prüfung des Torwächters (der prüft den Bereich 'fehler',
  // den jede Rolle schreiben darf).
  if (!canAccess(ctx.role, ziel.bereich)) {
    throw new Error('Dafür fehlt Ihrer Rolle die Berechtigung')
  }

  const [exists] = await sql`select 1 from ${sql(ziel.tabelle)} where id = ${ctx.recordId!}`
  if (!exists) throw new Error('Der Datensatz existiert nicht (mehr)')

  await sql`select log_event(${p.model}, ${ctx.recordId!}, 'note', ${p.text}, ${ctx.actor})`
  return { text: 'Notiz hinterlegt.', recordId: ctx.recordId }
}
