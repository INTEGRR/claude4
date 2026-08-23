'use server'
import { redirect } from 'next/navigation'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { type ActionResult, isActionError, isActionInfo } from '@/modules/shared/action'

export async function vorgangStarten(formData: FormData): Promise<ActionResult> {
  const ergebnis = await serverAktion('vorgang.anlegen', { formData })
  if (isActionError(ergebnis)) return ergebnis
  if (isActionInfo(ergebnis) && ergebnis.link) redirect(ergebnis.link)
}

export async function vorgangKopfAendern(
  recordId: string,
  formData: FormData,
): Promise<ActionResult> {
  return serverAktion('vorgang.kopf_aendern', { recordId, formData })
}
