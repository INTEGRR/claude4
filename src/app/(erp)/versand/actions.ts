'use server'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import type { ActionResult } from '@/modules/shared/action'

/**
 * Dreizeiler um serverAktion(): geprüft, berechtigt und ausgeführt wird in
 * der Aktions-Registry (prozesse/registry/versand.ts) — hier lebt nur noch
 * der Server-Action-Transport samt revalidatePath.
 */

export async function createLabel(pickingId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('versand.label_erstellen', { recordId: pickingId, formData })
}

export async function massLabels(formData: FormData): Promise<ActionResult> {
  return serverAktion('versand.massendruck', { formData })
}

export async function cancelLabel(shipmentId: string): Promise<ActionResult> {
  return serverAktion('versand.label_stornieren', { recordId: shipmentId })
}

export async function refreshTracking(): Promise<ActionResult> {
  return serverAktion('versand.tracking_aktualisieren', {})
}

export async function createReturnLabel(formData: FormData): Promise<ActionResult> {
  return serverAktion('versand.retourenlabel_erstellen', { formData })
}
