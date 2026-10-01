'use server'
import { redirect } from 'next/navigation'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { type ActionResult, isActionInfo } from '@/modules/shared/action'

/**
 * Transport für Werkzeuge/Formen (0107) — geprüft und ausgeführt wird in
 * der Registry (registry/einkauf-werkzeuge.ts).
 */

export async function werkzeugAnlegen(formData: FormData): Promise<ActionResult> {
  const r = await serverAktion('einkauf.werkzeug_anlegen', { formData })
  if (isActionInfo(r) && r.link) redirect(r.link)
  return r
}

export async function werkzeugAendern(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.werkzeug_aendern', { recordId: id, formData })
}

export async function werkzeugStatusSetzen(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.werkzeug_status_setzen', { recordId: id, formData })
}

export async function werkzeugSchussBuchen(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.werkzeug_schuss_buchen', { recordId: id, formData })
}
