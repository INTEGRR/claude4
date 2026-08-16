'use server'
import { redirect } from 'next/navigation'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { type ActionResult, isActionError, isActionInfo } from '@/modules/shared/action'

/**
 * Dreizeiler um serverAktion(): geprüft, berechtigt und ausgeführt wird in
 * der Aktions-Registry (prozesse/registry/verkauf.ts) — hier lebt nur noch
 * der Server-Action-Transport samt revalidatePath und redirect.
 */

export async function confirmOrder(orderId: string): Promise<ActionResult> {
  return serverAktion('verkauf.bestaetigen', { recordId: orderId })
}

export async function cancelOrder(orderId: string): Promise<ActionResult> {
  return serverAktion('verkauf.stornieren', { recordId: orderId })
}

export async function updateOrderHeader(orderId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('verkauf.kopf_aendern', { recordId: orderId, formData })
}

export async function setLocked(orderId: string, locked: boolean): Promise<ActionResult> {
  return serverAktion('verkauf.sperren', { recordId: orderId, parameter: { locked } })
}

export async function resetToDraft(orderId: string): Promise<ActionResult> {
  return serverAktion('verkauf.zurueck_auf_angebot', { recordId: orderId })
}

export async function createOrder(formData: FormData): Promise<ActionResult> {
  const ergebnis = await serverAktion('verkauf.auftrag_anlegen', { formData })
  if (isActionError(ergebnis)) return ergebnis
  if (isActionInfo(ergebnis) && ergebnis.link) redirect(ergebnis.link)
}

export async function addLine(orderId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('verkauf.position_hinzufuegen', { recordId: orderId, formData })
}

export async function removeLine(orderId: string, lineId: string): Promise<ActionResult> {
  return serverAktion('verkauf.position_entfernen', {
    recordId: orderId,
    parameter: { line_id: lineId },
  })
}
