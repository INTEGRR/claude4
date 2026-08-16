'use server'
import { serverAktion } from '@/modules/prozesse/server-aktion'

/**
 * Dünne Transporte über die Aktions-Registry. Die Fachlogik (inklusive der
 * Warenausgangs-Kette Lose → Buchen → Kartonage → Shopify-Meldung) liegt in
 * src/modules/prozesse/registry/lager-ausfuehren.ts und ist damit auch über
 * /api/aktion und den Prozesstest erreichbar — der Knopf ist nur noch einer
 * von drei Wegen dorthin.
 */

export async function validatePicking(pickingId: string, formData: FormData) {
  return serverAktion('lager.transfer_buchen', { recordId: pickingId, formData })
}

export async function confirmPicking(pickingId: string) {
  return serverAktion('lager.transfer_bestaetigen', { recordId: pickingId })
}

export async function checkAvailability(pickingId: string) {
  return serverAktion('lager.verfuegbarkeit_pruefen', { recordId: pickingId })
}

export async function cancelPicking(pickingId: string) {
  return serverAktion('lager.transfer_stornieren', { recordId: pickingId })
}

export async function returnPicking(pickingId: string) {
  return serverAktion('lager.transfer_retoure', { recordId: pickingId })
}

export async function createCount(formData: FormData) {
  return serverAktion('lager.zaehlung_erfassen', { formData })
}

export async function applyCount(countId: string) {
  return serverAktion('lager.zaehlung_buchen', { recordId: countId })
}

export async function deleteCount(countId: string) {
  return serverAktion('lager.zaehlung_loeschen', { recordId: countId })
}

export async function scrapProduct(formData: FormData) {
  return serverAktion('lager.ausschuss_buchen', { formData })
}

export async function updatePickingDetails(pickingId: string, formData: FormData) {
  return serverAktion('lager.transfer_details', { recordId: pickingId, formData })
}

export async function createOrderpoint(formData: FormData) {
  return serverAktion('lager.meldebestand_anlegen', { formData })
}

export async function deleteOrderpoint(orderpointId: string) {
  return serverAktion('lager.meldebestand_loeschen', { recordId: orderpointId })
}

export async function snoozeOrderpoint(orderpointId: string, days: number) {
  return serverAktion('lager.meldebestand_schlummern', {
    recordId: orderpointId,
    parameter: { tage: days },
  })
}

export async function executeOrderpoint(orderpointId: string) {
  return serverAktion('lager.beschaffung_ausfuehren', { recordId: orderpointId })
}

export async function wakeOrderpoint(orderpointId: string) {
  return serverAktion('lager.meldebestand_wecken', { recordId: orderpointId })
}

export async function initializeValuation() {
  return serverAktion('lager.eroeffnungsbewertung')
}
