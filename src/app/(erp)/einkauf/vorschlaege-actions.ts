'use server'
import { revalidatePath } from 'next/cache'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import type { ActionResult } from '@/modules/shared/action'

/**
 * Transport für die Vorschläge des Einkaufs-Agenten (0109) — geprüft und
 * ausgeführt wird in der Registry (registry/einkauf-ki.ts). Die Karte hängt
 * an Thread, Projekt, Bestellung und Lieferant; die Seite nennt ihren Pfad.
 */

export async function vorschlagAnnehmen(id: string, pfad: string): Promise<ActionResult> {
  const r = await serverAktion('einkauf.vorschlag_annehmen', { recordId: id })
  revalidatePath(pfad)
  return r
}

export async function vorschlagVerwerfen(id: string, pfad: string, formData?: FormData): Promise<ActionResult> {
  // Ohne Formular (Knopf auf der Karte) ohne Grund.
  const r = await serverAktion('einkauf.vorschlag_verwerfen', formData ? { recordId: id, formData } : { recordId: id, parameter: {} })
  revalidatePath(pfad)
  return r
}

export async function vorschlagAendern(id: string, pfad: string, formData: FormData): Promise<ActionResult> {
  const r = await serverAktion('einkauf.vorschlag_aendern', { recordId: id, formData })
  revalidatePath(pfad)
  return r
}
