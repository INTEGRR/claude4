'use server'
import { redirect } from 'next/navigation'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { type ActionResult, isActionError, isActionInfo } from '@/modules/shared/action'

/** Retouren (0119): dünne Server-Action-Hüllen um die Registry. */

export async function retoureAnlegen(auftragId: string, formData: FormData): Promise<ActionResult> {
  const ergebnis = await serverAktion('versand.retoure_anlegen', { recordId: auftragId, formData })
  if (isActionError(ergebnis)) return ergebnis
  if (isActionInfo(ergebnis) && ergebnis.link) redirect(ergebnis.link)
}

export async function retourePruefen(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('versand.retoure_pruefen', { recordId: id, formData })
}

export async function retoureLabelSenden(id: string): Promise<ActionResult> {
  return serverAktion('versand.retoure_label_senden', { recordId: id, parameter: {} })
}
