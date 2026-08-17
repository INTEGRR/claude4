'use server'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import type { ActionResult } from '@/modules/shared/action'

/**
 * Dreizeiler um serverAktion(): geprüft (nur Admin), berechtigt und
 * ausgeführt wird in der Aktions-Registry (prozesse/registry/einstellungen.ts).
 */

export async function createUser(formData: FormData): Promise<ActionResult> {
  return serverAktion('einstellungen.benutzer_anlegen', { formData })
}

export async function setRole(userId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einstellungen.benutzer_rolle', { recordId: userId, formData })
}

export async function setActive(userId: string, active: boolean): Promise<ActionResult> {
  return serverAktion('einstellungen.benutzer_aktiv', { recordId: userId, parameter: { active } })
}

export async function resetPassword(userId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einstellungen.benutzer_passwort', { recordId: userId, formData })
}

export async function setBefugnisse(userId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einstellungen.benutzer_befugnisse', { recordId: userId, formData })
}
