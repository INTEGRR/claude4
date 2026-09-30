'use server'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import type { ActionResult } from '@/modules/shared/action'
import { revalidatePath } from 'next/cache'

/**
 * Transport für den Posteingang (0093) — geprüft und ausgeführt wird in der
 * Registry (registry/einkauf-postfach.ts). Wiedervorlagen hängen an
 * verschiedenen Belegen; die aufrufende Seite nennt ihren Pfad.
 */

export async function mailZuordnen(threadId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.mail_zuordnen', { recordId: threadId, formData })
}

export async function mailStatusSetzen(threadId: string, status: 'offen' | 'erledigt' | 'ignoriert'): Promise<ActionResult> {
  return serverAktion('einkauf.mail_status_setzen', { recordId: threadId, parameter: { status } })
}

export async function nachrichtErfassen(formData: FormData): Promise<ActionResult> {
  const r = await serverAktion('einkauf.nachricht_erfassen', { formData })
  const threadId = String(formData.get('thread_id') ?? '')
  if (threadId) revalidatePath(`/einkauf/posteingang/${threadId}`)
  return r
}

export async function wiedervorlageAnlegen(pfad: string, formData: FormData): Promise<ActionResult> {
  const r = await serverAktion('einkauf.wiedervorlage_anlegen', { formData })
  revalidatePath(pfad)
  return r
}

export async function wiedervorlageErledigen(id: string, pfad: string): Promise<ActionResult> {
  const r = await serverAktion('einkauf.wiedervorlage_erledigen', { parameter: { wiedervorlage_id: id } })
  revalidatePath(pfad)
  return r
}

export async function postfachAbgleichen(): Promise<ActionResult> {
  return serverAktion('integrationen.postfach_abgleichen', {})
}
