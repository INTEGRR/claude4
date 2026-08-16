'use server'
import { redirect } from 'next/navigation'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { isActionError, isActionInfo } from '@/modules/shared/action'

/**
 * Dünne Transporte über die Aktions-Registry (Fachlogik in
 * registry/reparatur-ausfuehren.ts). Die zwei Redirect-Fälle bleiben hier:
 * wohin der Browser nach dem Anlegen springt, ist Transportsache.
 */

export async function createRepair(formData: FormData) {
  const ergebnis = await serverAktion('reparatur.auftrag_anlegen', { formData })
  if (isActionError(ergebnis)) return ergebnis
  if (isActionInfo(ergebnis) && ergebnis.link) redirect(ergebnis.link)
}

export async function addPart(repairId: string, formData: FormData) {
  return serverAktion('reparatur.teil_hinzufuegen', { recordId: repairId, formData })
}

export async function removePart(repairId: string, partId: string) {
  return serverAktion('reparatur.teil_entfernen', {
    recordId: repairId,
    parameter: { part_id: partId },
  })
}

export async function confirmRepair(repairId: string) {
  return serverAktion('reparatur.bestaetigen', { recordId: repairId })
}

export async function startRepair(repairId: string) {
  return serverAktion('reparatur.beginnen', { recordId: repairId })
}

export async function endRepair(repairId: string, formData: FormData) {
  return serverAktion('reparatur.abschliessen', { recordId: repairId, formData })
}

export async function cancelRepair(repairId: string) {
  return serverAktion('reparatur.stornieren', { recordId: repairId })
}

export async function createQuotation(repairId: string) {
  const ergebnis = await serverAktion('reparatur.angebot_erstellen', { recordId: repairId })
  if (isActionError(ergebnis)) return ergebnis
  if (isActionInfo(ergebnis) && ergebnis.link) redirect(ergebnis.link)
}

export async function updateRepairDetails(repairId: string, formData: FormData) {
  return serverAktion('reparatur.details', { recordId: repairId, formData })
}
