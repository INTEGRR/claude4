'use server'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import type { ActionResult } from '@/modules/shared/action'

/**
 * Dreizeiler um serverAktion(): geprüft, berechtigt und ausgeführt wird in
 * der Aktions-Registry (prozesse/registry/kontakte.ts).
 */

export async function createPartner(formData: FormData): Promise<ActionResult> {
  return serverAktion('kontakte.partner_anlegen', { formData })
}

export async function updatePartner(partnerId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('kontakte.partner_aendern', { recordId: partnerId, formData })
}

export async function createChildContact(
  parentId: string,
  formData: FormData,
): Promise<ActionResult> {
  return serverAktion('kontakte.unterkontakt_anlegen', { recordId: parentId, formData })
}
