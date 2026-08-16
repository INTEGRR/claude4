'use server'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import type { ActionResult } from '@/modules/shared/action'

export async function refreshAnalytics(): Promise<ActionResult> {
  return serverAktion('auswertungen.kennzahlen_aktualisieren', {})
}
