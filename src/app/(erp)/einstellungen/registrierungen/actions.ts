'use server'
import type { ActionResult } from '@/modules/shared/action'
import { serverAktion } from '@/modules/prozesse/server-aktion'

/**
 * Dreizeiler um serverAktion(): der Eingang einer Registrierung läuft ohne
 * Sitzung (/api/registrierung), alles danach wieder über den Torwächter.
 */

export async function standSetzen(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einstellungen.registrierung_status', { recordId: id, formData })
}
