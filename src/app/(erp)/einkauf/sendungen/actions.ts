'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { type ActionResult, isActionInfo } from '@/modules/shared/action'

/**
 * Transport für Eingangssendungen, Kosten, Zoll, Pflichtdokument-Nachfrage
 * und gelernte Einstandssätze (0108) — geprüft und ausgeführt wird in der
 * Registry (registry/einkauf-sendungen.ts).
 */

export async function sendungAnlegen(formData: FormData): Promise<ActionResult> {
  const r = await serverAktion('einkauf.sendung_anlegen', { formData })
  if (isActionInfo(r) && r.link) redirect(r.link)
  return r
}

export async function sendungAendern(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.sendung_aendern', { recordId: id, formData })
}

export async function sendungBestellungZuordnen(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.sendung_bestellung_zuordnen', { recordId: id, formData })
}

export async function sendungBestellungLoesen(id: string, purchaseOrderId: string): Promise<ActionResult> {
  const r = await serverAktion('einkauf.sendung_bestellung_loesen', { recordId: id, parameter: { purchase_order_id: purchaseOrderId } })
  revalidatePath(`/einkauf/${purchaseOrderId}`)
  return r
}

export async function sendungVerschiffen(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.sendung_verschiffen', { recordId: id, formData })
}

export async function sendungVerzollen(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.sendung_verzollen', { recordId: id, formData })
}

export async function sendungAnkommen(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.sendung_ankommen', { recordId: id, formData })
}

export async function sendungAbrechnen(id: string): Promise<ActionResult> {
  return serverAktion('einkauf.sendung_abrechnen', { recordId: id })
}

export async function sendungStornieren(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.sendung_stornieren', { recordId: id, formData })
}

export async function sendungKostenErfassen(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.sendung_kosten_erfassen', { recordId: id, formData })
}

export async function sendungKostenEntfernen(id: string, kostenId: string): Promise<ActionResult> {
  return serverAktion('einkauf.sendung_kosten_entfernen', { recordId: id, parameter: { kosten_id: kostenId } })
}

export async function sendungVerteilen(id: string): Promise<ActionResult> {
  return serverAktion('einkauf.sendung_verteilen', { recordId: id })
}

export async function sendungSchaetzen(id: string): Promise<ActionResult> {
  return serverAktion('einkauf.sendung_schaetzen', { recordId: id })
}

export async function sendungZollErfassen(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.sendung_zoll_erfassen', { recordId: id, formData })
}

/** Nachfrage fehlender Pflichtdokumente — führt zum neuen Entwurf. */
export async function pflichtdokumenteNachfragen(modell: 'purchase_order' | 'eingangs_sendung', recordId: string): Promise<ActionResult> {
  const r = await serverAktion('einkauf.pflichtdokumente_nachfragen', { parameter: { modell, record_id: recordId } })
  revalidatePath(modell === 'purchase_order' ? `/einkauf/${recordId}` : `/einkauf/sendungen/${recordId}`)
  return r
}

export async function einstandVorschlagUebernehmen(art: 'fracht' | 'zoll', schluessel: string): Promise<ActionResult> {
  return serverAktion('einkauf.einstand_vorschlag_uebernehmen', { parameter: { art, schluessel } })
}
