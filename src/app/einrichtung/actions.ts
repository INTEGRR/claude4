'use server'

import type { ActionResult } from '@/modules/shared/action'
import { serverAktion } from '@/modules/prozesse/server-aktion'

/**
 * Server Actions des Einrichtungs-Assistenten — alle Dreizeiler über
 * serverAktion() (Torwächter, nurAdmin, Audit). Der Wizard orchestriert
 * nur vorhandene Registry-Aktionen; eigene Fachlogik gibt es hier nicht.
 */

export async function demodatenEinspielen(): Promise<ActionResult> {
  return serverAktion('einstellungen.demodaten_einspielen', { parameter: {} })
}

export async function firmaSpeichern(formData: FormData): Promise<ActionResult> {
  return serverAktion('einstellungen.firma_speichern', { formData })
}

export async function paketAktivieren(paketCode: string): Promise<ActionResult> {
  return serverAktion('einstellungen.paket_aktivieren', {
    parameter: { paket_code: paketCode },
  })
}

export async function nutzerAnlegen(formData: FormData): Promise<ActionResult> {
  return serverAktion('einstellungen.benutzer_anlegen', { formData })
}

export async function adminPasswort(userId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einstellungen.benutzer_passwort', { recordId: userId, formData })
}

export async function einrichtungAbschliessen(
  modus: 'demo' | 'gefuehrt',
): Promise<ActionResult> {
  return serverAktion('einstellungen.einrichtung_abschliessen', { parameter: { modus } })
}

export async function prozessAbnehmen(
  code: string,
  version: number,
  notiz?: string,
): Promise<ActionResult> {
  return serverAktion('einstellungen.prozess_abnahme', {
    parameter: { prozess_code: code, version, notiz },
  })
}

export async function versionSchalten(code: string, version: number): Promise<ActionResult> {
  return serverAktion('einstellungen.prozessversion_aktivieren', {
    parameter: { prozess_code: code, version },
  })
}
