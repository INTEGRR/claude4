'use server'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import type { ActionResult } from '@/modules/shared/action'

/**
 * Transport für die Aufgaben (0104) — geprüft und ausgeführt wird in der
 * Registry (registry/aufgaben.ts); neu geladen werden /aufgaben und die
 * Übersicht laut Registry.
 */

export async function aufgabeAnlegen(formData: FormData): Promise<ActionResult> {
  return serverAktion('aufgaben.anlegen', { formData })
}

export async function aufgabeErledigen(id: string): Promise<ActionResult> {
  return serverAktion('aufgaben.erledigen', { parameter: { aufgabe: id } })
}

export async function aufgabeVerwerfen(id: string): Promise<ActionResult> {
  return serverAktion('aufgaben.verwerfen', { parameter: { aufgabe_id: id } })
}
