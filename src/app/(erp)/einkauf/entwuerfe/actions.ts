'use server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { type ActionResult, isActionError, isActionInfo } from '@/modules/shared/action'

/**
 * Transport für Mail-Entwürfe (0094) — geprüft und ausgeführt wird in der
 * Registry (registry/einkauf-mailversand.ts). Der Editor ist EIN Formular
 * mit mehreren Knöpfen: erst speichern, dann je nach Knopf übersetzen oder
 * freigeben — so geht keine Änderung verloren.
 */

export async function entwurfAnlegen(formData: FormData): Promise<ActionResult> {
  const r = await serverAktion('einkauf.mail_entwurf_anlegen', { formData })
  if (isActionInfo(r) && r.link) redirect(r.link)
  return r
}

export async function entwurfBearbeiten(id: string, formData: FormData): Promise<ActionResult> {
  const gespeichert = await serverAktion('einkauf.mail_entwurf_aendern', { recordId: id, formData })
  if (isActionError(gespeichert)) return gespeichert
  const aktion = String(formData.get('_aktion') ?? 'speichern')
  if (aktion === 'uebersetzen_ziel' || aktion === 'uebersetzen_de') {
    return serverAktion('einkauf.mail_uebersetzen', {
      recordId: id,
      parameter: { richtung: aktion === 'uebersetzen_ziel' ? 'nach_ziel' : 'nach_de' },
    })
  }
  if (aktion === 'senden') return serverAktion('einkauf.mail_freigeben', { recordId: id })
  return gespeichert
}

export async function entwurfVerwerfen(id: string): Promise<ActionResult> {
  return serverAktion('einkauf.mail_verwerfen', { recordId: id })
}

export async function nachrichtUebersetzen(nachrichtId: string, pfad: string): Promise<ActionResult> {
  const r = await serverAktion('einkauf.nachricht_uebersetzen', { parameter: { nachricht_id: nachrichtId } })
  revalidatePath(pfad)
  return r
}
