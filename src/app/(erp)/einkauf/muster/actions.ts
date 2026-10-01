'use server'
import { revalidatePath } from 'next/cache'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import type { ActionResult } from '@/modules/shared/action'

/**
 * Transport für die Bemusterung (0107) — geprüft und ausgeführt wird in der
 * Registry (registry/einkauf-bemusterung.ts). Angefordert wird meist von der
 * Projektseite; der Wrapper lädt Projekt und Lieferantenakte mit neu.
 */

export async function musterAnfordern(formData: FormData): Promise<ActionResult> {
  const r = await serverAktion('einkauf.muster_anfordern', { formData })
  const projekt = String(formData.get('projekt_id') ?? '')
  const partner = String(formData.get('partner_id') ?? '')
  if (projekt) revalidatePath(`/einkauf/projekte/${projekt}`)
  if (partner) revalidatePath(`/einkauf/lieferanten/${partner}`)
  return r
}

export async function musterErhalten(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.muster_erhalten', { recordId: id, formData })
}

export async function musterBewerten(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.muster_bewerten', { recordId: id, formData })
}

export async function musterAendern(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.muster_aendern', { recordId: id, formData })
}
