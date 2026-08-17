'use server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { type ActionResult, isActionError, isActionInfo } from '@/modules/shared/action'

/**
 * Dreizeiler um serverAktion(): geprüft, berechtigt und ausgeführt wird in
 * der Aktions-Registry (prozesse/registry/einkauf.ts) — hier lebt nur noch
 * der Server-Action-Transport samt revalidatePath und redirect.
 */

export async function createPurchaseOrder(formData: FormData): Promise<ActionResult> {
  const ergebnis = await serverAktion('einkauf.bestellung_anlegen', { formData })
  if (isActionError(ergebnis)) return ergebnis
  if (isActionInfo(ergebnis) && ergebnis.link) redirect(ergebnis.link)
}

export async function addPoLine(orderId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.position_hinzufuegen', { recordId: orderId, formData })
}

export async function updatePoHeader(orderId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.kopf_aendern', { recordId: orderId, formData })
}

export async function removePoLine(orderId: string, lineId: string): Promise<ActionResult> {
  return serverAktion('einkauf.position_entfernen', {
    recordId: orderId,
    parameter: { line_id: lineId },
  })
}

export async function approvePo(orderId: string): Promise<ActionResult> {
  return serverAktion('einkauf.bestellung_freigeben', { recordId: orderId })
}

export async function confirmPo(orderId: string): Promise<ActionResult> {
  return serverAktion('einkauf.bestaetigen', { recordId: orderId })
}

export async function cancelPo(orderId: string): Promise<ActionResult> {
  return serverAktion('einkauf.stornieren', { recordId: orderId })
}

export async function lockPo(orderId: string, locked: boolean): Promise<ActionResult> {
  return serverAktion('einkauf.sperren', { recordId: orderId, parameter: { locked } })
}

export async function sendPoEmail(orderId: string): Promise<ActionResult> {
  return serverAktion('einkauf.email_senden', { recordId: orderId })
}

// --- Rechnungen ------------------------------------------------------------

export async function createBill(orderId: string): Promise<ActionResult> {
  const ergebnis = await serverAktion('einkauf.rechnung_erstellen', { recordId: orderId })
  if (isActionError(ergebnis)) return ergebnis
  if (isActionInfo(ergebnis) && ergebnis.link) redirect(ergebnis.link)
}

export async function setBillDate(billId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.rechnung_details', { recordId: billId, formData })
}

export async function setBillChecked(billId: string, checked: boolean): Promise<ActionResult> {
  return serverAktion('einkauf.rechnung_pruefen', { recordId: billId, parameter: { checked } })
}

export async function postBill(billId: string): Promise<ActionResult> {
  return serverAktion('einkauf.rechnung_buchen', { recordId: billId })
}

export async function payBill(billId: string): Promise<ActionResult> {
  return serverAktion('einkauf.rechnung_zahlen', { recordId: billId })
}

export async function cancelBill(billId: string): Promise<ActionResult> {
  const ergebnis = await serverAktion('einkauf.rechnung_stornieren', { recordId: billId })
  if (isActionError(ergebnis)) return ergebnis
  // Gebuchte Rechnung → zur neuen Stornorechnung springen.
  if (isActionInfo(ergebnis) && ergebnis.link) redirect(ergebnis.link)
}

// --- Einstandsnebenkosten + Kurse ------------------------------------------

export async function createLandedCost(pickingId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.nebenkosten_erfassen', { recordId: pickingId, formData })
}

export async function postLandedCost(costId: string, pickingId: string): Promise<ActionResult> {
  const ergebnis = await serverAktion('einkauf.nebenkosten_buchen', { recordId: costId })
  // Der Beleg der Aktion ist der Kostensatz — die Wareneingangs-Seite
  // muss trotzdem frisch werden.
  revalidatePath(`/lager/${pickingId}`)
  return ergebnis
}

export async function cancelLandedCost(costId: string, pickingId: string): Promise<ActionResult> {
  const ergebnis = await serverAktion('einkauf.nebenkosten_stornieren', { recordId: costId })
  revalidatePath(`/lager/${pickingId}`)
  return ergebnis
}

export async function setExchangeRate(formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.wechselkurs_erfassen', { formData })
}
