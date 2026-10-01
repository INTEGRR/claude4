'use server'
import { redirect } from 'next/navigation'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { type ActionResult, isActionInfo } from '@/modules/shared/action'

/**
 * Transport für Lieferantenverträge (0107) — geprüft und ausgeführt wird in
 * der Registry (registry/einkauf-vertraege.ts). Nicht die Fixkosten-Verträge
 * der Finanzen (finanzen/vertraege).
 */

export async function vertragAnlegen(formData: FormData): Promise<ActionResult> {
  const r = await serverAktion('einkauf.lieferantenvertrag_anlegen', { formData })
  if (isActionInfo(r) && r.link) redirect(r.link)
  return r
}

export async function vertragAendern(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.lieferantenvertrag_aendern', { recordId: id, formData })
}

export async function vertragStatusSetzen(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.lieferantenvertrag_status_setzen', { recordId: id, formData })
}

export async function preislisteUebernehmen(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.preisliste_uebernehmen', { recordId: id, formData })
}
