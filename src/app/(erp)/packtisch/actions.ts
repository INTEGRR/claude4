'use server'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import type { ActionResult } from '@/modules/shared/action'

/**
 * Dreizeiler um serverAktion(): geprüft und ausgeführt wird in der Registry
 * (versand.packtisch_abschliessen) — hier lebt nur der Transport.
 */

export async function packtischFertig(
  pickingId: string,
  formData: FormData,
): Promise<ActionResult> {
  return serverAktion('versand.packtisch_abschliessen', { recordId: pickingId, formData })
}
