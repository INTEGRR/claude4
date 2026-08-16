import 'server-only'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/modules/auth'
import { type ActionResult, actionFail, actionInfo } from '@/modules/shared/action'
import { registrierteAktion } from './registry/index.ts'
import type { AktionsName } from './registry/index.ts'
import type { AktionsErgebnis } from './registry/typen.ts'
import { aktionAusfuehrenGeprueft } from './torwaechter.ts'

/**
 * Wrapper-Kern für Server Actions: aus einer bestehenden Action wird ein
 * Dreizeiler, der nur noch benennt, WELCHE Registry-Aktion er transportiert.
 *
 *   export async function cancelPicking(pickingId: string) {
 *     return serverAktion('lager.transfer_stornieren', { recordId: pickingId })
 *   }
 *
 * Zentral erledigt: Anmeldung, Torwächter (Schema + Rechte + Ausführung +
 * Audit), Fehler als Rückgabewert statt Wurf (heilt die 38 werfenden
 * Alt-Actions in einem Zug), revalidatePath aus den Registry-Metadaten.
 * redirect() bleibt Sache des jeweiligen Wrappers — Transport, nicht Fachlogik.
 */
export async function serverAktion(
  name: AktionsName,
  aufruf: { recordId?: string; formData?: FormData; parameter?: unknown } = {},
): Promise<ActionResult> {
  const user = await requireUser()

  let ergebnis: AktionsErgebnis
  try {
    ergebnis = await aktionAusfuehrenGeprueft(name, aufruf, user)
  } catch (err) {
    return actionFail(err)
  }

  const eintrag = registrierteAktion(name)
  for (const pfad of eintrag?.revalidate ?? []) {
    const aufgeloest = pfad
      .replace(':ergebnis', ergebnis.recordId ?? '')
      .replace(':id', aufruf.recordId ?? '')
    // Ein Platzhalter ohne Wert (z. B. ':ergebnis' bei Fehlbedienung) darf
    // nicht zu einem kaputten Pfad führen.
    if (!aufgeloest.endsWith('/')) revalidatePath(aufgeloest)
  }

  if (ergebnis.text) return actionInfo(ergebnis.text, ergebnis.link)
}
