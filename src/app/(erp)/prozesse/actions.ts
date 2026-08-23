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

export async function versionAktivieren(
  prozessCode: string,
  version: number,
): Promise<ActionResult> {
  return serverAktion('einstellungen.prozessversion_aktivieren', {
    parameter: { prozess_code: prozessCode, version },
  })
}

/** Feld-Editor auf /prozesse/[code] — das Formular liefert auch modell und prozess_code. */
export async function feldSpeichern(formData: FormData): Promise<ActionResult> {
  return serverAktion('einstellungen.feld_anlegen', { formData })
}

export async function feldLoeschen(
  modell: string,
  prozessCode: string,
  name: string,
): Promise<ActionResult> {
  return serverAktion('einstellungen.feld_loeschen', {
    parameter: { modell, prozess_code: prozessCode, name },
  })
}
