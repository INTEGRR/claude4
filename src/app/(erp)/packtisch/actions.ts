'use server'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import type { ActionResult } from '@/modules/shared/action'

/**
 * Dreizeiler um serverAktion(): geprüft und ausgeführt wird in der Registry
 * (versand.packtisch_abschliessen) — hier lebt nur der Transport.
 */

/** Fehlendes Artikelgewicht beim Packen setzen (versand.artikelgewicht_setzen). */
export async function artikelgewichtSetzen(formData: FormData): Promise<ActionResult> {
  return serverAktion('versand.artikelgewicht_setzen', { formData })
}

export async function packtischFertig(
  pickingId: string,
  formData: FormData,
): Promise<ActionResult> {
  return serverAktion('versand.packtisch_abschliessen', { recordId: pickingId, formData })
}

/** Vor dem Label: Adresse bei DHL prüfen, ohne Label (versand.adresse_pruefen). */
export async function adressePruefen(pickingId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('versand.adresse_pruefen', { recordId: pickingId, formData })
}
