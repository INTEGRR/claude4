'use server'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import type { ActionResult } from '@/modules/shared/action'

export async function schrittSchalten(
  prozessCode: string,
  schrittCode: string,
  aktiv: boolean,
): Promise<ActionResult> {
  return serverAktion('einstellungen.prozessschritt_schalten', {
    parameter: { prozess_code: prozessCode, schritt_code: schrittCode, aktiv },
  })
}
