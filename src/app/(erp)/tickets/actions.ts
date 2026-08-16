'use server'
import { serverAktion } from '@/modules/prozesse/server-aktion'

/**
 * Dünne Transporte über die Aktions-Registry — Fachlogik, Prüfung und Rechte
 * liegen im Torwächter (src/modules/prozesse), die Ausführung in
 * registry/fehler-ausfuehren.ts. Kein Redirect: das Overlay bleibt offen und
 * zeigt Nummer + Link.
 */

export async function ticketMelden(formData: FormData) {
  return serverAktion('fehler.ticket_melden', { formData })
}

export async function statusSetzen(id: string, status: string, formData: FormData) {
  // Der gebundene Status wandert als Parameter mit — das Formular liefert
  // Vermerk und Commit, der Knopf bestimmt das Ziel.
  const parameter = {
    status,
    aufloesung: String(formData.get('aufloesung') ?? '').trim() || undefined,
    commit_sha: String(formData.get('commit_sha') ?? '').trim() || undefined,
  }
  return serverAktion('fehler.ticket_status', { recordId: id, parameter })
}
