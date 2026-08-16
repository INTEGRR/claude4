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

export async function prozessSchalten(
  prozessCode: string,
  aktiv: boolean,
): Promise<ActionResult> {
  return serverAktion('einstellungen.prozess_schalten', {
    parameter: { prozess_code: prozessCode, aktiv },
  })
}

export async function paketAktivieren(paketCode: string): Promise<ActionResult> {
  return serverAktion('einstellungen.paket_aktivieren', {
    parameter: { paket_code: paketCode },
  })
}
