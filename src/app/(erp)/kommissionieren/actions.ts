'use server'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import type { ActionResult } from '@/modules/shared/action'

/**
 * Dreizeiler um serverAktion(): geprüft und ausgeführt wird in der Registry
 * (lager.kommissionierung_starten, lager.kommissionieren,
 * versand.packzettel_drucken) — hier lebt nur der Transport.
 */

export async function sammelnStarten(pickingId: string): Promise<ActionResult> {
  return serverAktion('lager.kommissionierung_starten', { recordId: pickingId })
}

export async function sammelnMelden(
  pickingId: string,
  werte: { gesammelt: Record<string, number>; unvollstaendig: boolean; vermerk?: string },
): Promise<ActionResult> {
  return serverAktion('lager.kommissionieren', { recordId: pickingId, parameter: werte })
}

export async function packzettelDrucken(ids: string[]): Promise<ActionResult> {
  return serverAktion('versand.packzettel_drucken', { parameter: { ids } })
}
